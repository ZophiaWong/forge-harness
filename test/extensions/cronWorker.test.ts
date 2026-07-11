import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCronWorker } from "../../src/extensions/cronWorker.js";
import { createFileCronScheduleStore } from "../../src/runtime/cronStore.js";
import type { TraceEventPayload, TraceRecorder } from "../../src/runtime/trace.js";

describe("CronWorker", () => {
  it("fires due schedules once per minute and records the scheduled run result", async () => {
    const cwd = await createTempDir();
    const now = new Date(2026, 6, 10, 8, 0, 30);
    const store = createFileCronScheduleStore({
      cwd,
      now: () => now,
    });
    await store.schedule({
      cron: "* * * * *",
      prompt: "Inspect package.json",
      recurring: true,
      title: "Package check",
    });
    const trace = createMemoryTraceRecorder();
    const runner = vi.fn(async () => ({
      sessionId: "scheduled_session_1",
      status: "completed" as const,
    }));

    const worker = createCronWorker({
      cwd,
      now: () => now,
      recorder: trace,
      runScheduledTask: runner,
      store,
    });

    await worker.runOnce();
    await worker.runOnce();

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cron_001",
        prompt: "Inspect package.json",
      }),
    );
    expect(await store.list()).toEqual([
      expect.objectContaining({
        lastFiredMinute: "2026-07-10T08:00",
        lastRunStatus: "completed",
        lastSessionId: "scheduled_session_1",
        runCount: 1,
        status: "active",
      }),
    ]);
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        cronId: "cron_001",
        sessionId: "scheduled_session_1",
        status: "completed",
        type: "cron_run_finished",
      }),
    );
  });

  it("keeps recurring schedules active after failed runs", async () => {
    const cwd = await createTempDir();
    const now = new Date(2026, 6, 10, 8, 0, 30);
    const store = createFileCronScheduleStore({ cwd, now: () => now });
    await store.schedule({
      cron: "* * * * *",
      prompt: "Inspect package.json",
      recurring: true,
      title: "Package check",
    });

    const worker = createCronWorker({
      cwd,
      now: () => now,
      runScheduledTask: async () => ({
        error: "model failed",
        sessionId: "scheduled_session_1",
        status: "failed",
      }),
      store,
    });

    await worker.runOnce();

    expect(await store.list()).toEqual([
      expect.objectContaining({
        lastError: "model failed",
        lastRunStatus: "failed",
        runCount: 1,
        status: "active",
      }),
    ]);
  });

  it("moves one-shot schedules to terminal status after the run", async () => {
    const cwd = await createTempDir();
    const now = new Date(2026, 6, 10, 8, 0, 30);
    const store = createFileCronScheduleStore({ cwd, now: () => now });
    await store.schedule({
      cron: "* * * * *",
      prompt: "Inspect package.json",
      recurring: false,
      title: "Package check",
    });

    await createCronWorker({
      cwd,
      now: () => now,
      runScheduledTask: async () => ({
        sessionId: "scheduled_session_1",
        status: "completed",
      }),
      store,
    }).runOnce();

    expect(await store.list()).toEqual([
      expect.objectContaining({
        lastRunStatus: "completed",
        runCount: 1,
        status: "completed",
      }),
    ]);
  });

  it("skips queued work when the schedule was canceled before execution", async () => {
    const cwd = await createTempDir();
    const now = new Date(2026, 6, 10, 8, 0, 30);
    const store = createFileCronScheduleStore({ cwd, now: () => now });
    await store.schedule({
      cron: "* * * * *",
      prompt: "Inspect package.json",
      recurring: true,
      title: "Package check",
    });
    const runner = vi.fn(async () => ({
      sessionId: "scheduled_session_1",
      status: "completed" as const,
    }));

    const worker = createCronWorker({
      beforeRun: async (task) => {
        await store.cancel(task.id);
      },
      cwd,
      now: () => now,
      runScheduledTask: runner,
      store,
    });

    await worker.runOnce();

    expect(runner).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([
      expect.objectContaining({
        runCount: 0,
        status: "canceled",
      }),
    ]);
  });
});

function createMemoryTraceRecorder(): TraceRecorder & { events: TraceEventPayload[] } {
  const events: TraceEventPayload[] = [];
  return {
    events,
    async record(event) {
      events.push(event);
    },
  };
}

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "forge-cron-worker-"));
}
