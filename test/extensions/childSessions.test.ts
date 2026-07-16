import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createAsyncChildSessionManager,
  createChildProfileToolRuntime,
  formatChildSessionNotification,
  formatChildProfileTask,
  listChangedFiles,
} from "../../src/extensions/childSessions.js";
import type { ChildSessionRunResult } from "../../src/tools/delegateTool.js";

describe("child session profiles", () => {
  it("uses fresh profile tool surfaces without bash, delegate, or cron tools", () => {
    expect(createChildProfileToolRuntime({ cwd: process.cwd(), profile: "research" }).toolDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "todo",
    ]);
    expect(createChildProfileToolRuntime({ cwd: process.cwd(), profile: "edit" }).toolDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "edit",
      "write",
      "todo",
    ]);
  });

  it("prepends profile-specific prompt prose while preserving child skill invocations", () => {
    const task = formatChildProfileTask({
      profile: "research",
      task: "/chapter-handoff Inspect the previous chapter gap.",
    });

    expect(task).toContain("You are a fresh research child session.");
    expect(task).toContain("Report findings, evidence, open questions, and the next step");
    expect(task).toContain("/chapter-handoff Inspect the previous chapter gap.");
  });

  it("lists changed files from git porcelain status without inline diff", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-child-status-"));
    await fs.writeFile(path.join(cwd, "unchanged.txt"), "base\n", "utf8");
    await execGit(cwd, ["init"]);
    await execGit(cwd, ["config", "user.email", "test@example.com"]);
    await execGit(cwd, ["config", "user.name", "Test User"]);
    await execGit(cwd, ["add", "unchanged.txt"]);
    await execGit(cwd, ["commit", "-m", "base"]);
    await fs.writeFile(path.join(cwd, "unchanged.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(cwd, "new.txt"), "new\n", "utf8");

    await expect(listChangedFiles(cwd)).resolves.toEqual(["new.txt", "unchanged.txt"]);
  });
});

describe("AsyncChildSessionManager", () => {
  it("starts multiple child sessions and drains terminal notifications once in start order", async () => {
    const first = createDeferred<ChildSessionRunResult>();
    const second = createDeferred<ChildSessionRunResult>();
    const runner = {
      run: vi.fn(),
      start: vi
        .fn()
        .mockReturnValueOnce({
          childSessionId: "child-1",
          profile: "research",
          promise: first.promise,
          status: "running",
          tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        })
        .mockReturnValueOnce({
          childSessionId: "child-2",
          profile: "edit",
          promise: second.promise,
          status: "running",
          tracePath: "/repo/.forge/sessions/child-2/trace.jsonl",
        }),
    };
    const manager = createAsyncChildSessionManager({ runner });

    const firstStart = await manager.start({
      maxToolRounds: 4,
      parentCallId: "call_1",
      parentRound: 1,
      profile: "research",
      runInBackground: true,
      task: "Inspect docs.",
    });
    const secondStart = await manager.start({
      maxToolRounds: 4,
      parentCallId: "call_2",
      parentRound: 1,
      profile: "edit",
      runInBackground: true,
      task: "Draft docs.",
    });

    expect(firstStart.childSessionId).toBe("child-1");
    expect(secondStart.childSessionId).toBe("child-2");
    expect(manager.pendingCount()).toBe(2);

    second.resolve({
      changedFiles: ["docs/tutorial/c15b-async-child-sessions-parallel-handoff.md"],
      childSessionId: "child-2",
      finalAnswer: "Drafted docs.",
      profile: "edit",
      status: "completed",
      tracePath: "/repo/.forge/sessions/child-2/trace.jsonl",
      workspace: {
        branch: "forge/run/child-2",
        path: "/repo/.forge/worktrees/child-2",
      },
    });
    first.resolve({
      childSessionId: "child-1",
      finalAnswer: "Found the async boundary.",
      profile: "research",
      status: "completed",
      tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
    });
    await flushPromises();

    const notifications = manager.drainNotifications();

    expect(notifications.map((notification) => notification.childSessionId)).toEqual(["child-1", "child-2"]);
    expect(notifications[1]).toMatchObject({
      changedFiles: ["docs/tutorial/c15b-async-child-sessions-parallel-handoff.md"],
      childSessionId: "child-2",
      profile: "edit",
      status: "completed",
      workspace: {
        branch: "forge/run/child-2",
        path: "/repo/.forge/worktrees/child-2",
      },
    });
    expect(manager.drainNotifications()).toEqual([]);
    expect(manager.pendingCount()).toBe(0);
    expect(formatChildSessionNotification(notifications[1]!)).toContain("workspace_branch: forge/run/child-2");
    expect(formatChildSessionNotification(notifications[1]!)).toContain("changed_files:");
  });

  it("formats running notifications without consuming terminal notifications", async () => {
    const deferred = createDeferred<ChildSessionRunResult>();
    const manager = createAsyncChildSessionManager({
      runner: {
        run: vi.fn(),
        start: vi.fn().mockReturnValue({
          childSessionId: "child-1",
          profile: "research",
          promise: deferred.promise,
          status: "running",
          tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        }),
      },
    });

    await manager.start({
      maxToolRounds: 4,
      parentCallId: "call_1",
      parentRound: 1,
      profile: "research",
      runInBackground: true,
      task: "Inspect docs.",
    });

    expect(manager.runningNotifications()).toEqual([
      expect.objectContaining({
        childSessionId: "child-1",
        profile: "research",
        status: "running",
      }),
    ]);

    deferred.resolve({
      childSessionId: "child-1",
      finalAnswer: "Research complete.",
      profile: "research",
      status: "completed",
      tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
    });
    await flushPromises();

    expect(manager.drainNotifications()).toEqual([
      expect.objectContaining({
        childSessionId: "child-1",
        finalAnswer: "Research complete.",
        status: "completed",
      }),
    ]);
  });
});

async function execGit(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", args, { cwd });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
