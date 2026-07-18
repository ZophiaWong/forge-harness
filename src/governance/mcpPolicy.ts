import type { ToolCallRequest } from "../tools/types.js";
import type { PermissionDecision, PermissionPolicy } from "./types.js";

export function createMcpPermissionPolicy(
  fallback: PermissionPolicy,
  mcpPolicies: ReadonlyMap<string, PermissionDecision>,
): PermissionPolicy {
  return {
    decide(toolCall) {
      const decision = mcpPolicies.get(toolCall.name);

      if (!decision) {
        return fallback.decide(toolCall);
      }

      if (!hasObjectArguments(toolCall)) {
        return {
          action: "deny",
          reason: `MCP tool "${toolCall.name}" arguments must be a JSON object`,
          risk: "unknown",
        };
      }

      return { ...decision };
    },
  };
}

function hasObjectArguments(toolCall: ToolCallRequest): boolean {
  try {
    const value: unknown = JSON.parse(toolCall.arguments);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
