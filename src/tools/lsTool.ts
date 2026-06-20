import { promises as fs } from "node:fs";

import { resolvePathInsideCwd } from "./pathBoundary.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

interface LsToolArguments {
  path: string;
}

const LS_TOOL_NAME = "ls";
const MAX_LS_ENTRIES = 100;

export const lsToolDefinition: ToolDefinition = {
  type: "function",
  name: LS_TOOL_NAME,
  description: "List one directory level inside the current project directory.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Directory path to list, relative to the current project directory. Defaults to '.'.",
      },
    },
    required: [],
  },
};

export function createLsTool(cwd: string): RegisteredTool {
  return {
    definition: lsToolDefinition,
    async handler({ rawArguments }) {
      const args = parseLsToolArguments(rawArguments);

      if (!args) {
        return failedLsResult("ls arguments must be JSON with an optional string path field");
      }

      const boundedPath = resolvePathInsideCwd(cwd, args.path);

      if (!boundedPath) {
        return {
          content: `blocked_reason: path "${args.path}" is outside the current working directory`,
          status: "blocked",
          toolName: LS_TOOL_NAME,
        };
      }

      try {
        const stat = await fs.stat(boundedPath.absolutePath);

        if (!stat.isDirectory()) {
          return failedLsResult(`path "${args.path}" is not a directory`);
        }

        const entries = await fs.readdir(boundedPath.absolutePath, { withFileTypes: true });
        const sorted = entries.sort((left, right) => {
          const typeOrder = Number(right.isDirectory()) - Number(left.isDirectory());

          if (typeOrder !== 0) {
            return typeOrder;
          }

          return left.name.localeCompare(right.name);
        });
        const visibleEntries = sorted.slice(0, MAX_LS_ENTRIES);
        const lines = visibleEntries.map((entry) => `[${entry.isDirectory() ? "dir" : "file"}] ${entry.name}`);

        if (sorted.length > visibleEntries.length) {
          lines.push(`[truncated ${sorted.length - visibleEntries.length} entries]`);
        }

        return {
          content: [`path: ${boundedPath.relativePath}`, "entries:", lines.join("\n") || "(empty)"].join("\n"),
          metadata: {
            entryCount: sorted.length,
            path: boundedPath.relativePath,
          },
          status: "completed",
          toolName: LS_TOOL_NAME,
        };
      } catch (error) {
        return failedLsResult(formatFileError(args.path, error));
      }
    },
  };
}

function parseLsToolArguments(rawArguments: string): LsToolArguments | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (typeof parsed === "object" && parsed !== null) {
      if (!("path" in parsed) || parsed.path === undefined) {
        return { path: "." };
      }

      if (typeof parsed.path === "string" && parsed.path.trim().length > 0) {
        return { path: parsed.path };
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function failedLsResult(reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    status: "failed",
    toolName: LS_TOOL_NAME,
  };
}

function formatFileError(requestedPath: string, error: unknown): string {
  if (isNodeError(error) && error.code === "ENOENT") {
    return `path "${requestedPath}" does not exist`;
  }

  if (isNodeError(error) && error.code === "EACCES") {
    return `permission denied listing "${requestedPath}"`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
