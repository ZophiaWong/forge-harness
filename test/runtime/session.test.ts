import path from "node:path";

import { describe, expect, it } from "vitest";

import { createSessionId, createSessionMetadata, createSessionPaths } from "../../src/runtime/session.js";

describe("session metadata", () => {
  it("creates a readable session id from the timestamp and random suffix", () => {
    const now = new Date(2026, 5, 25, 16, 1, 2);

    expect(createSessionId(now, () => "a1b2c3d4")).toBe("20260625-160102-a1b2c3d4");
  });

  it("derives session file paths under .forge/sessions", () => {
    const paths = createSessionPaths("/workspace/forge-harness", "20260625-160102-a1b2c3d4");

    expect(paths.sessionDir).toBe(path.join("/workspace/forge-harness", ".forge", "sessions", "20260625-160102-a1b2c3d4"));
    expect(paths.sessionMetadataPath).toBe(path.join(paths.sessionDir, "session.json"));
    expect(paths.tracePath).toBe(path.join(paths.sessionDir, "trace.jsonl"));
  });

  it("builds metadata without embedding trace events", () => {
    const metadata = createSessionMetadata({
      cwd: "/workspace/forge-harness",
      id: "20260625-160102-a1b2c3d4",
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      startedAt: "2026-06-25T08:01:02.000Z",
      task: "inspect docs",
      tracePath: "/workspace/forge-harness/.forge/sessions/20260625-160102-a1b2c3d4/trace.jsonl",
    });

    expect(metadata).toEqual({
      cwd: "/workspace/forge-harness",
      id: "20260625-160102-a1b2c3d4",
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      startedAt: "2026-06-25T08:01:02.000Z",
      task: "inspect docs",
      tracePath: "/workspace/forge-harness/.forge/sessions/20260625-160102-a1b2c3d4/trace.jsonl",
    });
  });
});
