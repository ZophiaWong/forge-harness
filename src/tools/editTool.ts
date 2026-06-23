import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";

import { formatFileChangeResult } from "./fileChangeResult.js";
import { resolvePathInsideCwd } from "./pathBoundary.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

interface EditToolArguments {
  newText: string;
  oldText: string;
  path: string;
}

const EDIT_TOOL_NAME = "edit";

export const editToolDefinition: ToolDefinition = {
  type: "function",
  name: EDIT_TOOL_NAME,
  description: "Replace one exact text match inside a UTF-8 file in the current project directory.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Path to the text file to edit, relative to the current project directory.",
      },
      oldText: {
        type: "string",
        description: "Exact text to replace. It must appear exactly once in the file.",
      },
      newText: {
        type: "string",
        description: "Replacement text. Use an empty string to delete oldText.",
      },
    },
    required: ["path", "oldText", "newText"],
  },
};

export function createEditTool(cwd: string): RegisteredTool {
  return {
    definition: editToolDefinition,
    async handler({ rawArguments }) {
      const args = parseEditToolArguments(rawArguments);

      if (!args) {
        return failedEditResult(
          "edit arguments must be JSON with non-empty string path and oldText fields, and a string newText field",
        );
      }

      const boundedPath = resolvePathInsideCwd(cwd, args.path);

      if (!boundedPath) {
        return {
          content: `blocked_reason: path "${args.path}" is outside the current working directory`,
          status: "blocked",
          toolName: EDIT_TOOL_NAME,
        };
      }

      try {
        const stat = await fs.stat(boundedPath.absolutePath);

        if (stat.isDirectory()) {
          return failedEditResult(`path "${args.path}" is a directory`);
        }

        if (!stat.isFile()) {
          return failedEditResult(`path "${args.path}" is not a regular file`);
        }

        const buffer = await fs.readFile(boundedPath.absolutePath);

        if (!isUtf8(buffer)) {
          return failedEditResult(`path "${args.path}" is not valid UTF-8 text`);
        }

        const beforeText = buffer.toString("utf8");
        const match = findUniqueMatch(beforeText, args.oldText);

        if (match.count === 0) {
          return failedEditResult(`oldText was not found in path "${args.path}"`);
        }

        if (match.count > 1) {
          return failedEditResult(`oldText matched ${match.count} times in path "${args.path}"; expected exactly one match`);
        }

        const afterText =
          beforeText.slice(0, match.index) + args.newText + beforeText.slice(match.index + args.oldText.length);

        await fs.writeFile(boundedPath.absolutePath, afterText, "utf8");

        return {
          content: formatFileChangeResult({
            action: "edited",
            afterText,
            beforeText,
            path: boundedPath.relativePath,
          }),
          metadata: {
            action: "edited",
            path: boundedPath.relativePath,
          },
          status: "completed",
          toolName: EDIT_TOOL_NAME,
        };
      } catch (error) {
        return failedEditResult(formatFileError(args.path, error));
      }
    },
  };
}

function parseEditToolArguments(rawArguments: string): EditToolArguments | undefined {
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

function findUniqueMatch(text: string, oldText: string): { count: number; index: number } {
  let count = 0;
  let index = -1;
  let searchFrom = 0;

  while (true) {
    const nextIndex = text.indexOf(oldText, searchFrom);

    if (nextIndex === -1) {
      return { count, index };
    }

    count += 1;
    index = nextIndex;
    searchFrom = nextIndex + oldText.length;
  }
}

function failedEditResult(reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    status: "failed",
    toolName: EDIT_TOOL_NAME,
  };
}

function formatFileError(requestedPath: string, error: unknown): string {
  if (isNodeError(error) && error.code === "ENOENT") {
    return `path "${requestedPath}" does not exist`;
  }

  if (isNodeError(error) && error.code === "EACCES") {
    return `permission denied editing "${requestedPath}"`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
