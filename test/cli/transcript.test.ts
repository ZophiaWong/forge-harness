import { describe, expect, it } from "vitest";

import { formatFunctionCallTranscript } from "../../src/cli/transcript.js";

describe("formatFunctionCallTranscript", () => {
  it("prints the model tool request as a function_call", () => {
    expect(formatFunctionCallTranscript(1, "bash", '{"command":"ls -la"}')).toBe(
      '[round 1] function_call: bash {"command":"ls -la"}',
    );
  });
});
