import { describe, expect, it, vi } from "vitest";

import {
  createBackgroundTaskManager,
  formatBackgroundTaskNotification,
  type BackgroundTaskExecutor,
} from "../../src/runtime/backgroundTasks.js";
import type { BashCommandHandle, BashExecutionOptions, BashExecutionResult } from "../../src/tools/bashTool.js";

describe("BackgroundTaskManager", () => {
  it("starts bash tasks with creation-ordered ids", () => {
    const executor = createFakeExecutor();
    const manager = createBackgroundTaskManager({ executor });

    const first = manager.startBash({
      command: "sleep 1 && echo one",
      cwd: "/workspace",
      timeoutMs: 120_000,
    });
    const second = manager.startBash({
      command: "sleep 1 && echo two",
      cwd: "/workspace",
      timeoutMs: 120_000,
    });

    expect(first).toEqual({
      command: "sleep 1 && echo one",
      id: "bg_001",
      kind: "bash",
    });
    expect(second).toEqual({
      command: "sleep 1 && echo two",
      id: "bg_002",
      kind: "bash",
    });
    expect(executor.calls.map((call) => call.options)).toEqual([
      { cwd: "/workspace", timeoutMs: 120_000 },
      { cwd: "/workspace", timeoutMs: 120_000 },
    ]);
  });

  it("drains terminal notifications once in task id order", async () => {
    const executor = createFakeExecutor();
    const manager = createBackgroundTaskManager({ executor });
    manager.startBash({ command: "printf one", cwd: "/workspace", timeoutMs: 120_000 });
    manager.startBash({ command: "printf two", cwd: "/workspace", timeoutMs: 120_000 });

    executor.calls[1]?.deferred.resolve(bashResult("printf two", "completed", "two"));
    executor.calls[0]?.deferred.resolve(bashResult("printf one", "timed_out", "one", "[timed out]"));
    await flushPromises();

    const notifications = manager.drainNotifications();

    expect(notifications.map((notification) => notification.id)).toEqual(["bg_001", "bg_002"]);
    expect(notifications.map((notification) => notification.status)).toEqual(["timed_out", "completed"]);
    expect(manager.drainNotifications()).toEqual([]);
    expect(formatBackgroundTaskNotification(notifications[0]!)).toContain("<task_notification>");
    expect(formatBackgroundTaskNotification(notifications[0]!)).toContain("background_task_id: bg_001");
    expect(formatBackgroundTaskNotification(notifications[0]!)).toContain("status: timed_out");
  });

  it("drains running notifications once without consuming the terminal result", async () => {
    const executor = createFakeExecutor();
    const manager = createBackgroundTaskManager({ executor });
    manager.startBash({ command: "sleep 5", cwd: "/workspace", timeoutMs: 120_000 });

    const running = manager.drainRunningNotifications();

    expect(running).toHaveLength(1);
    expect(running[0]).toEqual(
      expect.objectContaining({
        command: "sleep 5",
        id: "bg_001",
        kind: "bash",
        status: "running",
      }),
    );
    expect(manager.drainRunningNotifications()).toEqual([]);

    executor.calls[0]?.deferred.resolve(bashResult("sleep 5", "completed", "done"));
    await flushPromises();

    expect(manager.drainNotifications()).toEqual([
      expect.objectContaining({
        id: "bg_001",
        status: "completed",
      }),
    ]);
  });

  it("cancels running tasks and emits finished callbacks without model notifications", async () => {
    const executor = createFakeExecutor();
    const finished = vi.fn();
    const manager = createBackgroundTaskManager({ executor, onTaskFinished: finished });
    manager.startBash({ command: "sleep 5", cwd: "/workspace", timeoutMs: 120_000 });

    await manager.cancelRunning();
    await manager.flushEvents();

    expect(executor.calls[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "sleep 5",
        id: "bg_001",
        kind: "bash",
        status: "canceled",
      }),
    );
    expect(manager.drainNotifications()).toEqual([]);
  });

  it("flushes fire-and-track finished callbacks", async () => {
    const executor = createFakeExecutor();
    const callbackGate = createDeferred<void>();
    const finished = vi.fn(async () => {
      await callbackGate.promise;
    });
    const manager = createBackgroundTaskManager({ executor, onTaskFinished: finished });
    manager.startBash({ command: "printf done", cwd: "/workspace", timeoutMs: 120_000 });

    executor.calls[0]?.deferred.resolve(bashResult("printf done", "completed", "done"));
    await flushPromises();

    let flushed = false;
    const flush = manager.flushEvents().then(() => {
      flushed = true;
    });
    await flushPromises();

    expect(flushed).toBe(false);
    callbackGate.resolve();
    await flush;
    expect(finished).toHaveBeenCalledTimes(1);
    expect(flushed).toBe(true);
  });
});

function createFakeExecutor(): BackgroundTaskExecutor & {
  calls: Array<{
    cancel: ReturnType<typeof vi.fn>;
    command: string;
    deferred: Deferred<BashExecutionResult>;
    options: BashExecutionOptions;
  }>;
} {
  const calls: Array<{
    cancel: ReturnType<typeof vi.fn>;
    command: string;
    deferred: Deferred<BashExecutionResult>;
    options: BashExecutionOptions;
  }> = [];
  const executor = vi.fn((command: string, options: BashExecutionOptions): BashCommandHandle => {
    const deferred = createDeferred<BashExecutionResult>();
    const cancel = vi.fn(() => {
      deferred.resolve(bashResult(command, "canceled", "", "[canceled]", null));
    });
    calls.push({ cancel, command, deferred, options });
    return { cancel, promise: deferred.promise };
  }) as unknown as BackgroundTaskExecutor & { calls: typeof calls };

  executor.calls = calls;
  return executor;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

function bashResult(
  command: string,
  status: BashExecutionResult["status"],
  stdout: string,
  stderr = "",
  exitCode: number | null = 0,
): BashExecutionResult {
  return {
    command,
    durationMs: 10,
    exitCode,
    status,
    stderr,
    stdout,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
