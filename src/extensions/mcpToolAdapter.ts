import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { PermissionDecision } from "../governance/types.js";
import { DEFAULT_TEXT_OUTPUT_CHAR_LIMIT, truncateText } from "../tools/text.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import type { McpServerConfig } from "./mcpConfig.js";

const OPENAI_FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const OPENAI_FUNCTION_NAME_LIMIT = 64;

export interface DiscoveredMcpTool {
  description?: string;
  inputSchema: unknown;
  name: string;
}

export interface McpToolIncompatibility {
  rawToolName: string;
  reason: string;
}

export interface McpToolCatalogDiagnostics {
  deniedToolNames: string[];
  discoveredToolNames: string[];
  exposedToolNames: string[];
  extraToolNames: string[];
  incompatibleTools: McpToolIncompatibility[];
  missingToolNames: string[];
}

export interface McpToolCatalog {
  definitions: ToolDefinition[];
  diagnostics: McpToolCatalogDiagnostics;
  exposedToRaw: ReadonlyMap<string, string>;
  permissions: ReadonlyMap<string, PermissionDecision>;
}

export interface McpCallResultLike {
  content?: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export function createMcpToolCatalog(
  server: McpServerConfig,
  discoveredTools: DiscoveredMcpTool[],
): McpToolCatalog {
  const definitions: ToolDefinition[] = [];
  const exposedToRaw = new Map<string, string>();
  const permissions = new Map<string, PermissionDecision>();
  const incompatibleTools: McpToolIncompatibility[] = [];
  const deniedToolNames: string[] = [];
  const discoveredByName = new Map(discoveredTools.map((tool) => [tool.name, tool]));
  const discoveryCounts = countToolNames(discoveredTools);
  const discoveredToolNames = [...new Set(discoveredTools.map((tool) => tool.name))].sort(compareStrings);
  const configuredToolNames = Object.keys(server.tools).sort(compareStrings);
  const configuredNames = new Set(configuredToolNames);
  const exposedNames = new Set<string>();

  for (const rawToolName of configuredToolNames) {
    const configuredPolicy = server.tools[rawToolName];
    if (!configuredPolicy) {
      continue;
    }

    const exposedName = `mcp_${server.id}_${rawToolName}`;

    if (configuredPolicy.action === "deny") {
      deniedToolNames.push(exposedName);
      permissions.set(exposedName, { ...configuredPolicy });
      continue;
    }

    const discovered = discoveredByName.get(rawToolName);

    if (!discovered) {
      continue;
    }

    if ((discoveryCounts.get(rawToolName) ?? 0) > 1) {
      incompatibleTools.push({
        rawToolName,
        reason: `discovery returned duplicate tool name "${rawToolName}"`,
      });
      continue;
    }

    if (!hasObjectRoot(discovered.inputSchema)) {
      incompatibleTools.push({
        rawToolName,
        reason: "inputSchema must have an object root",
      });
      continue;
    }

    const nameError = validateExposedName(exposedName);

    if (nameError) {
      incompatibleTools.push({ rawToolName, reason: nameError });
      continue;
    }

    if (exposedNames.has(exposedName)) {
      incompatibleTools.push({
        rawToolName,
        reason: `exposed name "${exposedName}" conflicts with another MCP tool`,
      });
      continue;
    }

    exposedNames.add(exposedName);
    exposedToRaw.set(exposedName, rawToolName);
    permissions.set(exposedName, { ...configuredPolicy });
    definitions.push({
      description: discovered.description ?? `MCP tool ${rawToolName} from server ${server.id}.`,
      name: exposedName,
      parameters: discovered.inputSchema,
      strict: false,
      type: "function",
    });
  }

  return {
    definitions,
    diagnostics: {
      deniedToolNames,
      discoveredToolNames,
      exposedToolNames: definitions.map((tool) => tool.name).sort(compareStrings),
      extraToolNames: discoveredToolNames.filter((name) => !configuredNames.has(name)),
      incompatibleTools,
      missingToolNames: configuredToolNames.filter(
        (name) => server.tools[name]?.action !== "deny" && !discoveredByName.has(name),
      ),
    },
    exposedToRaw,
    permissions,
  };
}

export function projectMcpCallResult(
  serverId: string,
  rawToolName: string,
  exposedToolName: string,
  result: McpCallResultLike,
): ToolResult {
  const textBlocks: string[] = [];
  const omittedContentTypes = new Set<string>();

  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      textBlocks.push(block.text);
    } else {
      omittedContentTypes.add(block.type || "unknown");
    }
  }

  const contentParts = [...textBlocks];
  const hasStructuredContent = result.structuredContent !== undefined;
  if (hasStructuredContent) {
    contentParts.push("structured_content:", stableJsonStringify(result.structuredContent));
  }

  const omittedTypes = [...omittedContentTypes].sort();
  const hasSupportedContent = textBlocks.length > 0 || hasStructuredContent;
  let status: ToolResult["status"] = result.isError ? "failed" : "completed";

  if (omittedTypes.length > 0 && hasSupportedContent) {
    contentParts.push(`[omitted MCP content types: ${omittedTypes.join(", ")}]`);
  }

  if (!hasSupportedContent && omittedTypes.length > 0) {
    status = "failed";
    contentParts.push(`failed_reason: MCP result contained only unsupported content types: ${omittedTypes.join(", ")}`);
  } else if (!hasSupportedContent && result.isError) {
    contentParts.push("failed_reason: MCP tool reported an error without content");
  }

  return {
    content: truncateText(contentParts.join("\n"), DEFAULT_TEXT_OUTPUT_CHAR_LIMIT),
    metadata: {
      mcp: {
        ...(omittedTypes.length > 0 ? { omittedContentTypes: omittedTypes } : {}),
        rawToolName,
        serverId,
      },
      observationSummary: `MCP ${rawToolName} ${status}`,
    },
    status,
    toolName: exposedToolName,
  };
}

export function adaptMcpCallError(
  serverId: string,
  rawToolName: string,
  exposedToolName: string,
  error: unknown,
): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof McpError && error.code === ErrorCode.RequestTimeout ? "timed_out" : "failed";

  return {
    content: `failed_reason: ${message}`,
    metadata: {
      mcp: { rawToolName, serverId },
      observationSummary: `MCP ${rawToolName} ${status}`,
    },
    status,
    toolName: exposedToolName,
  };
}

function hasObjectRoot(value: unknown): value is ToolDefinition["parameters"] {
  return typeof value === "object" && value !== null && "type" in value && value.type === "object";
}

function validateExposedName(name: string): string | undefined {
  if (!OPENAI_FUNCTION_NAME_PATTERN.test(name)) {
    return `exposed name "${name}" does not satisfy the OpenAI function name pattern`;
  }

  if (name.length > OPENAI_FUNCTION_NAME_LIMIT) {
    return `exposed name "${name}" exceeds 64 characters`;
  }

  return undefined;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

function countToolNames(tools: DiscoveredMcpTool[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const tool of tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }

  return counts;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
