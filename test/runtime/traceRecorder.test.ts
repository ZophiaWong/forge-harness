import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createJsonlTraceRecorder } from "../../src/runtime/traceRecorder.js";
import { parseRecordedTraceEvent } from "../../src/runtime/traceSchema.js";

describe("JsonlTraceRecorder", () => {
  it("appends recorded events with session id, sequence, and timestamp", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-trace-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const timestamps = [
      new Date("2026-06-25T08:01:02.000Z"),
      new Date("2026-06-25T08:01:03.000Z"),
    ];
    const recorder = createJsonlTraceRecorder({
      now: () => timestamps.shift() ?? new Date("2026-06-25T08:01:04.000Z"),
      sessionId: "20260625-160102-a1b2c3d4",
      tracePath,
    });

    await recorder.record({
      cwd: "/workspace/forge-harness",
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      task: "inspect docs",
      type: "session_started",
    });
    await recorder.record({
      answer: "done",
      round: 2,
      type: "final_answer",
    });

    const lines = (await fs.readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toEqual([
      {
        cwd: "/workspace/forge-harness",
        maxToolRounds: 8,
        model: "gpt-5.4-mini",
        sequence: 1,
        sessionId: "20260625-160102-a1b2c3d4",
        task: "inspect docs",
        timestamp: "2026-06-25T08:01:02.000Z",
        type: "session_started",
      },
      {
        answer: "done",
        round: 2,
        sequence: 2,
        sessionId: "20260625-160102-a1b2c3d4",
        timestamp: "2026-06-25T08:01:03.000Z",
        type: "final_answer",
      },
    ]);
  });

  it("preserves payload subject session ids without replacing the recorder session id", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-trace-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = createJsonlTraceRecorder({
      sessionId: "root-session",
      tracePath,
    });

    await recorder.record({
      cronId: "cron-1",
      sessionId: "cron-session",
      status: "completed",
      title: "nightly",
      type: "cron_run_finished",
    });
    await recorder.record({
      name: "researcher",
      profile: "research",
      sessionId: "teammate-1",
      state: "starting",
      tracePath: path.join(dir, "teammate-1.jsonl"),
      type: "teammate_registered",
      unreadCount: 0,
    });
    await recorder.record({
      name: "researcher",
      previousState: "starting",
      profile: "research",
      sessionId: "teammate-1",
      state: "idle",
      tracePath: path.join(dir, "teammate-1.jsonl"),
      type: "teammate_state_changed",
      unreadCount: 0,
    });
    await recorder.record({
      approved: true,
      name: "researcher",
      requestId: "approval-1",
      sessionId: "teammate-1",
      toolName: "edit",
      type: "teammate_approval_brokered",
    });
    await recorder.record({
      name: "researcher",
      previousSessionId: "teammate-1",
      recoveryMessageId: "recovery-1",
      sessionId: "teammate-2",
      tracePath: path.join(dir, "teammate-2.jsonl"),
      type: "teammate_rejoined",
    });

    const lines = (await fs.readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(lines.map((event) => parseRecordedTraceEvent(event))).toHaveLength(5);
    expect(lines.map((event) => event.sessionId)).toEqual(Array(5).fill("root-session"));
    expect(lines.map((event) => event.subjectSessionId)).toEqual([
      "cron-session",
      "teammate-1",
      "teammate-1",
      "teammate-1",
      "teammate-2",
    ]);
  });

  it("serializes concurrent appends in record invocation order", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-trace-"));
    const tracePath = path.join(dir, "trace.jsonl");
    const releaseFirst = createDeferred<void>();
    const invocations: number[] = [];
    const completions: number[] = [];
    let writeNumber = 0;
    const recorder = createJsonlTraceRecorder({
      async appendFile(file, data, encoding) {
        writeNumber += 1;
        const current = writeNumber;
        invocations.push(current);
        if (current === 1) {
          await releaseFirst.promise;
        }
        await fs.appendFile(file, data, encoding);
        completions.push(current);
      },
      now: () => new Date("2026-08-04T10:00:00.000Z"),
      sessionId: "root-session",
      tracePath,
    });

    const first = recorder.record({
      answer: "first",
      round: 1,
      type: "final_answer",
    });
    const second = recorder.record({
      answer: "second",
      round: 2,
      type: "final_answer",
    });
    await Promise.resolve();

    expect(invocations).toEqual([1]);
    expect(completions).toEqual([]);

    releaseFirst.resolve();
    await second;
    await first;

    expect(invocations).toEqual([1, 2]);
    expect(completions).toEqual([1, 2]);
    const events = (await fs.readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => parseRecordedTraceEvent(JSON.parse(line)));
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.type === "final_answer" ? event.answer : undefined))
      .toEqual(["first", "second"]);
  });

  it("does not invoke later queued appends after an earlier append fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-trace-"));
    const failure = new Error("trace append failed");
    const releaseFailure = createDeferred<void>();
    let invocations = 0;
    const recorder = createJsonlTraceRecorder({
      async appendFile() {
        invocations += 1;
        await releaseFailure.promise;
        throw failure;
      },
      sessionId: "root-session",
      tracePath: path.join(dir, "trace.jsonl"),
    });

    const first = recorder.record({
      answer: "first",
      round: 1,
      type: "final_answer",
    });
    const second = recorder.record({
      answer: "second",
      round: 2,
      type: "final_answer",
    });
    releaseFailure.resolve();

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(invocations).toBe(1);
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
