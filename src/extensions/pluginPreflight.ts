import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  isPromptSkillId,
  parsePromptSkill,
  type PromptSkill,
} from "../context/promptAssembly.js";
import type { PermissionDecision } from "../governance/types.js";
import type { HookableTraceEventType } from "./lifecycle.js";
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  type McpProjectConfig,
} from "./mcpConfig.js";
import type { PluginProjectConfig, PluginProjectEntry } from "./pluginConfig.js";

const MANIFEST_PATH = path.join(".forge-plugin", "plugin.json");
const OPENAI_FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const OPENAI_FUNCTION_NAME_LIMIT = 64;
const COMPONENT_PATH_PATTERN = /^\.\//;

const PLUGIN_HOOK_EVENTS = new Set<HookableTraceEventType>([
  "session_started",
  "mcp_server_connected",
  "mcp_server_failed",
  "mcp_server_stopped",
  "plugin_activation_result",
  "model_request",
  "prompt_assembled",
  "context_compacted",
  "context_compaction_failed",
  "model_response",
  "tool_call",
  "permission_decision",
  "approval_result",
  "tool_result",
  "task_state_updated",
  "child_session_started",
  "child_session_finished",
  "child_session_handoff",
  "child_session_notification",
  "background_task_started",
  "background_task_finished",
  "background_task_notification",
  "cron_scheduled",
  "cron_canceled",
  "cron_worker_started",
  "cron_fired",
  "cron_run_finished",
  "cron_worker_stopped",
  "candidate_answer",
  "verification_result",
  "recovery_attempt",
  "final_answer",
  "session_failed",
  "session_ended",
]);

export interface PluginSkillDescriptor extends PromptSkill {
  localId: string;
  sourcePath: string;
}

export interface PluginHookDescriptor {
  effectiveName: string;
  entryPath: string;
  events: HookableTraceEventType[];
  localName: string;
}

export interface PluginMcpToolDescriptor {
  effectiveName: string;
  policy: PermissionDecision;
  rawName: string;
}

export interface PluginMcpServerDescriptor {
  args: string[];
  command: string;
  connectTimeoutMs: number;
  effectiveId: string;
  localId: string;
  toolCallTimeoutMs: number;
  tools: PluginMcpToolDescriptor[];
}

export interface PluginDescriptor {
  configuredPath: string;
  description: string;
  hooks: PluginHookDescriptor[];
  index: number;
  manifestPath: string;
  mcpServers: PluginMcpServerDescriptor[];
  name: string;
  root: string;
  skills: PluginSkillDescriptor[];
  version: string;
}

export interface PluginPreflightIssue {
  field: string;
  message: string;
  pluginIndex: number;
  pluginPath: string;
}

export class PluginPreflightError extends Error {
  constructor(readonly issues: PluginPreflightIssue[]) {
    super([
      `Plugin preflight failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}:`,
      ...issues.map((issue) => (
        `[plugin ${issue.pluginIndex} ${issue.pluginPath}] ${issue.field}: ${issue.message}`
      )),
    ].join("\n"));
    this.name = "PluginPreflightError";
  }
}

export interface PreflightPluginsOptions {
  baseCwd: string;
  config: PluginProjectConfig;
  standaloneMcpConfig?: McpProjectConfig;
}

export interface PluginPreflightResult {
  plugins: PluginDescriptor[];
}

const manifestSchema = z.object({
  description: z.string().trim().min(1),
  hooks: componentPathSchema().optional(),
  mcpServers: componentPathSchema().optional(),
  name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/, "must use lowercase letters, numbers, and hyphens"),
  skills: componentPathSchema().optional(),
  version: z.string().trim().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "must be a basic SemVer value"),
}).strict().refine(
  (manifest) => Boolean(manifest.skills || manifest.hooks || manifest.mcpServers),
  { message: "must declare at least one of skills, hooks, or mcpServers" },
);

const hookRegistrySchema = z.object({
  hooks: z.array(z.object({
    entry: componentPathSchema().refine((value) => value.endsWith(".mjs"), "must point to a .mjs file"),
    events: z.array(z.string().trim().min(1)).min(1),
    name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/, "must use lowercase letters, numbers, and hyphens"),
  }).strict()).min(1),
}).strict();

const mcpRegistrySchema = z.object({
  servers: z.record(
    z.string().trim().regex(/^[a-z][a-z0-9-]*$/, "must match ^[a-z][a-z0-9-]*$"),
    z.object({
      args: z.array(z.string()).default([]),
      command: z.string().trim().min(1),
      connectTimeoutMs: z.number().int().positive().default(DEFAULT_MCP_CONNECT_TIMEOUT_MS),
      toolCallTimeoutMs: z.number().int().positive().default(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS),
      tools: z.array(z.string().trim().min(1)).min(1).refine(
        (tools) => new Set(tools).size === tools.length,
        "must not contain duplicate tool names",
      ),
    }).strict(),
  ),
}).strict().refine((registry) => Object.keys(registry.servers).length > 0, "must contain at least one server");

export async function preflightPlugins(options: PreflightPluginsOptions): Promise<PluginPreflightResult> {
  const plugins: PluginDescriptor[] = [];
  const issues: PluginPreflightIssue[] = [];

  for (const [index, entry] of options.config.plugins.entries()) {
    if (!entry.enabled) {
      continue;
    }

    try {
      plugins.push(await preflightPlugin(options.baseCwd, entry, index, issues));
    } catch (error) {
      issues.push(...issuesFromError(error, entry, index));
    }
  }

  collectCollisions(plugins, issues);
  collectStandaloneCollisions(plugins, options.standaloneMcpConfig, issues);
  issues.sort(compareIssues);

  if (issues.length > 0) {
    throw new PluginPreflightError(issues);
  }

  return { plugins };
}

async function preflightPlugin(
  baseCwd: string,
  entry: PluginProjectEntry,
  index: number,
  issues: PluginPreflightIssue[],
): Promise<PluginDescriptor> {
  const configuredPath = entry.path;
  const candidateRoot = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(baseCwd, configuredPath);
  const root = await realpath(candidateRoot);
  const rootStats = await stat(root);

  if (!rootStats.isDirectory()) {
    throw fieldError("path", `plugin root is not a directory: ${root}`);
  }

  const manifestPath = await containedRealpath(root, path.join(root, MANIFEST_PATH), "manifest");
  const manifest = parseJsonSchema(await readFile(manifestPath, "utf8"), manifestSchema, "manifest");
  let skills: PluginSkillDescriptor[] = [];
  let hooks: PluginHookDescriptor[] = [];
  let mcpServers: PluginMcpServerDescriptor[] = [];

  if (manifest.skills) {
    try {
      const result = await loadPluginSkills(root, manifest.name, manifest.skills);
      skills = result.items;
      issues.push(...fieldIssues(result.errors, entry, index));
    } catch (error) {
      issues.push(...issuesFromError(error, entry, index, "manifest.skills"));
    }
  }

  if (manifest.hooks) {
    try {
      const result = await loadPluginHooks(root, manifest.name, manifest.hooks);
      hooks = result.items;
      issues.push(...fieldIssues(result.errors, entry, index));
    } catch (error) {
      issues.push(...issuesFromError(error, entry, index, "manifest.hooks"));
    }
  }

  if (manifest.mcpServers) {
    try {
      const result = await loadPluginMcpServers(root, manifest.name, manifest.mcpServers, entry);
      mcpServers = result.items;
      issues.push(...fieldIssues(result.errors, entry, index));
    } catch (error) {
      issues.push(...issuesFromError(error, entry, index, "manifest.mcpServers"));
    }
  } else {
    for (const serverId of Object.keys(entry.mcpPolicies ?? {})) {
      issues.push(...fieldIssues([
        fieldError("mcpPolicies", `policy references undeclared server "${serverId}"`),
      ], entry, index));
    }
  }

  return {
    configuredPath,
    description: manifest.description,
    hooks,
    index,
    manifestPath,
    mcpServers,
    name: manifest.name,
    root,
    skills,
    version: manifest.version,
  };
}

async function loadPluginSkills(
  root: string,
  pluginName: string,
  relativeDir: string,
): Promise<PluginComponentLoadResult<PluginSkillDescriptor>> {
  const skillsDir = await containedRealpath(root, path.resolve(root, relativeDir), "manifest.skills");
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skillIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareStrings);
  const skills: PluginSkillDescriptor[] = [];
  const errors: PluginFieldError[] = [];

  if (skillIds.length === 0) {
    errors.push(fieldError("manifest.skills", "declared skills directory must contain at least one skill"));
  }

  for (const localId of skillIds) {
    if (!isPromptSkillId(localId)) {
      errors.push(fieldError("skills", `skill directory "${localId}" must use lowercase letters, numbers, and hyphens`));
      continue;
    }

    try {
      const sourcePath = await containedRealpath(
        root,
        path.join(skillsDir, localId, "SKILL.md"),
        `skills.${localId}`,
      );
      const effectiveId = `${pluginName}:${localId}`;
      const parsed = parsePromptSkill(effectiveId, await readFile(sourcePath, "utf8"));
      skills.push({ ...parsed, localId, sourcePath });
    } catch (error) {
      errors.push(withDefaultField(error, `skills.${localId}`));
    }
  }

  return { errors, items: skills };
}

async function loadPluginHooks(
  root: string,
  pluginName: string,
  relativePath: string,
): Promise<PluginComponentLoadResult<PluginHookDescriptor>> {
  const registryPath = await containedRealpath(root, path.resolve(root, relativePath), "manifest.hooks");
  const registry = parseJsonSchema(await readFile(registryPath, "utf8"), hookRegistrySchema, "hooks");
  const hooks: PluginHookDescriptor[] = [];
  const errors = duplicateFieldErrors(
    registry.hooks.map((hook) => `${pluginName}:${hook.name}`),
    "hooks",
    "hook name",
  );

  for (const [hookIndex, hook] of registry.hooks.entries()) {
    for (const event of hook.events) {
      if (!PLUGIN_HOOK_EVENTS.has(event as HookableTraceEventType)) {
        errors.push(fieldError(`hooks.${hookIndex}.events`, `unsupported plugin hook event "${event}"`));
      }
    }

    try {
      const entryPath = await containedRealpath(
        root,
        path.resolve(root, hook.entry),
        `hooks.${hookIndex}.entry`,
      );
      hooks.push({
        effectiveName: `${pluginName}:${hook.name}`,
        entryPath,
        events: hook.events as HookableTraceEventType[],
        localName: hook.name,
      });
    } catch (error) {
      errors.push(withDefaultField(error, `hooks.${hookIndex}.entry`));
    }
  }

  return { errors, items: hooks };
}

async function loadPluginMcpServers(
  root: string,
  pluginName: string,
  relativePath: string,
  entry: PluginProjectEntry,
): Promise<PluginComponentLoadResult<PluginMcpServerDescriptor>> {
  const registryPath = await containedRealpath(root, path.resolve(root, relativePath), "manifest.mcpServers");
  const registry = parseJsonSchema(await readFile(registryPath, "utf8"), mcpRegistrySchema, "mcpServers");
  const declaredServerIds = new Set(Object.keys(registry.servers));
  const errors: PluginFieldError[] = [];

  for (const serverId of Object.keys(entry.mcpPolicies ?? {})) {
    if (!declaredServerIds.has(serverId)) {
      errors.push(fieldError("mcpPolicies", `policy references undeclared server "${serverId}"`));
    }
  }

  const servers = Object.entries(registry.servers).sort(([left], [right]) => compareStrings(left, right)).map(
    ([localId, server]) => {
      const declaredTools = new Set(server.tools);
      const configuredPolicies = entry.mcpPolicies?.[localId] ?? {};

      errors.push(...mcpTemplateErrors(server.command, `${localId}.command`));
      for (const [argumentIndex, argument] of server.args.entries()) {
        errors.push(...mcpTemplateErrors(argument, `${localId}.args.${argumentIndex}`));
      }

      for (const rawName of Object.keys(configuredPolicies)) {
        if (!declaredTools.has(rawName)) {
          errors.push(fieldError("mcpPolicies", `policy references undeclared tool "${localId}.${rawName}"`));
        }
      }

      const effectiveId = `${pluginName}-${localId}`;
      const tools = server.tools.map((rawName) => {
        const effectiveName = `mcp_${effectiveId}_${rawName}`;
        const nameError = validateExposedName(effectiveName);
        if (nameError) {
          errors.push(fieldError("mcpServers", nameError));
        }

        return {
          effectiveName,
          policy: configuredPolicies[rawName] ?? {
            action: "ask",
            reason: `No host policy configured for plugin MCP tool "${effectiveName}".`,
            risk: "unknown",
          },
          rawName,
        };
      });

      return {
        args: server.args,
        command: server.command,
        connectTimeoutMs: server.connectTimeoutMs,
        effectiveId,
        localId,
        toolCallTimeoutMs: server.toolCallTimeoutMs,
        tools,
      };
    },
  );

  return { errors, items: servers };
}

function collectCollisions(plugins: PluginDescriptor[], issues: PluginPreflightIssue[]): void {
  const names = new Map<string, PluginDescriptor>();
  const serverIds = new Map<string, PluginDescriptor>();
  const toolNames = new Map<string, PluginDescriptor>();

  for (const plugin of plugins) {
    reportCollision(names, plugin.name, plugin, "manifest.name", "plugin name", issues);

    for (const server of plugin.mcpServers) {
      reportCollision(serverIds, server.effectiveId, plugin, "mcpServers", "effective server ID", issues);
      for (const tool of server.tools) {
        reportCollision(toolNames, tool.effectiveName, plugin, "mcpServers", "final tool name", issues);
      }
    }
  }
}

function collectStandaloneCollisions(
  plugins: PluginDescriptor[],
  standalone: McpProjectConfig | undefined,
  issues: PluginPreflightIssue[],
): void {
  if (!standalone) {
    return;
  }

  const standaloneServerId = standalone.server.id;
  const standaloneToolNames = new Set(
    Object.keys(standalone.server.tools).map((rawName) => `mcp_${standaloneServerId}_${rawName}`),
  );

  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) {
      if (server.effectiveId === standaloneServerId) {
        issues.push({
          field: "mcpServers",
          message: `effective server ID "${server.effectiveId}" conflicts with standalone MCP server`,
          pluginIndex: plugin.index,
          pluginPath: plugin.configuredPath,
        });
      }

      for (const tool of server.tools) {
        if (standaloneToolNames.has(tool.effectiveName)) {
          issues.push({
            field: "mcpServers",
            message: `final tool name "${tool.effectiveName}" conflicts with standalone MCP server`,
            pluginIndex: plugin.index,
            pluginPath: plugin.configuredPath,
          });
        }
      }
    }
  }
}

function reportCollision(
  seen: Map<string, PluginDescriptor>,
  value: string,
  plugin: PluginDescriptor,
  field: string,
  label: string,
  issues: PluginPreflightIssue[],
): void {
  const previous = seen.get(value);
  if (!previous) {
    seen.set(value, plugin);
    return;
  }

  issues.push({
    field,
    message: `${label} "${value}" conflicts with plugin at index ${previous.index}`,
    pluginIndex: plugin.index,
    pluginPath: plugin.configuredPath,
  });
}

async function containedRealpath(root: string, candidate: string, field: string): Promise<string> {
  const resolved = await realpath(candidate);
  const relative = path.relative(root, resolved);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fieldError(field, `resolved path escapes plugin root: ${candidate}`);
  }

  return resolved;
}

function parseJsonSchema<S extends z.ZodTypeAny>(source: string, schema: S, field: string): z.output<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw fieldError(field, `invalid JSON: ${formatError(error)}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw fieldError(
      field,
      result.error.issues.map((issue) => `${issue.path.join(".") || field}: ${issue.message}`).join("; "),
    );
  }

  return result.data;
}

function componentPathSchema(): z.ZodString {
  return z.string().trim().regex(COMPONENT_PATH_PATTERN, "must start with ./");
}

function duplicateFieldErrors(values: string[], field: string, label: string): PluginFieldError[] {
  const seen = new Set<string>();
  const errors: PluginFieldError[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      errors.push(fieldError(field, `duplicate ${label} "${value}"`));
    }
    seen.add(value);
  }
  return errors;
}

function validateExposedName(name: string): string | undefined {
  if (!OPENAI_FUNCTION_NAME_PATTERN.test(name)) {
    return `final tool name "${name}" does not satisfy the OpenAI function name pattern`;
  }
  if (name.length > OPENAI_FUNCTION_NAME_LIMIT) {
    return `final tool name "${name}" exceeds 64 characters`;
  }
  return undefined;
}

function mcpTemplateErrors(value: string, location: string): PluginFieldError[] {
  const errors: PluginFieldError[] = [];
  const matches = value.matchAll(/\$\{([^}]*)\}/g);

  for (const match of matches) {
    if (match[1] !== "pluginRoot" && match[1] !== "projectRoot") {
      errors.push(fieldError(
        "mcpServers",
        `unsupported interpolation "${match[0]}" at ${location}; only \${pluginRoot} and \${projectRoot} are allowed`,
      ));
    }
  }

  return errors;
}

function issuesFromError(
  error: unknown,
  entry: PluginProjectEntry,
  pluginIndex: number,
  defaultField = "plugin",
): PluginPreflightIssue[] {
  return fieldIssues([withDefaultField(error, defaultField)], entry, pluginIndex);
}

function fieldIssues(
  errors: PluginFieldError[],
  entry: PluginProjectEntry,
  pluginIndex: number,
): PluginPreflightIssue[] {
  return errors.map((error) => ({
    field: error.field,
    message: error.message,
    pluginIndex,
    pluginPath: entry.path,
  }));
}

interface PluginComponentLoadResult<T> {
  errors: PluginFieldError[];
  items: T[];
}

class PluginFieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

function fieldError(field: string, message: string): PluginFieldError {
  return new PluginFieldError(field, message);
}

function withDefaultField(error: unknown, field: string): PluginFieldError {
  return error instanceof PluginFieldError ? error : fieldError(field, formatError(error));
}

function compareIssues(left: PluginPreflightIssue, right: PluginPreflightIssue): number {
  return left.pluginIndex - right.pluginIndex
    || compareStrings(left.field, right.field)
    || compareStrings(left.message, right.message);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
