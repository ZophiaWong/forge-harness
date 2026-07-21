import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { PermissionDecision } from "../governance/types.js";

export const PLUGIN_PROJECT_CONFIG_PATH = path.join(".forge", "plugins.json");

export interface PluginProjectConfig {
  plugins: PluginProjectEntry[];
}

export interface PluginProjectEntry {
  enabled: boolean;
  mcpPolicies?: Record<string, Record<string, PermissionDecision>>;
  path: string;
}

const permissionDecisionSchema = z.object({
  action: z.enum(["allow", "ask", "deny"]),
  reason: z.string().trim().min(1),
  risk: z.enum(["inspect", "mutating", "destructive", "unknown"]),
}).strict();

const pluginProjectEntrySchema = z.object({
  enabled: z.boolean(),
  mcpPolicies: z.record(
    z.string().trim().min(1),
    z.record(z.string().trim().min(1), permissionDecisionSchema),
  ).optional(),
  path: z.string().trim().min(1),
}).strict();

const pluginProjectConfigSchema = z.object({
  plugins: z.array(pluginProjectEntrySchema),
}).strict();

export async function loadPluginProjectConfig(baseCwd: string): Promise<PluginProjectConfig> {
  const configPath = path.join(baseCwd, PLUGIN_PROJECT_CONFIG_PATH);

  let source: string;

  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { plugins: [] };
    }

    throw error;
  }

  let parsed: unknown;

  if (source.trim().length === 0) {
    return { plugins: [] };
  }

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid plugin config at "${configPath}": ${formatError(error)}`);
  }

  const result = pluginProjectConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid plugin config at "${configPath}": ${issues}`);
  }

  return result.data;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
