import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCliSessionTrace,
  createSessionId,
  createSessionMetadata,
  createSessionPaths,
} from "../../src/runtime/session.js";

describe("session metadata", () => {
  it("creates a readable session id from the timestamp and random suffix", () => {
    const now = new Date(2026, 5, 25, 16, 1, 2);

    expect(createSessionId(now, () => "a1b2c3d4")).toBe("20260625-160102-a1b2c3d4");
  });

  it("derives session file paths under .forge/sessions", () => {
    const paths = createSessionPaths("/workspace/forge-harness", "20260625-160102-a1b2c3d4");

    expect(paths.sessionDir).toBe(path.join("/workspace/forge-harness", ".forge", "sessions", "20260625-160102-a1b2c3d4"));
    expect(paths.sessionMetadataPath).toBe(path.join(paths.sessionDir, "session.json"));
    expect(paths.taskGraphPath).toBe(path.join(paths.sessionDir, "task-graph.json"));
    expect(paths.tracePath).toBe(path.join(paths.sessionDir, "trace.jsonl"));
  });

  it("round-trips a child task-graph binding through session metadata", () => {
    const taskGraph = {
      delegatedTaskId: "task_001",
      rootSessionId: "20260625-160102-a1b2c3d4",
      taskGraphPath: "/workspace/forge-harness/.forge/sessions/20260625-160102-a1b2c3d4/task-graph.json",
    };
    const metadata = createSessionMetadata({
      child: {
        parentCallId: "call_delegate",
        parentSessionId: "20260625-160102-a1b2c3d4",
        profile: "research",
        role: "child",
      },
      cwd: "/workspace/forge-harness",
      id: "20260625-160103-e5f6a7b8",
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      startedAt: "2026-06-25T08:01:02.000Z",
      task: "coordinate implementation",
      taskGraph,
      tracePath: "/workspace/forge-harness/.forge/sessions/20260625-160103-e5f6a7b8/trace.jsonl",
    });

    expect(JSON.parse(JSON.stringify(metadata))).toEqual({
      child: {
        parentCallId: "call_delegate",
        parentSessionId: "20260625-160102-a1b2c3d4",
        profile: "research",
        role: "child",
      },
      cwd: "/workspace/forge-harness",
      id: "20260625-160103-e5f6a7b8",
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      startedAt: "2026-06-25T08:01:02.000Z",
      task: "coordinate implementation",
      taskGraph,
      tracePath: "/workspace/forge-harness/.forge/sessions/20260625-160103-e5f6a7b8/trace.jsonl",
    });
  });

  it("initializes a root task graph beside the root session metadata and trace", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-root-session-"));
    const session = await createCliSessionTrace({
      cwd,
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      now: () => new Date("2026-06-25T08:01:02.000Z"),
      randomSuffix: () => "a1b2c3d4",
      task: "coordinate implementation",
    });

    expect(session.metadata.taskGraph).toEqual({
      rootSessionId: session.metadata.id,
      taskGraphPath: session.paths.taskGraphPath,
    });
    expect(path.isAbsolute(session.paths.taskGraphPath)).toBe(true);
    await expect(
      fs.readFile(session.paths.sessionMetadataPath, "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual(session.metadata);
    await expect(
      fs.readFile(session.paths.taskGraphPath, "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      nextTaskSequence: 1,
      revision: 0,
      schemaVersion: 1,
      tasks: [],
    });
  });

  it("rejects a supplied task-graph binding for a root session before writing session files", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-root-task-override-"));
    const sessionId = "20260625-160102-a1b2c3d4";
    const paths = createSessionPaths(cwd, sessionId);

    await expect(
      createCliSessionTrace({
        cwd,
        maxToolRounds: 8,
        model: "gpt-5.4-mini",
        now: () => new Date("2026-06-25T08:01:02.000Z"),
        randomSuffix: () => "a1b2c3d4",
        task: "coordinate implementation",
        taskGraph: {
          rootSessionId: "another-root",
          taskGraphPath: path.join(cwd, "external", "task-graph.json"),
        },
      }),
    ).rejects.toThrow("root session cannot supply a taskGraph binding");
    await expect(fs.stat(paths.sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a supplied root task-graph binding for a child without creating a child graph", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-child-task-binding-"));
    const root = await createCliSessionTrace({
      cwd,
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      now: () => new Date("2026-06-25T08:01:02.000Z"),
      randomSuffix: () => "a1b2c3d4",
      task: "coordinate implementation",
    });
    if (!root.metadata.taskGraph) {
      throw new Error("root session did not expose its derived task-graph binding");
    }
    const taskGraph = {
      ...root.metadata.taskGraph,
      delegatedTaskId: "task_001",
    };

    const child = await createCliSessionTrace({
      child: {
        parentCallId: "call_delegate",
        parentSessionId: root.metadata.id,
        profile: "research",
        role: "child",
      },
      cwd,
      maxToolRounds: 4,
      model: "gpt-5.4-mini",
      now: () => new Date("2026-06-25T08:01:03.000Z"),
      randomSuffix: () => "e5f6a7b8",
      task: "inspect the delegated task",
      taskGraph,
    });

    expect(child.metadata.taskGraph).toEqual(taskGraph);
    await expect(
      fs.readFile(child.paths.sessionMetadataPath, "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual(child.metadata);
    await expect(fs.stat(child.paths.taskGraphPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(root.paths.taskGraphPath)).resolves.toBeDefined();
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

  it("builds metadata for a worktree-bound session while storing evidence in the base repo", () => {
    const metadata = createSessionMetadata({
      baseCwd: "/workspace/forge-harness",
      cwd: "/workspace/forge-harness/.forge/worktrees/20260625-160102-a1b2c3d4",
      id: "20260625-160102-a1b2c3d4",
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      startedAt: "2026-06-25T08:01:02.000Z",
      task: "inspect docs",
      tracePath: "/workspace/forge-harness/.forge/sessions/20260625-160102-a1b2c3d4/trace.jsonl",
      workspace: {
        baseBranch: "main",
        baseCommit: "9bd9d56d8c3fe94a72c1707a6f805fe87527ca23",
        branch: "forge/run/20260625-160102-a1b2c3d4",
        mode: "git_worktree",
        path: "/workspace/forge-harness/.forge/worktrees/20260625-160102-a1b2c3d4",
      },
    });

    expect(metadata).toEqual({
      baseCwd: "/workspace/forge-harness",
      cwd: "/workspace/forge-harness/.forge/worktrees/20260625-160102-a1b2c3d4",
      id: "20260625-160102-a1b2c3d4",
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      startedAt: "2026-06-25T08:01:02.000Z",
      task: "inspect docs",
      tracePath: "/workspace/forge-harness/.forge/sessions/20260625-160102-a1b2c3d4/trace.jsonl",
      workspace: {
        baseBranch: "main",
        baseCommit: "9bd9d56d8c3fe94a72c1707a6f805fe87527ca23",
        branch: "forge/run/20260625-160102-a1b2c3d4",
        mode: "git_worktree",
        path: "/workspace/forge-harness/.forge/worktrees/20260625-160102-a1b2c3d4",
      },
    });
  });

  it("builds metadata for a child session source", () => {
    const metadata = createSessionMetadata({
      child: {
        parentCallId: "call_delegate",
        parentSessionId: "parent-session",
        profile: "research",
        role: "child",
      },
      cwd: "/workspace/forge-harness",
      id: "child-session",
      maxToolRounds: 4,
      model: "gpt-5.4-mini",
      startedAt: "2026-06-25T08:01:02.000Z",
      task: "Inspect docs",
      tracePath: "/workspace/forge-harness/.forge/sessions/child-session/trace.jsonl",
    });

    expect(metadata).toMatchObject({
      child: {
        parentCallId: "call_delegate",
        parentSessionId: "parent-session",
        profile: "research",
        role: "child",
      },
      id: "child-session",
    });
  });
});
