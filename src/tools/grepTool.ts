import { resolvePathInsideCwd } from "./pathBoundary.js";
import {
  formatQuoted,
  formatSearchSummary,
  MAX_SEARCH_MATCHES,
  readUtf8File,
  truncateMatchLine,
  walkSearchFiles,
} from "./search.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

interface GrepToolArguments {
  path: string;
  query: string;
}

interface GrepMatch {
  lineNumber: number;
  lineText: string;
  path: string;
}

const GREP_TOOL_NAME = "grep";

export const grepToolDefinition: ToolDefinition = {
  type: "function",
  name: GREP_TOOL_NAME,
  description: "Search UTF-8 project files for a literal, case-sensitive text query.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "File or directory path to search, relative to the current project directory. Defaults to '.'.",
      },
      query: {
        type: "string",
        description: "Literal case-sensitive text to search for.",
      },
    },
    required: ["query"],
  },
};

export function createGrepTool(cwd: string): RegisteredTool {
  return {
    definition: grepToolDefinition,
    async handler({ rawArguments }) {
      const args = parseGrepToolArguments(rawArguments);

      if (!args) {
        return failedGrepResult("grep arguments must be JSON with a non-empty string query field and optional string path field");
      }

      const boundedPath = resolvePathInsideCwd(cwd, args.path);

      if (!boundedPath) {
        return blockedGrepResult(`path "${args.path}" is outside the current working directory`);
      }

      try {
        const files = await walkSearchFiles(boundedPath);
        const matches: GrepMatch[] = [];
        let totalMatches = 0;
        let skippedBinaryFiles = 0;

        for (const file of files.files) {
          const readResult = await readUtf8File(file);

          if ("skipped" in readResult) {
            skippedBinaryFiles += 1;
            continue;
          }

          const lines = readResult.text.split(/\r?\n/);

          for (const [index, line] of lines.entries()) {
            if (!line.includes(args.query)) {
              continue;
            }

            totalMatches += 1;

            if (matches.length < MAX_SEARCH_MATCHES) {
              matches.push({
                lineNumber: index + 1,
                lineText: truncateMatchLine(line),
                path: file.relativePath,
              });
            }
          }
        }

        return completedGrepResult(args, matches, totalMatches, skippedBinaryFiles);
      } catch (error) {
        return failedGrepResult(formatFileError(args.path, error));
      }
    },
  };
}

function parseGrepToolArguments(rawArguments: string): GrepToolArguments | undefined {
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

function completedGrepResult(
  args: GrepToolArguments,
  matches: GrepMatch[],
  totalMatches: number,
  skippedBinaryFiles: number,
): ToolResult {
  const omittedMatches = Math.max(totalMatches - matches.length, 0);
  const lines = [
    `query: ${formatQuoted(args.query)}`,
    `path: ${args.path}`,
    `matches_returned: ${matches.length}`,
    `matches_total: ${totalMatches}`,
    `omitted_matches: ${omittedMatches}`,
    `skipped_binary_files: ${skippedBinaryFiles}`,
    "matches:",
  ];

  lines.push(
    ...(matches.length > 0 ? matches.map((match) => `${match.path}:${match.lineNumber} | ${match.lineText}`) : ["(none)"]),
  );

  return {
    content: lines.join("\n"),
    metadata: {
      matchesReturned: matches.length,
      matchesTotal: totalMatches,
      observationSummary: formatSearchSummary("grep", totalMatches, args.query),
      omittedMatches,
      skippedBinaryFiles,
    },
    status: "completed",
    toolName: GREP_TOOL_NAME,
  };
}

function blockedGrepResult(reason: string): ToolResult {
  return {
    content: `blocked_reason: ${reason}`,
    metadata: {
      observationSummary: "grep blocked",
    },
    status: "blocked",
    toolName: GREP_TOOL_NAME,
  };
}

function failedGrepResult(reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    metadata: {
      observationSummary: "grep failed",
    },
    status: "failed",
    toolName: GREP_TOOL_NAME,
  };
}

function formatFileError(requestedPath: string, error: unknown): string {
  if (isNodeError(error) && error.code === "ENOENT") {
    return `path "${requestedPath}" does not exist`;
  }

  if (isNodeError(error) && error.code === "EACCES") {
    return `permission denied searching "${requestedPath}"`;
  }

  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
