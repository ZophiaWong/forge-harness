import { describe, expect, it } from "vitest";

import { createToolObservation } from "../../src/context/observation.js";
import { createContextProjection } from "../../src/context/projection.js";
import type { ToolResult } from "../../src/tools/types.js";

describe("ContextProjection", () => {
  it("projects completed tool results with an observation summary", () => {
    const result: ToolResult = {
      content: "matches:\ndocs/tutorial/c05-context-projection.md:1 | # c05 Context Projection",
      metadata: {
        observationSummary: 'grep found 1 match for "Context Projection"',
      },
      status: "completed",
      toolName: "grep",
    };

    const observation = createToolObservation(result);
    const projection = createContextProjection();

    expect(projection.projectObservation(observation)).toBe(
      [
        "tool: grep",
        "status: completed",
        'observation: grep found 1 match for "Context Projection"',
        "matches:",
        "docs/tutorial/c05-context-projection.md:1 | # c05 Context Projection",
      ].join("\n"),
    );
  });

  it("uses a stable fallback summary for blocked results", () => {
    const result: ToolResult = {
      content: "permission_denied: true\nreason: user rejected",
      status: "blocked",
      toolName: "write",
    };

    const observation = createToolObservation(result);

    expect(createContextProjection().projectObservation(observation)).toBe(
      [
        "tool: write",
        "status: blocked",
        "observation: write blocked",
        "permission_denied: true",
        "reason: user rejected",
      ].join("\n"),
    );
  });
});
