import { findDangerousCommandReason } from "../tools/bashTool.js";
import type { ToolCallRequest } from "../tools/types.js";
import type { PermissionDecision, PermissionPolicy } from "./types.js";

interface BashArguments {
  command: string;
}

export function createDefaultPermissionPolicy(): PermissionPolicy {
  return {
    decide(toolCall) {
      return decideDefaultPermission(toolCall);
    },
  };
}

export function decideDefaultPermission(toolCall: ToolCallRequest): PermissionDecision {
  if (toolCall.name === "read" || toolCall.name === "ls") {
    return allow("inspect-only tool");
  }

  if (toolCall.name !== "bash") {
    return deny("unknown", `no permission rule for tool "${toolCall.name}"`);
  }

  const args = parseBashArguments(toolCall.arguments);

  if (!args) {
    return deny("unknown", "bash arguments must be JSON with a non-empty string command field");
  }

  const destructiveReason = findDangerousCommandReason(args.command);

  if (destructiveReason) {
    return deny("destructive", destructiveReason);
  }

  if (hasComplexShellShape(args.command)) {
    return ask("unknown", "bash command uses shell composition that requires approval");
  }

  if (isSimpleInspectCommand(args.command)) {
    return allow("inspect command");
  }

  return ask("mutating", "bash command may modify files or external state");
}

function allow(reason: string): PermissionDecision {
  return {
    action: "allow",
    reason,
    risk: "inspect",
  };
}

function ask(risk: "mutating" | "unknown", reason: string): PermissionDecision {
  return {
    action: "ask",
    reason,
    risk,
  };
}

function deny(risk: "destructive" | "unknown", reason: string): PermissionDecision {
  return {
    action: "deny",
    reason,
    risk,
  };
}

function parseBashArguments(rawArguments: string): BashArguments | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "command" in parsed &&
      typeof parsed.command === "string" &&
      parsed.command.trim().length > 0
    ) {
      return { command: parsed.command };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function hasComplexShellShape(command: string): boolean {
  return /(\|\||&&|[|;&<>`]|\$\(|\r|\n)/.test(command);
}

function isSimpleInspectCommand(command: string): boolean {
  const normalized = command.trim();

  if (/^pwd(?:\s|$)/.test(normalized)) {
    return true;
  }

  if (/^(?:ls|cat|head|tail|rg|grep)(?:\s|$)/.test(normalized)) {
    return true;
  }

  if (/^sed\s+-n(?:\s|$)/.test(normalized)) {
    return true;
  }

  return /^git\s+(?:status|log|diff|show)(?:\s|$)/.test(normalized);
}
