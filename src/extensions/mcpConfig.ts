import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { PermissionDecisionAction, PermissionRisk } from "../governance/types.js";

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 30_000;
export const MCP_PROJECT_CONFIG_PATH = path.join(".forge", "mcp.json");

export interface McpToolPolicyConfig {
  action: Extract<PermissionDecisionAction, "allow" | "ask">;
  reason: string;
  risk: PermissionRisk;
}

export interface McpServerConfig {
  args: string[];
  command: string;
  connectTimeoutMs: number;
  id: string;
  toolCallTimeoutMs: number;
  tools: Record<string, McpToolPolicyConfig>;
}

export interface McpProjectConfig {
  configPath: string;
  server: McpServerConfig;
}

const toolPolicySchema = z.object({
  action: z.enum(["allow", "ask"]),
  reason: z.string().trim().min(1),
  risk: z.enum(["inspect", "mutating", "destructive", "unknown"]),
}).strict();

const serverSchema = z.object({
  args: z.array(z.string()).default([]),
  command: z.string().trim().min(1),
  connectTimeoutMs: z.number().int().positive().default(DEFAULT_MCP_CONNECT_TIMEOUT_MS),
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/, "must match ^[a-z][a-z0-9-]*$"),
  toolCallTimeoutMs: z.number().int().positive().default(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS),
  tools: z.record(z.string().trim().min(1), toolPolicySchema).refine(
    (tools) => Object.keys(tools).length > 0,
    "must contain at least one configured tool",
  ),
}).strict();

const projectConfigSchema = z.object({
  server: serverSchema,
}).strict();

export async function loadMcpProjectConfig(baseCwd: string): Promise<McpProjectConfig | undefined> {
  const configPath = path.join(baseCwd, MCP_PROJECT_CONFIG_PATH);
  let source: string;

  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid MCP config at "${configPath}": ${formatError(error)}`);
  }

  const result = projectConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid MCP config at "${configPath}": ${issues}`);
  }

  return {
    configPath,
    server: result.data.server,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
