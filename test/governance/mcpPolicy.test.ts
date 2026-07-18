import { describe, expect, it } from "vitest";

import { createDefaultPermissionPolicy } from "../../src/governance/defaultPolicy.js";
import { createMcpPermissionPolicy } from "../../src/governance/mcpPolicy.js";
import type { PermissionDecision } from "../../src/governance/types.js";

const policies = new Map<string, PermissionDecision>([
  [
    "mcp_demo_lookup_issue",
    {
      action: "allow",
      reason: "read deterministic demo issue data",
      risk: "inspect",
    },
  ],
  [
    "mcp_demo_create_note",
    {
      action: "ask",
      reason: "write a note to the demo store",
      risk: "mutating",
    },
  ],
]);

const policy = createMcpPermissionPolicy(createDefaultPermissionPolicy(), policies);

function decide(name: string, argumentsText: string) {
  return policy.decide({ arguments: argumentsText, name });
}

describe("createMcpPermissionPolicy", () => {
  it("uses the configured allow and ask decisions for exact exposed names", () => {
    expect(decide("mcp_demo_lookup_issue", '{"issueId":"FH-16"}')).toEqual(policies.get("mcp_demo_lookup_issue"));
    expect(decide("mcp_demo_create_note", '{"issueId":"FH-16","body":"hello"}')).toEqual(
      policies.get("mcp_demo_create_note"),
    );
  });

  it.each(["not-json", "null", "[]", '"text"'])(
    "denies malformed MCP arguments before policy evaluation: %s",
    (argumentsText) => {
      expect(decide("mcp_demo_create_note", argumentsText)).toEqual({
        action: "deny",
        reason: 'MCP tool "mcp_demo_create_note" arguments must be a JSON object',
        risk: "unknown",
      });
    },
  );

  it("does not infer MCP ownership from a name prefix", () => {
    expect(decide("mcp_demo_unknown", "{}")).toEqual({
      action: "deny",
      reason: 'no permission rule for tool "mcp_demo_unknown"',
      risk: "unknown",
    });
  });

  it("delegates built-in tools to the existing policy", () => {
    expect(decide("read", '{"path":"README.md"}')).toMatchObject({
      action: "allow",
      risk: "inspect",
    });
  });
});
