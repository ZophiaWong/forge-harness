import { findDangerousCommandReason } from "../tools/bashTool.js";
import type { ToolCallRequest } from "../tools/types.js";
import type { PermissionDecision, PermissionPolicy } from "./types.js";

interface BashArguments {
  command: string;
}

interface EditArguments {
  newText: string;
  oldText: string;
  path: string;
}

interface WriteArguments {
  content: string;
  path: string;
}

export function createDefaultPermissionPolicy(): PermissionPolicy {
  return {
    decide(toolCall) {
      return decideDefaultPermission(toolCall);
    },
  };
}

export function decideDefaultPermission(toolCall: ToolCallRequest): PermissionDecision {
  if (
    toolCall.name === "read" ||
    toolCall.name === "ls" ||
    toolCall.name === "grep" ||
    toolCall.name === "find"
  ) {
    return allow("inspect-only tool");
  }

  if (toolCall.name === "todo") {
    return {
      action: "allow",
      reason: "runtime task state update",
      risk: "mutating",
    };
  }

  if (toolCall.name === "edit") {
    const args = parseEditArguments(toolCall.arguments);

    if (!args) {
      return deny("unknown", "edit arguments must be JSON with non-empty string path and oldText fields, and a string newText field");
    }

    return ask("mutating", "file edit may modify project files");
  }

  if (toolCall.name === "write") {
    const args = parseWriteArguments(toolCall.arguments);

    if (!args) {
      return deny("unknown", "write arguments must be JSON with non-empty string path and string content fields");
    }

    return ask("mutating", "file write may modify project files");
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

function parseEditArguments(rawArguments: string): EditArguments | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "path" in parsed &&
      typeof parsed.path === "string" &&
      parsed.path.trim().length > 0 &&
      "oldText" in parsed &&
      typeof parsed.oldText === "string" &&
      parsed.oldText.length > 0 &&
      "newText" in parsed &&
      typeof parsed.newText === "string"
    ) {
      return {
        newText: parsed.newText,
        oldText: parsed.oldText,
        path: parsed.path,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseWriteArguments(rawArguments: string): WriteArguments | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "path" in parsed &&
      typeof parsed.path === "string" &&
      parsed.path.trim().length > 0 &&
      "content" in parsed &&
      typeof parsed.content === "string"
    ) {
      return {
        content: parsed.content,
        path: parsed.path,
      };
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
