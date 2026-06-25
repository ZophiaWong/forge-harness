import { describe, expect, it } from "vitest";

import {
  formatFunctionCallTranscript,
  formatPermissionDecisionTranscript,
  formatSessionTranscript,
} from "../../src/cli/transcript.js";

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
