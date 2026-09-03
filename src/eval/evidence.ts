import fs from "node:fs/promises";
import path from "node:path";

import type { RecordedTraceEvent } from "../runtime/trace.js";
import { parseRecordedTraceEvent } from "../runtime/traceSchema.js";
import type { EvalTraceSession } from "./scenario.js";
import type { EvalSuiteSummary } from "./types.js";

export interface CollectEvalTraceSessionsOptions {
  attemptRoot: string;
  emptyRootSessionId?: string;
  rootTracePath: string;
}

export async function assertEvalEvidenceRefsClosed(
  runRoot: string,
  summary: EvalSuiteSummary,
): Promise<string[]> {
  const resolvedRoot = path.resolve(runRoot);
  const rootStats = await fs.lstat(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("eval evidence run root must be a real directory");
  }
  if (await fs.realpath(resolvedRoot) !== resolvedRoot) {
    throw new Error("eval evidence run root cannot resolve through a symlink");
  }

  const references = new Set<string>();
  for (const attempt of summary.attempts) {
    if (attempt.evidenceRefs.length === 0) {
      throw new Error(`eval attempt ${attempt.attemptId} has no raw evidence references`);
    }
    for (const reference of attempt.evidenceRefs) {
      references.add(requireSafeEvalEvidenceRef(reference));
    }
    for (const assertion of attempt.assertions) {
      if (assertion.evidenceRefs.length === 0) {
        throw new Error(`eval assertion ${attempt.attemptId}/${assertion.id} has no raw evidence references`);
      }
      for (const reference of assertion.evidenceRefs) {
        references.add(requireSafeEvalEvidenceRef(reference));
      }
    }
  }

  const ordered = [...references].sort((left, right) => left.localeCompare(right));
  for (const reference of ordered) {
    const candidate = path.resolve(resolvedRoot, ...reference.split("/"));
    const relative = path.relative(resolvedRoot, candidate);
    if (!isContainedRelativePath(relative)) {
      throw new Error(`eval evidence reference ${reference} escaped the run root`);
    }
    let stats;
    try {
      stats = await fs.lstat(candidate);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`eval evidence reference ${reference} does not exist`, { cause: error });
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`eval evidence reference ${reference} cannot be a symlink`);
    }
    if (!stats.isFile()) {
      throw new Error(`eval evidence reference ${reference} must be a regular file`);
    }
    const realCandidate = await fs.realpath(candidate);
    if (realCandidate !== candidate || !isContainedRelativePath(path.relative(resolvedRoot, realCandidate))) {
      throw new Error(`eval evidence reference ${reference} cannot resolve through a symlink`);
    }
  }
  return ordered;
}

export async function readEvalTrace(tracePath: string): Promise<RecordedTraceEvent[]> {
  const source = await fs.readFile(tracePath, "utf8");
  const events: RecordedTraceEvent[] = [];
  let expectedSequence = 1;
  for (const [index, line] of source.split("\n").entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `malformed trace JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let event: RecordedTraceEvent;
    try {
      event = parseRecordedTraceEvent(value);
    } catch {
      throw new Error(`invalid trace event at line ${index + 1}`);
    }
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `invalid trace sequence at line ${index + 1}: expected sequence ${expectedSequence}, received ${event.sequence}`,
      );
    }
    expectedSequence += 1;
    events.push(event);
  }
  return events;
}

export async function collectEvalTraceSessions(
  options: CollectEvalTraceSessionsOptions,
): Promise<EvalTraceSession[]> {
  const attemptRoot = path.resolve(options.attemptRoot);
  const rootTrace = await resolveTraceInsideAttempt(attemptRoot, options.rootTracePath);
  const rootEvents = await readEvalTrace(rootTrace.resolved);
  const rootSessionId = rootEvents[0]?.sessionId ?? options.emptyRootSessionId;
  if (!rootSessionId) {
    throw new Error("root eval trace did not contain any events");
  }
  if (rootEvents.some((event) => event.sessionId !== rootSessionId)) {
    throw new Error(`root trace session id did not match expected session ${rootSessionId}`);
  }
  const sessions: EvalTraceSession[] = [{
    events: rootEvents,
    role: "root",
    sessionId: rootSessionId,
  }];
  const seenSessionIds = new Set([rootSessionId]);
  const seenTracePaths = new Set([rootTrace.resolved]);
  const seenRealTracePaths = new Set([rootTrace.real]);
  const teammates = new Map<string, { profile: "edit" | "research"; sessionId: string }>();

  for (const event of rootEvents) {
    if (
      event.type !== "child_session_started"
      && event.type !== "teammate_registered"
      && event.type !== "teammate_rejoined"
    ) {
      continue;
    }

    let profile: "edit" | "research";
    let expectedSessionId: string;
    if (event.type === "child_session_started") {
      expectedSessionId = event.childSessionId;
      profile = event.profile;
    } else if (event.type === "teammate_registered") {
      if (teammates.has(event.name)) {
        throw new Error(`teammate ${event.name} already has a current registration`);
      }
      expectedSessionId = event.subjectSessionId;
      profile = event.profile;
    } else {
      const current = teammates.get(event.name);
      if (!current) {
        throw new Error(`cannot rejoin unknown teammate ${event.name}`);
      }
      if (event.previousSessionId !== current.sessionId) {
        throw new Error(
          `teammate ${event.name} previous session ${event.previousSessionId} did not match current session ${current.sessionId}`,
        );
      }
      expectedSessionId = event.subjectSessionId;
      profile = current.profile;
    }

    if (seenSessionIds.has(expectedSessionId)) {
      throw new Error(`eval trace session id collision for registered session ${expectedSessionId}`);
    }
    const trace = await resolveTraceInsideAttempt(attemptRoot, event.tracePath);
    if (seenTracePaths.has(trace.resolved) || seenRealTracePaths.has(trace.real)) {
      throw new Error(`eval trace path collision for registered trace ${trace.resolved}`);
    }

    const events = await readEvalTrace(trace.resolved);
    if (events.length === 0) {
      throw new Error(`registered trace ${trace.resolved} did not contain any events`);
    }
    if (events.some((item) => item.sessionId !== expectedSessionId)) {
      throw new Error(`trace session id did not match registered session ${expectedSessionId}`);
    }
    sessions.push(event.type === "child_session_started"
      ? {
          events,
          profile,
          role: "child",
          sessionId: expectedSessionId,
        }
      : {
          events,
          name: event.name,
          profile,
          role: "teammate",
          sessionId: expectedSessionId,
        });
    seenSessionIds.add(expectedSessionId);
    seenTracePaths.add(trace.resolved);
    seenRealTracePaths.add(trace.real);
    if (event.type !== "child_session_started") {
      teammates.set(event.name, { profile, sessionId: expectedSessionId });
    }
  }
  return sessions;
}

async function resolveTraceInsideAttempt(
  attemptRoot: string,
  candidate: string,
): Promise<{ real: string; resolved: string }> {
  const resolved = path.resolve(candidate);
  const relative = path.relative(attemptRoot, resolved);
  if (!isContainedRelativePath(relative)) {
    throw new Error("eval trace path must stay inside the eval attempt");
  }
  const [realRoot, realCandidate] = await Promise.all([
    fs.realpath(attemptRoot),
    fs.realpath(resolved),
  ]);
  const realRelative = path.relative(realRoot, realCandidate);
  if (!isContainedRelativePath(realRelative)) {
    throw new Error("eval trace path must stay inside the eval attempt");
  }
  return { real: realCandidate, resolved };
}

function isContainedRelativePath(relative: string): boolean {
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function requireSafeEvalEvidenceRef(reference: string): string {
  if (!reference
    || reference.includes("\\")
    || path.posix.isAbsolute(reference)
    || path.win32.isAbsolute(reference)
    || reference.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`eval evidence reference ${JSON.stringify(reference)} must be a safe relative path`);
  }
  return reference;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
