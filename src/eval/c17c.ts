import path from "node:path";

import { loadRepoPromptAssets } from "../context/promptAssembly.js";
import { runMinimalLoop, type ResponseCreate } from "../core/minimalLoop.js";
import { createChildSessionRunner } from "../extensions/childSessions.js";
import { createLifecycleEmitter } from "../extensions/lifecycle.js";
import {
  activateApprovedPluginHooks,
  buildPluginActivationEvents,
  collectPluginTrustDecisions,
  mergeMcpPermissionPolicies,
  startApprovedPluginMcpServers,
} from "../extensions/pluginActivation.js";
import { loadPluginProjectConfig } from "../extensions/pluginConfig.js";
import { resolvePluginDescriptors } from "../extensions/pluginDescriptors.js";
import { preflightPlugins } from "../extensions/pluginPreflight.js";
import { mergePluginPromptAssets } from "../extensions/pluginSkills.js";
import {
  createTeammateManager,
  type TeammateManager,
} from "../extensions/teammates.js";
import { createDefaultPermissionPolicy } from "../governance/defaultPolicy.js";
import { createMcpPermissionPolicy } from "../governance/mcpPolicy.js";
import type { PermissionApprover } from "../governance/types.js";
import type { CliSessionTrace } from "../runtime/session.js";
import { createRuntimeStateRecorder } from "../runtime/state.js";
import { createFileMailboxStore } from "../runtime/teamMailbox.js";
import { createFileTeamTaskStore } from "../runtime/teamTaskStore.js";
import { createCommandVerifier } from "../runtime/verification.js";
import type { TeamTaskGraphFile } from "../domain/teamTask.js";
import type { LifecycleEmitter } from "../extensions/lifecycle.js";
import type { EvalScenario } from "./scenario.js";
import { EvalInfrastructureError } from "./errors.js";
import {
  createEvalPermissionPolicy,
  createEvalTeammatePermissionRules,
} from "./policy.js";
import { C17C_VERIFY_COMMAND } from "./scenarios.js";

export interface RunC17cRuntimeOptions {
  apiKey?: string;
  approver: PermissionApprover;
  baseURL?: string;
  model: string;
  responseCreate: ResponseCreate;
  rootTrace: CliSessionTrace;
  scenario: EvalScenario;
  signal?: AbortSignal;
  workspace: string;
}

export interface C17cRuntimeResult {
  finalAnswer: string;
  taskGraph: TeamTaskGraphFile;
  team: {
    leaderUnreadCount: number;
    members: Array<{
      name: string;
      state: "busy" | "failed" | "idle" | "starting" | "stopped";
      unreadCount: number;
    }>;
  };
}

export async function runC17cRuntime(options: RunC17cRuntimeOptions): Promise<C17cRuntimeResult> {
  const taskGraphBinding = options.rootTrace.metadata.taskGraph;
  if (!taskGraphBinding) {
    throw new EvalInfrastructureError("fixture_error", "c17c root session did not create a task graph");
  }
  const taskStore = createFileTeamTaskStore({ graphPath: taskGraphBinding.taskGraphPath });
  const runtimeState = createRuntimeStateRecorder(options.rootTrace.recorder);
  const startupEmitter = createLifecycleEmitter({ recorder: runtimeState.recorder });
  const pluginConfig = await loadPluginProjectConfig(options.workspace);
  const preflight = await preflightPlugins({
    baseCwd: options.workspace,
    config: pluginConfig,
  });
  const descriptors = resolvePluginDescriptors(preflight.plugins, options.workspace);
  const trustDecisions = await collectPluginTrustDecisions({
    approver: {
      async approve({ descriptor }) {
        return descriptor.name === "issue-workflow"
          ? { approved: true, reason: "trusted canonical local eval fixture" }
          : { approved: false, reason: "not part of the canonical eval fixture" };
      },
    },
    descriptors,
    lifecycleEmitter: startupEmitter,
  });
  const hookActivation = await activateApprovedPluginHooks(trustDecisions);
  const lifecycleEmitter = createLifecycleEmitter({
    hookResultRecorder: options.rootTrace.recorder,
    hooks: hookActivation.hooks,
    recorder: runtimeState.recorder,
  });
  const pluginActivation = await startApprovedPluginMcpServers({
    decisions: trustDecisions,
    lifecycleEmitter,
  });
  const teamRoot = path.join(options.rootTrace.paths.sessionDir, "team");
  const mailboxStore = createFileMailboxStore({ teamRoot });
  let teammateManager: TeammateManager | undefined;
  let completed = false;
  let capturedTeam: C17cRuntimeResult["team"] | undefined;
  let capturedGraph: TeamTaskGraphFile | undefined;
  let operationError: unknown;
  let operationFailed = false;
  let runtimeResult!: C17cRuntimeResult;
  const cleanupErrors: unknown[] = [];
  const captureCleanup = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };

  try {
    const issueServer = pluginActivation.servers.find((server) => (
      server.descriptor.server.id === "issue-workflow-demo"
    ));
    if (!issueServer || issueServer.status !== "active") {
      throw new EvalInfrastructureError(
        "plugin_startup",
        `canonical issue-workflow MCP server did not start${issueServer?.status === "failed" ? `: ${issueServer.reason}` : ""}`,
      );
    }
    for (const event of buildPluginActivationEvents({
      decisions: trustDecisions,
      hookFailures: hookActivation.failures,
      servers: pluginActivation.servers,
    })) {
      await lifecycleEmitter.emit(event);
    }

    const approvedPlugins = trustDecisions
      .filter((decision) => decision.result.approved)
      .map((decision) => decision.descriptor);
    const promptAssets = mergePluginPromptAssets(
      await loadRepoPromptAssets(options.workspace),
      approvedPlugins,
    );
    const mcpPolicies = mergeMcpPermissionPolicies(
      pluginActivation.sessions.map((session) => session.permissionPolicies),
    );
    teammateManager = createTeammateManager({
      approver: options.approver,
      baseCwd: options.workspace,
      lifecycleEmitter,
      mailboxStore,
      model: options.model,
      rootSessionId: options.rootTrace.metadata.id,
      taskGraph: taskGraphBinding,
      teamRoot,
      workerPermissionRules: (definition) => (
        createEvalTeammatePermissionRules(options.scenario, definition.name)
      ),
    });
    await teammateManager.initialize();
    const result = await runMinimalLoop({
      additionalToolRuntimes: pluginActivation.sessions,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      approver: options.approver,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      childSessionRunner: createChildSessionRunner({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        approver: options.approver,
        baseCwd: options.workspace,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        model: options.model,
        parentLifecycleEmitter: lifecycleEmitter,
        parentSessionId: options.rootTrace.metadata.id,
        permissionPolicy: createEvalPermissionPolicy({
          scenario: options.scenario,
          session: { profile: "research", role: "child", sessionId: "c17c-child" },
        }),
        responseCreate: options.responseCreate,
        signal: options.signal,
        taskGraph: taskGraphBinding,
      }),
      cwd: options.workspace,
      lifecycleEmitter,
      maxToolRounds: options.scenario.manifest.runtime.rootMaxToolRounds,
      model: options.model,
      permissionPolicy: createEvalPermissionPolicy({
        base: createMcpPermissionPolicy(createDefaultPermissionPolicy(), mcpPolicies),
        scenario: options.scenario,
        session: { role: "root", sessionId: options.rootTrace.metadata.id },
      }),
      promptAssets,
      responseCreate: options.responseCreate,
      runtimeState: runtimeState.getState,
      signal: options.signal,
      task: options.scenario.manifest.task,
      teamTasks: {
        actor: { role: "leader", sessionId: options.rootTrace.metadata.id },
        store: taskStore,
      },
      teammates: teammateManager,
      verifier: createCommandVerifier({
        command: C17C_VERIFY_COMMAND,
        cwd: options.workspace,
        timeoutMs: options.scenario.manifest.runtime.verifierTimeoutMs,
      }),
    });
    await teammateManager.flushEvents();
    capturedTeam = await inspectTeam(teammateManager, mailboxStore);
    capturedGraph = await taskStore.read();
    completed = true;
    runtimeResult = {
      finalAnswer: result.finalAnswer,
      taskGraph: capturedGraph,
      team: capturedTeam,
    };
  } catch (error) {
    operationError = error;
    operationFailed = true;
  } finally {
    if (!capturedTeam && teammateManager) {
      await captureCleanup(() => teammateManager!.flushEvents());
      await captureCleanup(async () => {
        capturedTeam = await inspectTeam(teammateManager!, mailboxStore);
      });
    }
    if (!capturedGraph) {
      await captureCleanup(async () => {
        capturedGraph = await taskStore.read();
      });
    }
    if (teammateManager) {
      if (completed) {
        await captureCleanup(() => teammateManager!.close());
      } else {
        await captureCleanup(() => teammateManager!.terminateAll());
      }
    }
    await captureCleanup(() => pluginActivation.close());
  }

  const failures = [
    ...(operationFailed ? [operationError] : []),
    ...cleanupErrors,
  ];
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `c17c runtime failed: ${failures.map(formatError).join("; ")}`,
    );
  }
  return runtimeResult;
}

async function inspectTeam(
  manager: TeammateManager,
  mailboxStore: ReturnType<typeof createFileMailboxStore>,
): Promise<C17cRuntimeResult["team"]> {
  const [members, leader] = await Promise.all([
    manager.list(),
    mailboxStore.inspect("leader"),
  ]);
  return {
    leaderUnreadCount: leader.unreadCount,
    members: members.map((member) => ({
      name: member.name,
      state: member.state,
      unreadCount: member.unreadCount,
    })),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
