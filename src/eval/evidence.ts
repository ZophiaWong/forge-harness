import fs from "node:fs/promises";
import path from "node:path";

import type { RecordedTraceEvent } from "../runtime/trace.js";
import { parseRecordedTraceEvent } from "../runtime/traceSchema.js";
import type { EvalTraceSession } from "./scenario.js";

export interface CollectEvalTraceSessionsOptions {
  attemptRoot: string;
  emptyRootSessionId?: string;
  rootTracePath: string;
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
