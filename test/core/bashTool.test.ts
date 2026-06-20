import { describe, expect, it } from "vitest";

import {
  createBashEnvironment,
  findDangerousCommandReason,
  runBashCommand,
  truncateOutput,
} from "../../src/tools/bashTool.js";

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
