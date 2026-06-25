import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createJsonlTraceRecorder } from "../../src/runtime/traceRecorder.js";

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
});
