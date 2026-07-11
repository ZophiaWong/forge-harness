import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatCronMinuteKey,
  cronMatchesDate,
  parseCronExpression,
} from "../../src/runtime/cron.js";
import { createFileCronScheduleStore } from "../../src/runtime/cronStore.js";

describe("cron expression matching", () => {
  it("matches the supported five-field cron subset against local time", () => {
    const cron = parseCronExpression("*/15 9-17 1,15 * 0,7");

    expect(cronMatchesDate(cron, new Date(2026, 6, 5, 9, 30))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2026, 6, 5, 9, 31))).toBe(false);
    expect(cronMatchesDate(cron, new Date(2026, 6, 6, 9, 30))).toBe(false);
  });

  it("uses OR semantics when both day-of-month and day-of-week are restricted", () => {
    const cron = parseCronExpression("0 9 1 * 1");

    expect(cronMatchesDate(cron, new Date(2026, 6, 1, 9, 0))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2026, 6, 6, 9, 0))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2026, 6, 7, 9, 0))).toBe(false);
  });

  it("rejects unsupported cron syntax", () => {
    expect(() => parseCronExpression("* * * *")).toThrow(/five fields/);
    expect(() => parseCronExpression("@daily")).toThrow(/five fields/);
    expect(() => parseCronExpression("0 9 JAN * *")).toThrow(/must be a number/);
    expect(() => parseCronExpression("0 9 * * MON")).toThrow(/must be a number/);
  });

  it("formats a stable local minute key", () => {
    expect(formatCronMinuteKey(new Date(2026, 6, 10, 8, 4, 59))).toBe("2026-07-10T08:04");
  });
});

describe("FileCronScheduleStore", () => {
  it("creates durable cron schedules with readable ids and runtime fields", async () => {
    const cwd = await createTempDir();
    const store = createFileCronScheduleStore({
      cwd,
      now: () => new Date("2026-07-10T08:00:00.000Z"),
    });

    const first = await store.schedule({
      cron: "* * * * *",
      prompt: "Inspect package.json",
      recurring: true,
      title: "Package check",
    });
    const second = await store.schedule({
      cron: "0 9 * * *",
      prompt: "Inspect README.md",
      recurring: false,
      title: "README check",
    });

    expect(first.id).toBe("cron_001");
    expect(second.id).toBe("cron_002");
    expect(await store.list()).toEqual([
      expect.objectContaining({
        createdAt: "2026-07-10T08:00:00.000Z",
        cron: "* * * * *",
        id: "cron_001",
        prompt: "Inspect package.json",
        recurring: true,
        runCount: 0,
        status: "active",
        title: "Package check",
        updatedAt: "2026-07-10T08:00:00.000Z",
      }),
      expect.objectContaining({
        id: "cron_002",
        recurring: false,
        status: "active",
      }),
    ]);

    const file = await fs.readFile(path.join(cwd, ".forge", "scheduled_tasks.json"), "utf8");
    expect(file).toContain('"cron_001"');
  });

  it("preserves terminal tasks and continues ids after cancel", async () => {
    const cwd = await createTempDir();
    const store = createFileCronScheduleStore({
      cwd,
      now: () => new Date("2026-07-10T08:00:00.000Z"),
    });

    const first = await store.schedule({
      cron: "* * * * *",
      prompt: "Inspect package.json",
      recurring: true,
      title: "Package check",
    });
    await store.cancel(first.id);
    const second = await store.schedule({
      cron: "* * * * *",
      prompt: "Inspect README.md",
      recurring: true,
      title: "README check",
    });

    expect(second.id).toBe("cron_002");
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: "cron_001", status: "canceled" }),
      expect.objectContaining({ id: "cron_002", status: "active" }),
    ]);
  });

  it("marks fired minutes before recording scheduled run results", async () => {
    const cwd = await createTempDir();
    const store = createFileCronScheduleStore({
      cwd,
      now: () => new Date("2026-07-10T08:00:00.000Z"),
    });
    const task = await store.schedule({
      cron: "* * * * *",
      prompt: "Inspect package.json",
      recurring: false,
      title: "Package check",
    });

    await store.markFired(task.id, "2026-07-10T08:00");
    await store.recordRunFinished(task.id, {
      error: "model failed",
      sessionId: "session_1",
      status: "failed",
    });

    expect(await store.list()).toEqual([
      expect.objectContaining({
        id: "cron_001",
        lastError: "model failed",
        lastFiredMinute: "2026-07-10T08:00",
        lastRunStatus: "failed",
        lastSessionId: "session_1",
        runCount: 1,
        status: "failed",
      }),
    ]);
  });

  it("fails fast when the scheduled tasks file is invalid JSON", async () => {
    const cwd = await createTempDir();
    await fs.mkdir(path.join(cwd, ".forge"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".forge", "scheduled_tasks.json"), "{bad json", "utf8");
    const store = createFileCronScheduleStore({ cwd });

    await expect(store.list()).rejects.toThrow(/Failed to read scheduled tasks/);
  });
});

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "forge-cron-test-"));
}
