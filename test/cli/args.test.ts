import { describe, expect, it } from "vitest";

import { parseCliArgs, parseTaskFromArgs, usageText } from "../../src/cli/args.js";

describe("parseCliArgs", () => {
  it("parses a task without a verifier", () => {
    expect(parseCliArgs(["inspect", "this", "project"])).toEqual({
      task: "inspect this project",
    });
  });

  it("parses --verify from any argument position", () => {
    expect(parseCliArgs(["inspect", "--verify", "npm run build", "this", "project"])).toEqual({
      task: "inspect this project",
      verifyCommand: "npm run build",
    });
    expect(parseCliArgs(["--verify", "npm run test", "fix", "the", "tests"])).toEqual({
      task: "fix the tests",
      verifyCommand: "npm run test",
    });
  });

  it("parses --hook-log without changing the task text", () => {
    expect(parseCliArgs(["--hook-log", "--verify", "npm run build", "fix", "the", "build"])).toEqual({
      hookLog: true,
      task: "fix the build",
      verifyCommand: "npm run build",
    });
    expect(parseCliArgs(["inspect", "--hook-log", "this", "project"])).toEqual({
      hookLog: true,
      task: "inspect this project",
    });
  });

  it("returns an error when --verify has no command", () => {
    expect(parseCliArgs(["inspect", "--verify"])).toEqual({
      error: "--verify requires a command.",
      task: "inspect",
    });
  });

  it("parses cron worker modes", () => {
    expect(parseCliArgs(["--cron-worker"])).toEqual({
      cronWorker: "watch",
    });
    expect(parseCliArgs(["--cron-worker-once"])).toEqual({
      cronWorker: "once",
    });
  });

  it("rejects cron worker modes mixed with tasks or verification", () => {
    expect(parseCliArgs(["--cron-worker", "inspect"])).toEqual({
      cronWorker: "watch",
      error: "--cron-worker does not accept a task.",
      task: "inspect",
    });
    expect(parseCliArgs(["--cron-worker-once", "--verify", "npm run build"])).toEqual({
      cronWorker: "once",
      error: "--cron-worker-once does not accept --verify.",
      verifyCommand: "npm run build",
    });
    expect(parseCliArgs(["--cron-worker", "--cron-worker-once"])).toEqual({
      cronWorker: "watch",
      error: "Use only one cron worker mode.",
    });
  });
});

describe("parseTaskFromArgs", () => {
  it("joins command line words into one task", () => {
    expect(parseTaskFromArgs(["inspect", "this", "project"])).toBe("inspect this project");
  });

  it("returns undefined for empty input", () => {
    expect(parseTaskFromArgs([])).toBeUndefined();
    expect(parseTaskFromArgs(["  ", "\t"])).toBeUndefined();
  });
});

describe("usageText", () => {
  it("shows the build-first start command", () => {
    expect(usageText("forge-harness")).toContain('forge-harness "inspect this project"');
    expect(usageText("forge-harness")).toContain('forge-harness --verify "npm run build" "fix the build"');
    expect(usageText("forge-harness")).toContain(
      'forge-harness --hook-log --verify "npm run build" "fix the build"',
    );
  });
});
