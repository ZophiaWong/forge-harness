import { describe, expect, it } from "vitest";

import {
  formatFunctionCallTranscript,
  formatPermissionDecisionTranscript,
  formatRecoveryTranscript,
  formatRuntimeStateTranscript,
  formatSessionTranscript,
  formatVerificationTranscript,
} from "../../src/cli/transcript.js";
import type { RuntimeState } from "../../src/runtime/state.js";
import type { VerificationResult } from "../../src/runtime/verification.js";

describe("formatFunctionCallTranscript", () => {
  it("prints the model tool request as a function_call", () => {
    expect(formatFunctionCallTranscript(1, "bash", '{"command":"ls -la"}')).toBe(
      '[round 1] function_call: bash {"command":"ls -la"}',
    );
  });
});

describe("formatPermissionDecisionTranscript", () => {
  it("prints the permission decision concisely", () => {
    expect(
      formatPermissionDecisionTranscript(2, {
        action: "ask",
        reason: "bash command may modify files or external state",
        risk: "mutating",
      }),
    ).toBe("[round 2] permission: ask risk=mutating reason=bash command may modify files or external state");
  });
});

describe("formatSessionTranscript", () => {
  it("prints the session id and trace path", () => {
    expect(formatSessionTranscript("20260625-160102-a1b2c3d4", ".forge/sessions/20260625-160102-a1b2c3d4/trace.jsonl")).toBe(
      "[session] id=20260625-160102-a1b2c3d4 trace=.forge/sessions/20260625-160102-a1b2c3d4/trace.jsonl",
    );
  });
});

describe("formatVerificationTranscript", () => {
  it("prints a compact verification result", () => {
    const result: VerificationResult = {
      command: "npm run build",
      exitCode: 0,
      name: "command",
      recoverable: false,
      status: "passed",
      summary: "status: completed\ncommand: npm run build\nexit_code: 0",
    };

    expect(formatVerificationTranscript(result)).toBe('[verify] status=passed command="npm run build" exitCode=0');
  });
});

describe("formatRecoveryTranscript", () => {
  it("prints the recovery attempt count", () => {
    expect(formatRecoveryTranscript(1, 1)).toBe("[recovery] attempt=1/1");
  });
});

describe("formatRuntimeStateTranscript", () => {
  it("prints a compact round state summary when a tool result exists", () => {
    const state: RuntimeState = {
      currentRound: 1,
      ended: false,
      lastToolResult: {
        callId: "call_find",
        projectedOutput: "tool: find\nstatus: completed",
        round: 1,
        status: "completed",
        toolName: "find",
      },
      status: "running",
    };

    expect(formatRuntimeStateTranscript(state, 1)).toBe(
      "[round 1] state: status=running lastTool=find lastToolStatus=completed",
    );
  });

  it("prints a compact final state summary with rounds and problem kind when present", () => {
    const state: RuntimeState = {
      currentRound: 1,
      ended: true,
      lastProblem: {
        kind: "session_failed",
        message: "stopped without final answer",
      },
      rounds: 1,
      status: "failed",
    };

    expect(formatRuntimeStateTranscript(state)).toBe("[state] status=failed rounds=1 problem=session_failed");
  });

  it("prints verification and recovery fields when present", () => {
    const state: RuntimeState = {
      currentRound: 2,
      ended: true,
      lastVerificationResult: {
        command: "npm run build",
        exitCode: 0,
        name: "command",
        round: 2,
        status: "passed",
        summary: "status: completed\ncommand: npm run build\nexit_code: 0",
      },
      recoveryAttempts: 1,
      rounds: 2,
      status: "completed",
    };

    expect(formatRuntimeStateTranscript(state)).toBe(
      "[state] status=completed rounds=2 verification=passed recoveryAttempts=1",
    );
  });
});
