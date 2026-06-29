import { describe, expect, it } from "vitest";

import { createCommandVerifier } from "../../src/runtime/verification.js";

describe("createCommandVerifier", () => {
  it("passes when the command exits with code 0", async () => {
    const verifier = createCommandVerifier({
      command: "printf ok",
      cwd: process.cwd(),
    });

    const result = await verifier.verify({
      candidateAnswer: "done",
      round: 1,
      task: "run a passing check",
    });

    expect(result).toEqual(
      expect.objectContaining({
        command: "printf ok",
        exitCode: 0,
        recoverable: false,
        status: "passed",
      }),
    );
    expect(result.summary).toContain("exit_code: 0");
    expect(result.summary).toContain("stdout:\nok");
  });

  it("fails recoverably when the command exits non-zero", async () => {
    const verifier = createCommandVerifier({
      command: "printf nope >&2; exit 7",
      cwd: process.cwd(),
    });

    const result = await verifier.verify({
      candidateAnswer: "done",
      round: 1,
      task: "run a failing check",
    });

    expect(result).toEqual(
      expect.objectContaining({
        command: "printf nope >&2; exit 7",
        exitCode: 7,
        recoverable: true,
        status: "failed",
      }),
    );
    expect(result.summary).toContain("exit_code: 7");
    expect(result.summary).toContain("stderr:\nnope");
  });

  it("fails recoverably when the command times out", async () => {
    const verifier = createCommandVerifier({
      command: "sleep 1",
      cwd: process.cwd(),
      timeoutMs: 25,
    });

    const result = await verifier.verify({
      candidateAnswer: "done",
      round: 1,
      task: "run a slow check",
    });

    expect(result).toEqual(
      expect.objectContaining({
        command: "sleep 1",
        exitCode: null,
        recoverable: true,
        status: "failed",
      }),
    );
    expect(result.summary).toContain("status: timed_out");
  });

  it("blocks terminally when the command is disallowed", async () => {
    const verifier = createCommandVerifier({
      command: "sudo whoami",
      cwd: process.cwd(),
    });

    const result = await verifier.verify({
      candidateAnswer: "done",
      round: 1,
      task: "run a blocked check",
    });

    expect(result).toEqual(
      expect.objectContaining({
        command: "sudo whoami",
        exitCode: null,
        recoverable: false,
        status: "blocked",
      }),
    );
    expect(result.summary).toContain("blocked_reason:");
  });
});
