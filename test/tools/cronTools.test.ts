import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultPermissionPolicy } from "../../src/governance/defaultPolicy.js";
import { createFileCronScheduleStore } from "../../src/runtime/cronStore.js";
import { createDefaultToolRuntime } from "../../src/tools/defaultRuntime.js";

describe("cron management tools", () => {
  it("are exposed only when a cron schedule store is provided", () => {
    const withoutCron = createDefaultToolRuntime({ cwd: process.cwd() });
    const withCron = createDefaultToolRuntime({
      cronSchedules: createFileCronScheduleStore({ cwd: process.cwd() }),
      cwd: process.cwd(),
    });

    expect(withoutCron.toolDefinitions().map((tool) => tool.name)).not.toContain("schedule_cron");
    expect(withCron.toolDefinitions().map((tool) => tool.name)).toEqual([
      "bash",
      "read",
      "ls",
      "grep",
      "find",
      "edit",
      "write",
      "todo",
      "schedule_cron",
      "list_crons",
      "cancel_cron",
    ]);
  });

  it("creates, lists, and cancels cron schedules through the default runtime", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-cron-tools-"));
    const runtime = createDefaultToolRuntime({
      cronSchedules: createFileCronScheduleStore({
        cwd,
        now: () => new Date("2026-07-10T08:00:00.000Z"),
      }),
      cwd,
    });

    const scheduled = await runtime.execute({
      arguments: JSON.stringify({
        cron: "* * * * *",
        prompt: "Inspect package.json",
        recurring: false,
        title: "Package check",
      }),
      name: "schedule_cron",
    });
    const listed = await runtime.execute({ arguments: "{}", name: "list_crons" });
    const canceled = await runtime.execute({
      arguments: JSON.stringify({ id: "cron_001" }),
      name: "cancel_cron",
    });

    expect(scheduled.status).toBe("completed");
    expect(scheduled.content).toContain("cron_id: cron_001");
    expect(scheduled.metadata?.cronSchedule).toEqual(
      expect.objectContaining({
        id: "cron_001",
        title: "Package check",
      }),
    );
    expect(listed.content).toContain("cron_001 active once * * * * * Package check");
    expect(canceled.content).toContain("status: canceled");
    expect(canceled.metadata?.cronSchedule).toEqual(
      expect.objectContaining({
        id: "cron_001",
        status: "canceled",
      }),
    );
  });

  it("applies permission boundaries to cron management tools", () => {
    const policy = createDefaultPermissionPolicy();

    expect(policy.decide({ arguments: "{}", name: "list_crons" })).toMatchObject({
      action: "allow",
      risk: "inspect",
    });
    expect(
      policy.decide({
        arguments: JSON.stringify({
          cron: "* * * * *",
          prompt: "Inspect package.json",
          title: "Package check",
        }),
        name: "schedule_cron",
      }),
    ).toMatchObject({
      action: "ask",
      risk: "mutating",
    });
    expect(
      policy.decide({
        arguments: JSON.stringify({ id: "cron_001" }),
        name: "cancel_cron",
      }),
    ).toMatchObject({
      action: "ask",
      risk: "mutating",
    });
  });
});
