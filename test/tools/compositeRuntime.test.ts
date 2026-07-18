import { describe, expect, it, vi } from "vitest";

import { composeToolRuntimes } from "../../src/tools/compositeRuntime.js";
import type { ToolCallRequest, ToolDefinition, ToolRuntime } from "../../src/tools/types.js";

function definition(name: string): ToolDefinition {
  return {
    description: `${name} description`,
    name,
    parameters: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    strict: true,
    type: "function",
  };
}

function runtime(name: string, available: () => boolean = () => true): ToolRuntime {
  return {
    close: vi.fn(async () => undefined),
    execute: vi.fn(async (toolCall: ToolCallRequest) => ({
      content: `${name}:${toolCall.name}`,
      status: "completed" as const,
      toolName: toolCall.name,
    })),
    toolDefinitions: () => (available() ? [definition(name)] : []),
  };
}

describe("composeToolRuntimes", () => {
  it("merges definitions and routes calls through an explicit ownership map", async () => {
    const builtIn = runtime("read");
    const mcp = runtime("mcp_demo_lookup_issue");
    const composite = composeToolRuntimes([builtIn, mcp]);

    expect(composite.toolDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "mcp_demo_lookup_issue",
    ]);

    await composite.execute({ arguments: "{}", name: "mcp_demo_lookup_issue" });

    expect(mcp.execute).toHaveBeenCalledOnce();
    expect(builtIn.execute).not.toHaveBeenCalled();
  });

  it("keeps the last owner for a stale call after a dynamic runtime disappears", async () => {
    let available = true;
    const mcp = runtime("mcp_demo_lookup_issue", () => available);
    const composite = composeToolRuntimes([mcp]);

    expect(composite.toolDefinitions()).toHaveLength(1);
    available = false;
    expect(composite.toolDefinitions()).toEqual([]);

    await composite.execute({ arguments: "{}", name: "mcp_demo_lookup_issue" });

    expect(mcp.execute).toHaveBeenCalledOnce();
  });

  it("rejects duplicate exposed names instead of guessing an owner", () => {
    const composite = composeToolRuntimes([runtime("read"), runtime("read")]);

    expect(() => composite.toolDefinitions()).toThrow('Duplicate tool definition "read"');
  });

  it("closes every runtime once when close is called repeatedly", async () => {
    const first = runtime("read");
    const second = runtime("mcp_demo_lookup_issue");
    const composite = composeToolRuntimes([first, second]);

    await composite.close?.();
    await composite.close?.();

    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });
});
