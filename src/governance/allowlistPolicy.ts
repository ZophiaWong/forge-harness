import { isDeepStrictEqual } from "node:util";

import type {
  PermissionAllowlistRule,
  PermissionPolicy,
} from "./types.js";

export function createAllowlistPermissionPolicy(
  base: PermissionPolicy,
  rules: PermissionAllowlistRule[],
): PermissionPolicy {
  return {
    decide(toolCall) {
      const argumentsValue = parseArguments(toolCall.arguments);
      const allowed = argumentsValue !== undefined && rules.some((rule) => (
        rule.name === toolCall.name
        && Object.entries(rule.arguments ?? {}).every(([key, expected]) => (
          isDeepStrictEqual(argumentsValue[key], expected)
        ))
      ));
      if (!allowed) {
        return {
          action: "deny",
          reason: `tool call is outside the configured allowlist for ${toolCall.name}`,
          risk: "unknown",
        };
      }
      return base.decide(toolCall);
    },
  };
}

function parseArguments(source: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(source);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
