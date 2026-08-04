import { describe, expect, it } from "vitest";

import {
  createAsyncChildSessionManager,
  type ChildSessionRunner,
} from "../../src/extensions/childSessions.js";
import type {
  ChildSessionRunRequest,
  ChildSessionRunResult,
} from "../../src/tools/delegateTool.js";

describe("child terminal handoff registry", () => {
  it("registers synchronous terminal provenance and prevents cross-task source reuse", async () => {
    const request = editRequest("task_001");
    const result = editResult("child-sync");
    const runner: ChildSessionRunner = {
      async run() {
        return result;
      },
      async start() {
        throw new Error("not used");
      },
    };
    const manager = createAsyncChildSessionManager({ runner });

    await manager.run(request);

    expect(manager.getTerminal("child-sync")).toMatchObject({
      request: { profile: "edit", taskId: "task_001" },
      result: { childSessionId: "child-sync", status: "completed" },
    });
    expect(manager.resolveEditSource("child-sync", "task_001")).toMatchObject({
      childSessionId: "child-sync",
      kind: "child",
      workspace: { branch: "child-branch", path: "/registered/child-worktree" },
    });
    expect(() => manager.resolveEditSource("child-sync", "task_002")).toThrow(
      'delegated task "task_001"',
    );
  });

  it("registers asynchronous terminal handoffs after their handle settles", async () => {
    const deferred = createDeferred<ChildSessionRunResult>();
    const runner: ChildSessionRunner = {
      async run() {
        throw new Error("not used");
      },
      async start() {
        return {
          cancel() {
            return undefined;
          },
          childSessionId: "child-async",
          profile: "edit",
          promise: deferred.promise,
          status: "running",
          tracePath: "/registered/trace.jsonl",
        };
      },
    };
    const manager = createAsyncChildSessionManager({ runner });
    await manager.start(editRequest("task_001"));
    expect(manager.getTerminal("child-async")).toBeUndefined();

    deferred.resolve(editResult("child-async"));
    await flushPromises();

    expect(manager.getTerminal("child-async")).toMatchObject({
      request: { taskId: "task_001" },
      result: { childSessionId: "child-async" },
    });
    expect(manager.drainNotifications()).toEqual([
      expect.objectContaining({ childSessionId: "child-async", status: "completed" }),
    ]);
  });
});

function editRequest(taskId: string): ChildSessionRunRequest {
  return {
    maxToolRounds: 4,
    parentCallId: "call-delegate",
    parentRound: 1,
    profile: "edit",
    runInBackground: false,
    task: "Edit the artifact",
    taskId,
  };
}

function editResult(childSessionId: string): ChildSessionRunResult {
  return {
    changedFiles: ["demo.txt"],
    childSessionId,
    finalAnswer: "Edited demo.txt",
    profile: "edit",
    status: "completed",
    tracePath: "/registered/trace.jsonl",
    workspace: {
      branch: "child-branch",
      path: "/registered/child-worktree",
    },
  };
}

function createDeferred<T>() {
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
