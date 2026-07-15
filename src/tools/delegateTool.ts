import type { ChildSessionProfile } from "../runtime/session.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

export interface ChildSessionRunRequest {
  maxToolRounds: number;
  parentCallId: string;
  parentRound: number;
  profile: ChildSessionProfile;
  task: string;
}

export interface ChildSessionRunResult {
  changedFiles?: string[];
  childSessionId: string;
  finalAnswer: string;
  profile: ChildSessionProfile;
  status: "completed" | "failed";
  tracePath: string;
  workspace?: {
    branch: string;
    path: string;
  };
}

export interface DelegateChildSessionRunner {
  run(request: ChildSessionRunRequest): Promise<ChildSessionRunResult>;
}

export interface CreateDelegateToolOptions {
  maxToolRounds: number;
  parentCallId?: () => string;
  parentRound?: () => number;
  runner: DelegateChildSessionRunner;
}

interface DelegateArguments {
  maxToolRounds?: number;
  profile: ChildSessionProfile;
  task: string;
}

export const delegateToolDefinition: ToolDefinition = {
  type: "function",
  name: "delegate",
  description: "Run a synchronous fresh child session with an explicit research or edit profile.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task: {
        type: "string",
        description: "The child task prompt. It may include leading slash skill invocations for the child session.",
      },
      profile: {
        type: "string",
        description: 'Child profile to run: "research" for read-only investigation, or "edit" for isolated file edits.',
        enum: ["research", "edit"],
      },
      maxToolRounds: {
        type: ["number", "null"],
        description: "Optional child tool round cap. Use null to inherit the parent maxToolRounds.",
      },
    },
    required: ["task", "profile", "maxToolRounds"],
  },
};

export function createDelegateTool(options: CreateDelegateToolOptions): RegisteredTool {
  return {
    definition: delegateToolDefinition,
    async handler(input) {
      const args = parseDelegateArguments(input.rawArguments);

      if (!args) {
        return failedDelegateResult(
          "delegate arguments must be JSON with non-empty string task, profile of research/edit, and optional integer maxToolRounds",
        );
      }

      const maxToolRounds = args.maxToolRounds ?? options.maxToolRounds;

      if (!Number.isInteger(maxToolRounds) || maxToolRounds < 1 || maxToolRounds > options.maxToolRounds) {
        return failedDelegateResult(`maxToolRounds must be an integer between 1 and ${options.maxToolRounds}`);
      }

      const parentCallId = input.callId ?? options.parentCallId?.();
      const parentRound = input.round ?? options.parentRound?.();

      if (!parentCallId || parentRound === undefined) {
        return failedDelegateResult("delegate requires parent tool call id and round context");
      }

      try {
        const result = await options.runner.run({
          maxToolRounds,
          parentCallId,
          parentRound,
          profile: args.profile,
          task: args.task,
        });

        if (result.status === "failed") {
          return {
            content: formatDelegateResult(result),
            status: "failed",
            toolName: "delegate",
          };
        }

        return {
          content: formatDelegateResult(result),
          status: "completed",
          toolName: "delegate",
          metadata: {
            childSession: result,
          },
        };
      } catch (error) {
        return failedDelegateResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function parseDelegateArguments(rawArguments: string): DelegateArguments | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "task" in parsed &&
      typeof parsed.task === "string" &&
      parsed.task.trim().length > 0 &&
      "profile" in parsed &&
      isChildProfile(parsed.profile) &&
      (!("maxToolRounds" in parsed) ||
        parsed.maxToolRounds === null ||
        (typeof parsed.maxToolRounds === "number" && Number.isInteger(parsed.maxToolRounds)))
    ) {
      const maxToolRounds =
        "maxToolRounds" in parsed && typeof parsed.maxToolRounds === "number" ? parsed.maxToolRounds : undefined;
      return {
        ...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
        profile: parsed.profile,
        task: parsed.task,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isChildProfile(value: unknown): value is ChildSessionProfile {
  return value === "research" || value === "edit";
}

function failedDelegateResult(reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    status: "failed",
    toolName: "delegate",
  };
}

function formatDelegateResult(result: ChildSessionRunResult): string {
  const lines = [
    `child_session_id: ${result.childSessionId}`,
    `profile: ${result.profile}`,
    `status: ${result.status}`,
    `trace_path: ${result.tracePath}`,
  ];

  if (result.workspace) {
    lines.push(`workspace_path: ${result.workspace.path}`);
    lines.push(`workspace_branch: ${result.workspace.branch}`);
  }

  if (result.changedFiles) {
    lines.push("changed_files:");
    lines.push(...(result.changedFiles.length > 0 ? result.changedFiles.map((file) => `- ${file}`) : ["(none)"]));
  }

  lines.push("handoff:");
  lines.push(result.finalAnswer);
  return lines.join("\n");
}
