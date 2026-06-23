import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";

import { formatFileChangeResult } from "./fileChangeResult.js";
import { resolvePathInsideCwd } from "./pathBoundary.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

interface WriteToolArguments {
  content: string;
  path: string;
}

const WRITE_TOOL_NAME = "write";

export const writeToolDefinition: ToolDefinition = {
  type: "function",
  name: WRITE_TOOL_NAME,
  description: "Create or overwrite one UTF-8 text file inside the current project directory.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Path to the text file to create or overwrite, relative to the current project directory.",
      },
      content: {
        type: "string",
        description: "Full UTF-8 text content to write. Use an empty string to clear the file.",
      },
    },
    required: ["path", "content"],
  },
};

export function createWriteTool(cwd: string): RegisteredTool {
  return {
    definition: writeToolDefinition,
    async handler({ rawArguments }) {
      const args = parseWriteToolArguments(rawArguments);

      if (!args) {
        return failedWriteResult("write arguments must be JSON with non-empty string path and string content fields");
      }

      const boundedPath = resolvePathInsideCwd(cwd, args.path);

      if (!boundedPath) {
        return {
          content: `blocked_reason: path "${args.path}" is outside the current working directory`,
          status: "blocked",
          toolName: WRITE_TOOL_NAME,
        };
      }

      try {
        const parentPath = path.dirname(boundedPath.absolutePath);
        const parentStat = await fs.stat(parentPath).catch((error: unknown) => {
          if (isNodeError(error) && error.code === "ENOENT") {
            return undefined;
          }

          throw error;
        });

        if (!parentStat) {
          return failedWriteResult(`parent directory for path "${args.path}" does not exist`);
        }

        if (!parentStat.isDirectory()) {
          return failedWriteResult(`parent path for "${args.path}" is not a directory`);
        }

        const existing = await readExistingText(boundedPath.absolutePath, args.path);

        if (existing.status === "failed") {
          return failedWriteResult(existing.reason);
        }

        await fs.writeFile(boundedPath.absolutePath, args.content, "utf8");

        const action = existing.existed ? "overwritten" : "created";

        return {
          content: formatFileChangeResult({
            action,
            afterText: args.content,
            beforeText: existing.text,
            path: boundedPath.relativePath,
          }),
          metadata: {
            action,
            path: boundedPath.relativePath,
          },
          status: "completed",
          toolName: WRITE_TOOL_NAME,
        };
      } catch (error) {
        return failedWriteResult(formatFileError(args.path, error));
      }
    },
  };
}

function parseWriteToolArguments(rawArguments: string): WriteToolArguments | undefined {
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

type ExistingTextResult =
  | {
      existed: false;
      status: "completed";
      text: "";
    }
  | {
      existed: true;
      status: "completed";
      text: string;
    }
  | {
      reason: string;
      status: "failed";
    };

async function readExistingText(absolutePath: string, requestedPath: string): Promise<ExistingTextResult> {
  const stat = await fs.stat(absolutePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });

  if (!stat) {
    return {
      existed: false,
      status: "completed",
      text: "",
    };
  }

  if (stat.isDirectory()) {
    return {
      reason: `path "${requestedPath}" is a directory`,
      status: "failed",
    };
  }

  if (!stat.isFile()) {
    return {
      reason: `path "${requestedPath}" is not a regular file`,
      status: "failed",
    };
  }

  const buffer = await fs.readFile(absolutePath);

  if (!isUtf8(buffer)) {
    return {
      reason: `path "${requestedPath}" is not valid UTF-8 text`,
      status: "failed",
    };
  }

  return {
    existed: true,
    status: "completed",
    text: buffer.toString("utf8"),
  };
}

function failedWriteResult(reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    status: "failed",
    toolName: WRITE_TOOL_NAME,
  };
}

function formatFileError(requestedPath: string, error: unknown): string {
  if (isNodeError(error) && error.code === "EACCES") {
    return `permission denied writing "${requestedPath}"`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
