import type {
  TeammateManager,
  TeammateSummary,
} from "../extensions/teammates.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

export interface CreateTeammateToolsOptions {
  actor: "leader" | string;
  manager: TeammateManager;
}

const teammateStartDefinition: ToolDefinition = {
  description: "Start a long-lived named teammate and dispatch its required first mailbox message.",
  name: "teammate_start",
  parameters: {
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      profile: { enum: ["research", "edit"], type: "string" },
      instructions: { type: "string" },
      message: { type: "string" },
      maxToolRounds: { type: ["number", "null"] },
    },
    required: ["name", "profile", "instructions", "message", "maxToolRounds"],
    type: "object",
  },
  strict: true,
  type: "function",
};

const teammateListDefinition: ToolDefinition = {
  description: "List long-lived teammates with lifecycle, session, unread, trace, and workspace summaries.",
  name: "teammate_list",
  parameters: {
    additionalProperties: false,
    properties: {},
    required: [],
    type: "object",
  },
  strict: true,
  type: "function",
};

const teammateRejoinDefinition: ToolDefinition = {
  description:
    "Explicitly rejoin a failed teammate with a fresh session and a required recovery message. Rejoin does not unblock tasks already frozen by owner failure.",
  name: "teammate_rejoin",
  parameters: {
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      recovery: { type: "string" },
    },
    required: ["name", "recovery"],
    type: "object",
  },
  strict: true,
  type: "function",
};

const teammateShutdownDefinition: ToolDefinition = {
  description: "Explicitly stop or retire one idle long-lived teammate.",
  name: "teammate_shutdown",
  parameters: {
    additionalProperties: false,
    properties: {
      mode: { enum: ["shutdown", "retire"], type: "string" },
      name: { type: "string" },
    },
    required: ["name", "mode"],
    type: "object",
  },
  strict: true,
  type: "function",
};

const messageSendDefinition: ToolDefinition = {
  description: "Send a non-empty direct mailbox message to another teammate or the Leader.",
  name: "message_send",
  parameters: {
    additionalProperties: false,
    properties: {
      to: { type: "string" },
      content: { type: "string" },
    },
    required: ["to", "content"],
    type: "object",
  },
  strict: true,
  type: "function",
};

const messageBroadcastDefinition: ToolDefinition = {
  description: "Broadcast a non-empty message from the Leader to a fixed snapshot of teammates.",
  name: "message_broadcast",
  parameters: {
    additionalProperties: false,
    properties: {
      content: { type: "string" },
    },
    required: ["content"],
    type: "object",
  },
  strict: true,
  type: "function",
};

export function createTeammateTools(options: CreateTeammateToolsOptions): RegisteredTool[] {
  const shared = [
    createListTool(options.manager),
    createSendTool(options.actor, options.manager),
  ];
  if (options.actor !== "leader") {
    return shared;
  }
  return [
    createStartTool(options.manager),
    shared[0] as RegisteredTool,
    createRejoinTool(options.manager),
    createShutdownTool(options.manager),
    shared[1] as RegisteredTool,
    createBroadcastTool(options.manager),
  ];
}

function createStartTool(manager: TeammateManager): RegisteredTool {
  return {
    definition: teammateStartDefinition,
    async handler(input) {
      const args = parseStartArguments(input.rawArguments);
      if (!args) {
        return failed(
          "teammate_start",
          "arguments must include name, research/edit profile, non-empty instructions/message, and optional maxToolRounds",
        );
      }
      const summary = await manager.start(args);
      return completed("teammate_start", formatSummary(summary), { teammate: summary });
    },
  };
}

function createShutdownTool(manager: TeammateManager): RegisteredTool {
  return {
    definition: teammateShutdownDefinition,
    async handler(input) {
      const args = parseObject(input.rawArguments);
      if (
        !args
        || !hasExactKeys(args, ["mode", "name"])
        || !isNonEmptyString(args.name)
        || (args.mode !== "shutdown" && args.mode !== "retire")
      ) {
        return failed("teammate_shutdown", "arguments must include name and shutdown/retire mode");
      }
      const summary = await manager.shutdown({
        mode: args.mode,
        name: args.name.trim(),
      });
      return completed("teammate_shutdown", formatSummary(summary), { teammate: summary });
    },
  };
}

function createListTool(manager: TeammateManager): RegisteredTool {
  return {
    definition: teammateListDefinition,
    async handler(input) {
      if (!isEmptyObjectArguments(input.rawArguments)) {
        return failed("teammate_list", "arguments must be an empty object");
      }
      const members = await manager.list();
      return completed(
        "teammate_list",
        members.length === 0
          ? "teammates: (none)"
          : ["teammates:", ...members.map((member) => indent(formatSummary(member)))].join("\n"),
        { teammates: members },
      );
    },
  };
}

function createRejoinTool(manager: TeammateManager): RegisteredTool {
  return {
    definition: teammateRejoinDefinition,
    async handler(input) {
      const args = parseObject(input.rawArguments);
      if (
        !args
        || !hasExactKeys(args, ["name", "recovery"])
        || !isNonEmptyString(args.name)
        || !isNonEmptyString(args.recovery)
      ) {
        return failed("teammate_rejoin", "arguments must include non-empty name and recovery");
      }
      const summary = await manager.rejoin({
        name: args.name.trim(),
        recovery: args.recovery.trim(),
      });
      return completed("teammate_rejoin", formatSummary(summary), { teammate: summary });
    },
  };
}

function createSendTool(actor: string, manager: TeammateManager): RegisteredTool {
  return {
    definition: messageSendDefinition,
    async handler(input) {
      const args = parseObject(input.rawArguments);
      if (
        !args
        || !hasExactKeys(args, ["content", "to"])
        || !isNonEmptyString(args.content)
        || !isNonEmptyString(args.to)
      ) {
        return failed("message_send", "arguments must include non-empty to and content");
      }
      const result = await manager.sendMessage({
        content: args.content.trim(),
        from: actor,
        to: args.to.trim(),
      });
      return completed(
        "message_send",
        [
          `message_id: ${result.messageId}`,
          `to: ${result.to}`,
          `delivery: ${result.delivery}`,
        ].join("\n"),
        { mailboxDelivery: result },
      );
    },
  };
}

function createBroadcastTool(manager: TeammateManager): RegisteredTool {
  return {
    definition: messageBroadcastDefinition,
    async handler(input) {
      const args = parseObject(input.rawArguments);
      if (
        !args
        || !hasExactKeys(args, ["content"])
        || !isNonEmptyString(args.content)
      ) {
        return failed("message_broadcast", "arguments must include non-empty content");
      }
      const result = await manager.broadcast({
        content: args.content.trim(),
        from: "leader",
      });
      const lines = [
        `delivered: ${result.delivered.length}`,
        ...result.delivered.map((delivery) =>
          `- ${delivery.to}: ${delivery.delivery} (${delivery.messageId})`
        ),
        `failed: ${result.failed.length}`,
        ...result.failed.map((failure) => `- ${failure.to}: ${failure.reason}`),
      ];
      return completed("message_broadcast", lines.join("\n"), { broadcast: result });
    },
  };
}

function parseStartArguments(raw: string): {
  instructions: string;
  maxToolRounds?: number;
  message: string;
  name: string;
  profile: "research" | "edit";
} | undefined {
  const args = parseObject(raw);
  if (
    !args
    || Object.keys(args).some(
      (key) => !["instructions", "maxToolRounds", "message", "name", "profile"].includes(key),
    )
    || !isNonEmptyString(args.name)
    || !isNonEmptyString(args.instructions)
    || !isNonEmptyString(args.message)
    || (args.profile !== "research" && args.profile !== "edit")
    || (
      args.maxToolRounds !== undefined
      && args.maxToolRounds !== null
      && (!Number.isSafeInteger(args.maxToolRounds) || (args.maxToolRounds as number) < 1)
    )
  ) {
    return undefined;
  }
  return {
    instructions: args.instructions.trim(),
    ...(typeof args.maxToolRounds === "number" ? { maxToolRounds: args.maxToolRounds } : {}),
    message: args.message.trim(),
    name: args.name.trim(),
    profile: args.profile,
  };
}

function formatSummary(summary: TeammateSummary): string {
  return [
    `name: ${summary.name}`,
    `profile: ${summary.profile}`,
    `state: ${summary.state}`,
    `session_id: ${summary.sessionId}`,
    `unread_count: ${summary.unreadCount}`,
    `trace_path: ${summary.tracePath}`,
    ...(summary.workspace
      ? [
          `workspace_path: ${summary.workspace.path}`,
          `workspace_branch: ${summary.workspace.branch}`,
        ]
      : []),
    ...(summary.failure ? [`failure: ${summary.failure}`] : []),
  ].join("\n");
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function completed(
  toolName: string,
  content: string,
  metadata?: Record<string, unknown>,
): ToolResult {
  return {
    content,
    ...(metadata ? { metadata } : {}),
    status: "completed",
    toolName,
  };
}

function failed(toolName: string, reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    status: "failed",
    toolName,
  };
}

function isEmptyObjectArguments(raw: string): boolean {
  const value = parseObject(raw);
  return value !== undefined && Object.keys(value).length === 0;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
