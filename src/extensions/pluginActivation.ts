import type { PluginTrustApprover, PluginTrustResult } from "../cli/pluginTrust.js";
import type { PermissionDecision } from "../governance/types.js";
import type {
  PluginActivationStatus,
  PluginComponentActivation,
  PluginToolActivation,
  TraceEventPayload,
} from "../runtime/trace.js";
import type { ToolRuntime } from "../tools/types.js";
import { activatePluginHooks, type PluginHookActivationFailure } from "./pluginHooks.js";
import type { ResolvedPluginDescriptor, ResolvedPluginMcpServerDescriptor } from "./pluginDescriptors.js";
import type { LifecycleEmitter } from "./lifecycle.js";
import { startMcpSession, type StartMcpSessionOptions } from "./mcpSession.js";
import type { McpToolCatalogDiagnostics } from "./mcpToolAdapter.js";

export interface PluginTrustDecision {
  descriptor: ResolvedPluginDescriptor;
  result: PluginTrustResult;
}

export interface CollectPluginTrustOptions {
  approver: PluginTrustApprover;
  descriptors: ResolvedPluginDescriptor[];
  lifecycleEmitter: LifecycleEmitter;
}

export interface PluginMcpSessionLike extends ToolRuntime {
  diagnostics: McpToolCatalogDiagnostics;
  permissionPolicies: ReadonlyMap<string, PermissionDecision>;
}

export type StartPluginMcpSession = (
  options: StartMcpSessionOptions,
) => Promise<PluginMcpSessionLike>;

export interface ActivePluginServerResult {
  descriptor: ResolvedPluginMcpServerDescriptor;
  diagnostics: McpToolCatalogDiagnostics;
  pluginName: string;
  session: PluginMcpSessionLike;
  status: "active";
}

export interface FailedPluginServerResult {
  descriptor: ResolvedPluginMcpServerDescriptor;
  pluginName: string;
  reason: string;
  status: "failed";
}

export type PluginServerActivationResult = ActivePluginServerResult | FailedPluginServerResult;

export interface PluginMcpActivationResult {
  close(): Promise<void>;
  servers: PluginServerActivationResult[];
  sessions: PluginMcpSessionLike[];
}

export async function collectPluginTrustDecisions(
  options: CollectPluginTrustOptions,
): Promise<PluginTrustDecision[]> {
  const decisions: PluginTrustDecision[] = [];
  const descriptors = [...options.descriptors].sort((left, right) => left.index - right.index);

  for (const descriptor of descriptors) {
    const result = await options.approver.approve({ descriptor });
    decisions.push({ descriptor, result });
    await options.lifecycleEmitter.emit({
      approved: result.approved,
      pluginName: descriptor.name,
      reason: result.reason ?? "approved by user",
      root: descriptor.root,
      type: "plugin_trust_decided",
      version: descriptor.version,
    });
  }

  return decisions;
}

export function activateApprovedPluginHooks(decisions: PluginTrustDecision[]) {
  return activatePluginHooks(
    decisions.filter((decision) => decision.result.approved).map((decision) => decision.descriptor),
  );
}

export interface StartApprovedPluginMcpOptions {
  decisions: PluginTrustDecision[];
  lifecycleEmitter: LifecycleEmitter;
  startSession?: StartPluginMcpSession;
}

export async function startApprovedPluginMcpServers(
  options: StartApprovedPluginMcpOptions,
): Promise<PluginMcpActivationResult> {
  const servers: PluginServerActivationResult[] = [];
  const sessions: PluginMcpSessionLike[] = [];
  const startSession = options.startSession ?? startMcpSession;
  const approved = options.decisions
    .filter((decision) => decision.result.approved)
    .sort((left, right) => left.descriptor.index - right.descriptor.index);

  for (const decision of approved) {
    const descriptors = [...decision.descriptor.mcpServers].sort(
      (left, right) => compareStrings(left.server.id, right.server.id),
    );

    for (const descriptor of descriptors) {
      try {
        const session = await startSession({
          baseCwd: descriptor.cwd,
          lifecycleEmitter: options.lifecycleEmitter,
          server: descriptor.server,
        });
        sessions.push(session);
        servers.push({
          descriptor,
          diagnostics: session.diagnostics,
          pluginName: decision.descriptor.name,
          session,
          status: "active",
        });
      } catch (error) {
        servers.push({
          descriptor,
          pluginName: decision.descriptor.name,
          reason: formatError(error),
          status: "failed",
        });
      }
    }
  }

  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= closeSessions(sessions);
      return closePromise;
    },
    servers,
    sessions,
  };
}

export interface BuildPluginActivationEventsOptions {
  decisions: PluginTrustDecision[];
  hookFailures: PluginHookActivationFailure[];
  servers: PluginServerActivationResult[];
}

export type PluginActivationResultEvent = Extract<
  TraceEventPayload,
  { type: "plugin_activation_result" }
>;

export function buildPluginActivationEvents(
  options: BuildPluginActivationEventsOptions,
): PluginActivationResultEvent[] {
  const hookFailureByName = new Map(options.hookFailures.map((failure) => [failure.hookName, failure.reason]));
  const serverById = new Map(options.servers.map((result) => [result.descriptor.server.id, result]));

  return [...options.decisions]
    .sort((left, right) => left.descriptor.index - right.descriptor.index)
    .map((decision) => {
      const { descriptor } = decision;
      const rejectionReason = decision.result.reason ?? "plugin activation rejected";
      const skills = componentResult(
        descriptor.skills.map((skill) => skill.id),
        decision.result.approved,
        () => undefined,
        rejectionReason,
      );
      const hooks = componentResult(
        descriptor.hooks.map((hook) => hook.effectiveName),
        decision.result.approved,
        (id) => hookFailureByName.get(id),
        rejectionReason,
      );
      const mcpServers = componentResult(
        descriptor.mcpServers.map((server) => server.server.id),
        decision.result.approved,
        (id) => {
          const result = serverById.get(id);
          return result?.status === "failed" ? result.reason : result ? undefined : "server activation was not attempted";
        },
        rejectionReason,
      );
      const tools = pluginToolActivation(descriptor, serverById);
      const status = activationStatus({ hooks, mcpServers, skills }, tools);

      return {
        components: { hooks, mcpServers, skills },
        pluginName: descriptor.name,
        status,
        tools,
        type: "plugin_activation_result",
        version: descriptor.version,
      };
    });
}

export function mergeMcpPermissionPolicies(
  sources: Array<ReadonlyMap<string, PermissionDecision>>,
): ReadonlyMap<string, PermissionDecision> {
  const merged = new Map<string, PermissionDecision>();

  for (const source of sources) {
    for (const [toolName, decision] of source) {
      if (merged.has(toolName)) {
        throw new Error(`Duplicate MCP permission policy "${toolName}"`);
      }
      merged.set(toolName, { ...decision });
    }
  }

  return merged;
}

function componentResult(
  declared: string[],
  approved: boolean,
  failureReason: (id: string) => string | undefined,
  rejectionReason: string,
): PluginComponentActivation {
  const active: string[] = [];
  const failed: PluginComponentActivation["failed"] = [];

  for (const id of declared) {
    const reason = approved ? failureReason(id) : rejectionReason;
    if (reason) {
      failed.push({ id, reason });
    } else {
      active.push(id);
    }
  }

  return { active, declared, failed };
}

function pluginToolActivation(
  plugin: ResolvedPluginDescriptor,
  serverById: Map<string, PluginServerActivationResult>,
): PluginToolActivation {
  const declared = plugin.mcpServers.flatMap((server) => server.declared.tools.map((tool) => tool.effectiveName));
  const denied: string[] = [];
  const exposed: string[] = [];
  const extra: string[] = [];
  const incompatible: PluginToolActivation["incompatible"] = [];
  const missing: string[] = [];

  for (const server of plugin.mcpServers) {
    const result = serverById.get(server.server.id);
    if (!result || result.status !== "active") {
      continue;
    }

    denied.push(...result.diagnostics.deniedToolNames);
    exposed.push(...result.diagnostics.exposedToolNames);
    extra.push(...result.diagnostics.extraToolNames.map((rawName) => `${server.server.id}.${rawName}`));
    missing.push(...result.diagnostics.missingToolNames.map((rawName) => finalToolName(server, rawName)));
    incompatible.push(...result.diagnostics.incompatibleTools.map((item) => ({
      reason: item.reason,
      toolName: finalToolName(server, item.rawToolName),
    })));
  }

  return {
    declared,
    denied: denied.sort(compareStrings),
    exposed: exposed.sort(compareStrings),
    extra: extra.sort(compareStrings),
    incompatible: incompatible.sort((left, right) => compareStrings(left.toolName, right.toolName)),
    missing: missing.sort(compareStrings),
  };
}

function activationStatus(
  components: {
    hooks: PluginComponentActivation;
    mcpServers: PluginComponentActivation;
    skills: PluginComponentActivation;
  },
  tools: PluginToolActivation,
): PluginActivationStatus {
  const componentValues = [components.skills, components.hooks, components.mcpServers];
  const activeCount = componentValues.reduce((sum, component) => sum + component.active.length, 0);
  const failedCount = componentValues.reduce((sum, component) => sum + component.failed.length, 0);

  if (activeCount === 0) {
    return "failed";
  }

  if (failedCount > 0 || tools.missing.length > 0 || tools.incompatible.length > 0) {
    return "degraded";
  }

  return "active";
}

function finalToolName(server: ResolvedPluginMcpServerDescriptor, rawName: string): string {
  return server.declared.tools.find((tool) => tool.rawName === rawName)?.effectiveName
    ?? `mcp_${server.server.id}_${rawName}`;
}

async function closeSessions(sessions: PluginMcpSessionLike[]): Promise<void> {
  for (const session of [...sessions].reverse()) {
    try {
      await session.close?.();
    } catch {
      // Each session gets a cleanup attempt; another session's close failure must not stop the sequence.
    }
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
