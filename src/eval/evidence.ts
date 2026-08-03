import fs from "node:fs/promises";
import path from "node:path";

import type { RecordedTraceEvent } from "../runtime/trace.js";
import type { EvalTraceSession } from "./scenario.js";

export interface CollectEvalTraceSessionsOptions {
  attemptRoot: string;
  emptyRootSessionId?: string;
  rootTracePath: string;
}

export async function readEvalTrace(tracePath: string): Promise<RecordedTraceEvent[]> {
  const source = await fs.readFile(tracePath, "utf8");
  const events: RecordedTraceEvent[] = [];
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
    if (!isRecordedTraceEvent(value)) {
      throw new Error(`invalid trace event at line ${index + 1}`);
    }
    events.push(value as RecordedTraceEvent);
  }
  return events;
}

export async function collectEvalTraceSessions(
  options: CollectEvalTraceSessionsOptions,
): Promise<EvalTraceSession[]> {
  const attemptRoot = path.resolve(options.attemptRoot);
  await assertPathInsideAttempt(attemptRoot, options.rootTracePath);
  const rootEvents = await readEvalTrace(options.rootTracePath);
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
  const seen = new Set([path.resolve(options.rootTracePath)]);

  for (const event of rootEvents) {
    if (event.type !== "child_session_started" && event.type !== "teammate_registered") {
      continue;
    }
    const tracePath = path.resolve(event.tracePath);
    if (seen.has(tracePath)) {
      continue;
    }
    await assertPathInsideAttempt(attemptRoot, tracePath);
    const events = await readEvalTrace(tracePath);
    const expectedSessionId = event.type === "child_session_started"
      ? event.childSessionId
      : events[0]?.sessionId;
    if (!expectedSessionId) {
      throw new Error(`registered teammate trace ${tracePath} did not contain any events`);
    }
    if (events.some((item) => item.sessionId !== expectedSessionId)) {
      throw new Error(`trace session id did not match registered session ${expectedSessionId}`);
    }
    sessions.push(event.type === "child_session_started"
      ? {
          events,
          profile: event.profile,
          role: "child",
          sessionId: expectedSessionId,
        }
      : {
          events,
          name: event.name,
          profile: event.profile,
          role: "teammate",
          sessionId: expectedSessionId,
        });
    seen.add(tracePath);
  }
  return sessions;
}

async function assertPathInsideAttempt(attemptRoot: string, candidate: string): Promise<void> {
  const resolved = path.resolve(candidate);
  const relative = path.relative(attemptRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("eval trace path must stay inside the eval attempt");
  }
  const [realRoot, realCandidate] = await Promise.all([
    fs.realpath(attemptRoot),
    fs.realpath(resolved),
  ]);
  const realRelative = path.relative(realRoot, realCandidate);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("eval trace path must stay inside the eval attempt");
  }
}

function isRecordedTraceEvent(value: unknown): boolean {
  return isRecord(value)
    && typeof value.type === "string"
    && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && typeof value.sequence === "number"
    && Number.isSafeInteger(value.sequence)
    && value.sequence > 0
    && typeof value.timestamp === "string"
    && !Number.isNaN(Date.parse(value.timestamp));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
