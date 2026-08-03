import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectEvalTraceSessions,
  readEvalTrace,
} from "../../src/eval/evidence.js";
import type { RecordedTraceEvent, TraceEventPayload } from "../../src/runtime/trace.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

function recorded(sequence: number, payload: TraceEventPayload, sessionId: string): RecordedTraceEvent {
  return {
    ...payload,
    sequence,
    sessionId,
    timestamp: "2026-08-03T00:00:00.000Z",
  };
}

async function writeTrace(pathname: string, events: RecordedTraceEvent[]): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

describe("eval trace evidence", () => {
  it("collects root, child, and teammate traces without exposing their absolute paths", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-evidence-"));
    tempRoots.push(attemptRoot);
    const rootPath = path.join(attemptRoot, "private", "root.jsonl");
    const childPath = path.join(attemptRoot, "private", "child.jsonl");
    const teammatePath = path.join(attemptRoot, "private", "teammate.jsonl");
    await writeTrace(childPath, [recorded(1, { answer: "child", round: 1, type: "final_answer" }, "child")]);
    await writeTrace(teammatePath, [recorded(1, { answer: "idle", round: 1, type: "final_answer" }, "mate")]);
    await writeTrace(rootPath, [
      recorded(1, {
        childSessionId: "child",
        parentCallId: "delegate",
        profile: "research",
        round: 1,
        runInBackground: true,
        task: "read child",
        tracePath: childPath,
        type: "child_session_started",
      }, "root"),
      recorded(2, {
        name: "researcher",
        profile: "research",
        sessionId: "mate",
        state: "starting",
        tracePath: teammatePath,
        type: "teammate_registered",
        unreadCount: 1,
      }, "root"),
    ]);

    const sessions = await collectEvalTraceSessions({ attemptRoot, rootTracePath: rootPath });

    expect(sessions.map((session) => ({
      name: session.name,
      profile: session.profile,
      role: session.role,
      sessionId: session.sessionId,
    }))).toEqual([
      { name: undefined, profile: undefined, role: "root", sessionId: "root" },
      { name: undefined, profile: "research", role: "child", sessionId: "child" },
      { name: "researcher", profile: "research", role: "teammate", sessionId: "mate" },
    ]);
  });

  it("rejects malformed JSONL and trace paths outside the attempt", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-evidence-"));
    tempRoots.push(attemptRoot);
    const malformed = path.join(attemptRoot, "malformed.jsonl");
    await fs.writeFile(malformed, "{not-json}\n", "utf8");

    await expect(readEvalTrace(malformed)).rejects.toThrow(/malformed trace JSON/);
    await expect(collectEvalTraceSessions({
      attemptRoot,
      rootTracePath: path.join(os.tmpdir(), "outside.jsonl"),
    })).rejects.toThrow(/inside the eval attempt/);
  });
});
