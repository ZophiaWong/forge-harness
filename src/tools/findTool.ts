import { promises as fs } from "node:fs";
import path from "node:path";

import { resolvePathInsideCwd } from "./pathBoundary.js";
import { formatQuoted, formatSearchSummary, MAX_SEARCH_MATCHES, walkSearchDirectory } from "./search.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

interface FindToolArguments {
  path: string;
  query: string;
}

const FIND_TOOL_NAME = "find";

export const findToolDefinition: ToolDefinition = {
  type: "function",
  name: FIND_TOOL_NAME,
  description: "Find project files whose filename contains a literal, case-sensitive query.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Directory path to search, relative to the current project directory. Defaults to '.'.",
      },
      query: {
        type: "string",
        description: "Literal case-sensitive filename text to search for.",
      },
    },
    required: ["query"],
  },
};

export function createFindTool(cwd: string): RegisteredTool {
  return {
    definition: findToolDefinition,
    async handler({ rawArguments }) {
      const args = parseFindToolArguments(rawArguments);

      if (!args) {
        return failedFindResult("find arguments must be JSON with a non-empty string query field and optional string path field");
      }

      const boundedPath = resolvePathInsideCwd(cwd, args.path);

      if (!boundedPath) {
        return blockedFindResult(`path "${args.path}" is outside the current working directory`);
      }

      try {
        const stat = await fs.stat(boundedPath.absolutePath);

        if (!stat.isDirectory()) {
          return failedFindResult(`path "${args.path}" is not a directory`);
        }

        const files = await walkSearchDirectory(boundedPath);
        const matchingFiles = files.files
          .filter((file) => path.basename(file.relativePath).includes(args.query))
          .map((file) => file.relativePath);
        const visibleFiles = matchingFiles.slice(0, MAX_SEARCH_MATCHES);

        return completedFindResult(args, visibleFiles, matchingFiles.length);
      } catch (error) {
        return failedFindResult(formatFileError(args.path, error));
      }
    },
  };
}

function parseFindToolArguments(rawArguments: string): FindToolArguments | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "query" in parsed &&
      typeof parsed.query === "string" &&
      parsed.query.length > 0
    ) {
      if (!("path" in parsed) || parsed.path === undefined) {
        return {
          path: ".",
          query: parsed.query,
        };
      }

      if (typeof parsed.path === "string" && parsed.path.trim().length > 0) {
        return {
          path: parsed.path,
          query: parsed.query,
        };
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function completedFindResult(args: FindToolArguments, visibleFiles: string[], totalMatches: number): ToolResult {
  const omittedMatches = Math.max(totalMatches - visibleFiles.length, 0);
  const lines = [
    `query: ${formatQuoted(args.query)}`,
    `path: ${args.path}`,
    `matches_returned: ${visibleFiles.length}`,
    `matches_total: ${totalMatches}`,
    `omitted_matches: ${omittedMatches}`,
    "files:",
  ];

  lines.push(...(visibleFiles.length > 0 ? visibleFiles : ["(none)"]));

  return {
    content: lines.join("\n"),
    metadata: {
      matchesReturned: visibleFiles.length,
      matchesTotal: totalMatches,
      observationSummary: formatSearchSummary("find", totalMatches, args.query),
      omittedMatches,
    },
    status: "completed",
    toolName: FIND_TOOL_NAME,
  };
}

function blockedFindResult(reason: string): ToolResult {
  return {
    content: `blocked_reason: ${reason}`,
    metadata: {
      observationSummary: "find blocked",
    },
    status: "blocked",
    toolName: FIND_TOOL_NAME,
  };
}

function failedFindResult(reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    metadata: {
      observationSummary: "find failed",
    },
    status: "failed",
    toolName: FIND_TOOL_NAME,
  };
}

function formatFileError(requestedPath: string, error: unknown): string {
  if (isNodeError(error) && error.code === "ENOENT") {
    return `path "${requestedPath}" does not exist`;
  }

  if (isNodeError(error) && error.code === "EACCES") {
    return `permission denied finding files under "${requestedPath}"`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
