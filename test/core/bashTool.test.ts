import { describe, expect, it, vi } from "vitest";

import {
  createBashEnvironment,
  createBashTool,
  findDangerousCommandReason,
  runBashCommand,
  startBashCommand,
  truncateOutput,
} from "../../src/tools/bashTool.js";
import type { BackgroundTaskManager } from "../../src/runtime/backgroundTasks.js";

describe("findDangerousCommandReason", () => {
  it("blocks obvious destructive commands", () => {
    expect(findDangerousCommandReason("rm -rf dist")).toContain("rm -rf");
    expect(findDangerousCommandReason("sudo npm install")).toContain("sudo");
    expect(findDangerousCommandReason("git reset --hard HEAD")).toContain("git reset --hard");
    expect(findDangerousCommandReason("git clean -fd")).toContain("git clean");
  });

  it("allows ordinary inspection commands", () => {
    expect(findDangerousCommandReason("ls -la")).toBeUndefined();
    expect(findDangerousCommandReason("git status --short")).toBeUndefined();
  });
});

describe("createBashEnvironment", () => {
  it("removes secret-like environment variables", () => {
    const env = createBashEnvironment({
      OPENAI_API_KEY: "secret",
      PATH: "/usr/bin",
      SESSION_TOKEN: "secret",
      SOME_PASSWORD: "secret",
      SAFE_FLAG: "1",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      SAFE_FLAG: "1",
    });
  });
});

describe("truncateOutput", () => {
  it("marks omitted characters", () => {
    expect(truncateOutput("1234567890", 4)).toBe("1234\n[truncated 6 chars]");
  });
});

describe("runBashCommand", () => {
  it("returns stdout, stderr, and exit code", async () => {
    const result = await runBashCommand("printf ok", { cwd: process.cwd() });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("");
  });

  it("returns blocked results without spawning dangerous commands", async () => {
    const result = await runBashCommand("sudo whoami", { cwd: process.cwd() });

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBeNull();
    expect(result.blockedReason).toContain("sudo");
  });

  it("truncates command output", async () => {
    const result = await runBashCommand("printf 1234567890", {
      cwd: process.cwd(),
      outputCharLimit: 4,
    });

    expect(result.stdout).toBe("1234\n[truncated 6 chars]");
  });

  it("times out long-running commands", async () => {
    const result = await runBashCommand("sleep 1", {
      cwd: process.cwd(),
      timeoutMs: 25,
    });

    expect(result.status).toBe("timed_out");
    expect(result.stderr).toContain("[timed out after 25ms]");
  });
});

describe("startBashCommand", () => {
  it("supports canceling a running command", async () => {
    const handle = startBashCommand("sleep 1", {
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });

    handle.cancel();
    const result = await handle.promise;

    expect(result.status).toBe("canceled");
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("[canceled]");
  });
});

describe("createBashTool", () => {
  it("only exposes runInBackground when a background task manager is provided", () => {
    const foregroundOnly = createBashTool(process.cwd());
    const withBackground = createBashTool(process.cwd(), {
      backgroundTasks: fakeBackgroundTaskManager(),
    });

    expect(foregroundOnly.definition.parameters.properties).not.toHaveProperty("runInBackground");
    expect(foregroundOnly.definition.strict).toBe(true);
    expect(withBackground.definition.parameters.properties).toHaveProperty("runInBackground");
    expect(withBackground.definition.parameters.required).toEqual(["command"]);
    expect(withBackground.definition.strict).toBe(false);
  });

  it("starts a background bash task and returns minimal metadata", async () => {
    const backgroundTasks = fakeBackgroundTaskManager();
    const tool = createBashTool(process.cwd(), { backgroundTasks });

    const result = await tool.handler({
      rawArguments: JSON.stringify({
        command: "sleep 1 && echo done",
        runInBackground: true,
      }),
    });

    expect(backgroundTasks.startBash).toHaveBeenCalledWith({
      command: "sleep 1 && echo done",
      cwd: process.cwd(),
      timeoutMs: 120_000,
    });
    expect(result.status).toBe("completed");
    expect(result.content).toContain("status: background_started");
    expect(result.content).toContain("background_task_id: bg_001");
    expect(result.metadata?.backgroundTask).toEqual({
      command: "sleep 1 && echo done",
      id: "bg_001",
      kind: "bash",
    });
  });

  it("does not create a background task for dangerous commands", async () => {
    const backgroundTasks = fakeBackgroundTaskManager();
    const tool = createBashTool(process.cwd(), { backgroundTasks });

    const result = await tool.handler({
      rawArguments: JSON.stringify({
        command: "sudo whoami",
        runInBackground: true,
      }),
    });

    expect(result.status).toBe("blocked");
    expect(result.content).toContain("sudo is blocked");
    expect(backgroundTasks.startBash).not.toHaveBeenCalled();
  });
});

function fakeBackgroundTaskManager(): BackgroundTaskManager {
  return {
    cancelRunning: async () => undefined,
    drainNotifications: () => [],
    drainRunningNotifications: () => [],
    flushEvents: async () => undefined,
    startBash: vi.fn(() => ({
      command: "sleep 1 && echo done",
      id: "bg_001",
      kind: "bash" as const,
    })),
  };
}
