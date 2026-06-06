import { describe, expect, it } from "vitest";

import {
  findDangerousCommandReason,
  formatBashResultForModel,
  runBashCommand,
  truncateOutput,
} from "../../src/core/bashTool.js";

describe("findDangerousCommandReason", () => {
  it("blocks obvious destructive commands", () => {
    expect(findDangerousCommandReason("rm -rf /tmp/example")).toContain("rm -rf");
    expect(findDangerousCommandReason("sudo npm install")).toContain("sudo");
    expect(findDangerousCommandReason("mkfs.ext4 /dev/sda1")).toContain("mkfs");
    expect(findDangerousCommandReason("shutdown -h now")).toContain("shutdown");
    expect(findDangerousCommandReason("git reset --hard HEAD~1")).toContain("git reset --hard");
    expect(findDangerousCommandReason("git clean -fdx")).toContain("git clean");
  });

  it("allows ordinary read-oriented commands", () => {
    expect(findDangerousCommandReason("ls -la")).toBeUndefined();
    expect(findDangerousCommandReason("rg \"Agent Loop\" docs")).toBeUndefined();
    expect(findDangerousCommandReason("npm run typecheck")).toBeUndefined();
  });
});

describe("truncateOutput", () => {
  it("keeps short output unchanged", () => {
    expect(truncateOutput("hello", 10)).toBe("hello");
  });

  it("adds a truncation marker when output exceeds the limit", () => {
    expect(truncateOutput("abcdefgh", 4)).toBe("abcd\n[truncated 4 chars]");
  });
});

describe("formatBashResultForModel", () => {
  it("returns a readable tool result with status, exit code, stdout, and stderr", () => {
    const formatted = formatBashResultForModel({
      command: "npm run typecheck",
      durationMs: 12,
      exitCode: 2,
      status: "completed",
      stderr: "type error",
      stdout: "checking",
    });

    expect(formatted).toContain("status: completed");
    expect(formatted).toContain("exit_code: 2");
    expect(formatted).toContain("stdout:\nchecking");
    expect(formatted).toContain("stderr:\ntype error");
  });
});

describe("runBashCommand", () => {
  it("returns a blocked result instead of executing denied commands", async () => {
    const result = await runBashCommand("sudo npm install", { cwd: process.cwd() });

    expect(result.status).toBe("blocked");
    expect(result.exitCode).toBeNull();
    expect(result.blockedReason).toContain("sudo");
  });

  it("does not expose parent process secrets to child bash commands", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalHarnessSecret = process.env.FORGE_HARNESS_SECRET;
    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.FORGE_HARNESS_SECRET = "local-secret";

    try {
      const result = await runBashCommand(
        'printf "%s" "${OPENAI_API_KEY-unset}|${FORGE_HARNESS_SECRET-unset}|${PATH:+has-path}"',
        { cwd: process.cwd() },
      );

      expect(result.status).toBe("completed");
      expect(result.stdout).toBe("unset|unset|has-path");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }

      if (originalHarnessSecret === undefined) {
        delete process.env.FORGE_HARNESS_SECRET;
      } else {
        process.env.FORGE_HARNESS_SECRET = originalHarnessSecret;
      }
    }
  });
});
