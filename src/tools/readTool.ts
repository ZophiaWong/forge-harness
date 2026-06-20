import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";

import { resolvePathInsideCwd } from "./pathBoundary.js";
import { DEFAULT_TEXT_OUTPUT_CHAR_LIMIT, truncateText } from "./text.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

interface ReadToolArguments {
  path: string;
}

const READ_TOOL_NAME = "read";

export const readToolDefinition: ToolDefinition = {
  type: "function",
  name: READ_TOOL_NAME,
  description: "Read a UTF-8 text file inside the current project directory with line numbers.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Path to the text file to read, relative to the current project directory.",
      },
    },
    required: ["path"],
  },
};

export function createReadTool(cwd: string): RegisteredTool {
  return {
    definition: readToolDefinition,
    async handler({ rawArguments }) {
      const args = parseReadToolArguments(rawArguments);

      if (!args) {
        return failedReadResult("read arguments must be JSON with a non-empty string path field");
      }

      const boundedPath = resolvePathInsideCwd(cwd, args.path);

      if (!boundedPath) {
        return {
          content: `blocked_reason: path "${args.path}" is outside the current working directory`,
          status: "blocked",
          toolName: READ_TOOL_NAME,
        };
      }

      try {
        const stat = await fs.stat(boundedPath.absolutePath);

        if (stat.isDirectory()) {
          return failedReadResult(`path "${args.path}" is a directory; use ls instead`);
        }

        if (!stat.isFile()) {
          return failedReadResult(`path "${args.path}" is not a regular file`);
        }

        const buffer = await fs.readFile(boundedPath.absolutePath);

        if (!isUtf8(buffer)) {
          return failedReadResult(`path "${args.path}" is not valid UTF-8 text`);
        }

        const text = buffer.toString("utf8");
        const numberedLines = text.split(/\r?\n/).map((line, index) => `${index + 1} | ${line}`);
        const body = truncateText(numberedLines.join("\n"), DEFAULT_TEXT_OUTPUT_CHAR_LIMIT);

        return {
          content: [`path: ${boundedPath.relativePath}`, "content:", body || "(empty)"].join("\n"),
          metadata: {
            path: boundedPath.relativePath,
            sizeBytes: stat.size,
          },
          status: "completed",
          toolName: READ_TOOL_NAME,
        };
      } catch (error) {
        return failedReadResult(formatFileError(args.path, error));
      }
    },
  };
}

function parseReadToolArguments(rawArguments: string): ReadToolArguments | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "path" in parsed &&
      typeof parsed.path === "string" &&
      parsed.path.trim().length > 0
    ) {
      return { path: parsed.path };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function failedReadResult(reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    status: "failed",
    toolName: READ_TOOL_NAME,
  };
}

function formatFileError(requestedPath: string, error: unknown): string {
  if (isNodeError(error) && error.code === "ENOENT") {
    return `path "${requestedPath}" does not exist`;
  }

  if (isNodeError(error) && error.code === "EACCES") {
    return `permission denied reading "${requestedPath}"`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
