#!/usr/bin/env node

import "dotenv/config";
import path from "node:path";

import { createCliApprover } from "./approval.js";
import { createCliMcpServerTrustApprover } from "./mcpTrust.js";
import { createCliPluginTrustApprover } from "./pluginTrust.js";
import { type ParsedCliArgs, parseCliArgs, usageText } from "./args.js";
import {
  formatContextCompactionTranscript,
  formatFunctionCallTranscript,
  formatHookLogTranscript,
  formatMcpDisabledTranscript,
  formatMcpSessionTranscript,
  formatPermissionDecisionTranscript,
  formatPromptAssemblyTranscript,
  formatRecoveryTranscript,
  formatRuntimeStateTranscript,
  formatSessionTranscript,
  formatVerificationTranscript,
  formatWorkspaceTranscript,
} from "./transcript.js";
import { loadRepoPromptAssets } from "../context/promptAssembly.js";
import { DEFAULT_MAX_TOOL_ROUNDS, DEFAULT_MODEL, runMinimalLoop } from "../core/minimalLoop.js";
import { createChildSessionRunner } from "../extensions/childSessions.js";
import { createCronWorker, type ScheduledRunResult } from "../extensions/cronWorker.js";
import { createLifecycleEmitter, type LifecycleHook } from "../extensions/lifecycle.js";
import { loadMcpProjectConfig } from "../extensions/mcpConfig.js";
import { McpSessionStartError, startMcpSession, type McpSession } from "../extensions/mcpSession.js";
import {
  activateApprovedPluginHooks,
  buildPluginActivationEvents,
  collectPluginTrustDecisions,
  mergeMcpPermissionPolicies,
  startApprovedPluginMcpServers,
  type PluginMcpActivationResult,
} from "../extensions/pluginActivation.js";
import { loadPluginProjectConfig } from "../extensions/pluginConfig.js";
import { resolvePluginDescriptors } from "../extensions/pluginDescriptors.js";
import { preflightPlugins } from "../extensions/pluginPreflight.js";
import { mergePluginPromptAssets } from "../extensions/pluginSkills.js";
import { createDefaultPermissionPolicy } from "../governance/defaultPolicy.js";
import { createMcpPermissionPolicy } from "../governance/mcpPolicy.js";
import type { CronSchedule } from "../runtime/cronStore.js";
import { createFileCronScheduleStore } from "../runtime/cronStore.js";
import { createCliSessionTrace, type SessionWorkspaceMetadata } from "../runtime/session.js";
import { prepareWorktreeSession } from "../runtime/sessionWorkspace.js";
import { createRuntimeStateRecorder, type RuntimeState } from "../runtime/state.js";
import { createCommandVerifier } from "../runtime/verification.js";

const cliArgs = parseCliArgs(process.argv.slice(2));

if (cliArgs.error) {
  console.error(cliArgs.error);
  console.error(usageText("forge-harness"));
  process.exitCode = 1;
} else if (!cliArgs.task && !cliArgs.cronWorker) {
  console.error(usageText("forge-harness"));
  process.exitCode = 1;
} else if (cliArgs.cronWorker) {
  try {
    await runCronWorkerCli(cliArgs);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`forge-harness cron worker failed: ${message}`);
    process.exitCode = 1;
  }
} else {
  await runTaskCli(cliArgs);
}

async function runTaskCli(cliArgs: ParsedCliArgs): Promise<void> {
  const task = cliArgs.task;
  let getRuntimeState: (() => RuntimeState) | undefined;
  let mcpSession: McpSession | undefined;
  let pluginMcpActivation: PluginMcpActivationResult | undefined;

  if (!task) {
    console.error(usageText("forge-harness"));
    process.exitCode = 1;
    return;
  }

  try {
    const baseCwd = process.cwd();
    const projectPromptAssets = await loadRepoPromptAssets(baseCwd);
    const mcpConfig = await loadMcpProjectConfig(baseCwd);
    const pluginConfig = await loadPluginProjectConfig(baseCwd);
    const pluginPreflight = await preflightPlugins({
      baseCwd,
      config: pluginConfig,
      ...(mcpConfig ? { standaloneMcpConfig: mcpConfig } : {}),
    });
    let executionCwd = baseCwd;
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    const maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS;
    const cronSchedules = createFileCronScheduleStore({ cwd: baseCwd });
    const sessionTrace = await createCliSessionTrace({
      cwd: baseCwd,
      maxToolRounds,
      model,
      task,
    });
    const runtimeStateTrace = createRuntimeStateRecorder(sessionTrace.recorder);
    const builtInHooks: LifecycleHook[] = cliArgs.hookLog
      ? [
          {
            name: "event-log",
            handle(event) {
              console.log(formatHookLogTranscript(event));
            },
          },
        ]
      : [];
    const startupEmitter = createLifecycleEmitter({
      hookResultRecorder: sessionTrace.recorder,
      hooks: builtInHooks,
      recorder: runtimeStateTrace.recorder,
    });
    getRuntimeState = runtimeStateTrace.getState;
    const displayTracePath = path.relative(baseCwd, sessionTrace.paths.tracePath);
    const approver = createCliApprover();

    console.log(formatSessionTranscript(sessionTrace.metadata.id, displayTracePath));

    const workspace = cliArgs.worktree
      ? await prepareWorktreeSession({
          baseCwd,
          lifecycleEmitter: startupEmitter,
          sessionTrace,
        })
      : undefined;

    if (workspace) {
      executionCwd = workspace.path;
    }

    const verifier = cliArgs.verifyCommand
      ? createCommandVerifier({
          command: cliArgs.verifyCommand,
          cwd: executionCwd,
        })
      : undefined;

    if (workspace) {
      console.log(formatWorkspaceTranscript(toDisplayWorkspace(workspace, baseCwd)));
    }

    const resolvedPlugins = resolvePluginDescriptors(pluginPreflight.plugins, executionCwd);
    const standaloneTrust = mcpConfig
      ? await createCliMcpServerTrustApprover().approve({ baseCwd, config: mcpConfig })
      : undefined;

    if (mcpConfig && standaloneTrust) {
      await startupEmitter.emit({
        approved: standaloneTrust.approved,
        reason: standaloneTrust.reason ?? "approved by user",
        serverId: mcpConfig.server.id,
        type: "mcp_server_trust_decided",
      });
    }

    const pluginTrustDecisions = await collectPluginTrustDecisions({
      approver: createCliPluginTrustApprover(),
      descriptors: resolvedPlugins,
      lifecycleEmitter: startupEmitter,
    });
    const pluginHookActivation = await activateApprovedPluginHooks(pluginTrustDecisions);
    const lifecycleEmitter = createLifecycleEmitter({
      hookResultRecorder: sessionTrace.recorder,
      hooks: [...builtInHooks, ...pluginHookActivation.hooks],
      recorder: runtimeStateTrace.recorder,
    });

    if (mcpConfig && standaloneTrust) {
      if (standaloneTrust.approved) {
        try {
          mcpSession = await startMcpSession({
            baseCwd,
            lifecycleEmitter,
            server: mcpConfig.server,
          });
          console.log(formatMcpSessionTranscript(mcpConfig.server.id, mcpSession.diagnostics));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const phase = error instanceof McpSessionStartError ? ` phase=${error.phase}` : "";
          console.error(formatMcpDisabledTranscript(mcpConfig.server.id, `${reason}${phase}`));
        }
      } else {
        console.error(formatMcpDisabledTranscript(
          mcpConfig.server.id,
          standaloneTrust.reason ?? "startup rejected",
        ));
      }
    }

    pluginMcpActivation = await startApprovedPluginMcpServers({
      decisions: pluginTrustDecisions,
      lifecycleEmitter,
    });
    for (const serverResult of pluginMcpActivation.servers) {
      if (serverResult.status === "active") {
        console.log(formatMcpSessionTranscript(serverResult.descriptor.server.id, serverResult.diagnostics));
      } else {
        console.error(formatMcpDisabledTranscript(serverResult.descriptor.server.id, serverResult.reason));
      }
    }

    const approvedPlugins = pluginTrustDecisions
      .filter((decision) => decision.result.approved)
      .map((decision) => decision.descriptor);
    const promptAssets = mergePluginPromptAssets(projectPromptAssets, approvedPlugins);
    const additionalToolRuntimes = [
      ...(mcpSession ? [mcpSession] : []),
      ...pluginMcpActivation.sessions,
    ];
    const mcpPermissionPolicies = mergeMcpPermissionPolicies(
      additionalToolRuntimes
        .filter((runtime): runtime is McpSession | PluginMcpActivationResult["sessions"][number] => (
          "permissionPolicies" in runtime
        ))
        .map((runtime) => runtime.permissionPolicies),
    );
    const activationEvents = buildPluginActivationEvents({
      decisions: pluginTrustDecisions,
      hookFailures: pluginHookActivation.failures,
      servers: pluginMcpActivation.servers,
    });
    for (const event of activationEvents) {
      await lifecycleEmitter.emit(event);
      console.log(`[plugin] activation ${event.pluginName}@${event.version} status=${event.status}`);
    }

    await runMinimalLoop({
      ...(additionalToolRuntimes.length > 0 ? { additionalToolRuntimes } : {}),
      approver,
      ...(workspace ? { baseCwd, workspace } : {}),
      childSessionRunner: createChildSessionRunner({
        approver,
        baseCwd,
        model,
        parentLifecycleEmitter: lifecycleEmitter,
        parentSessionId: sessionTrace.metadata.id,
      }),
      cronSchedules,
      cwd: executionCwd,
      lifecycleEmitter,
      maxToolRounds,
      model,
      ...(mcpPermissionPolicies.size > 0
        ? {
            permissionPolicy: createMcpPermissionPolicy(
              createDefaultPermissionPolicy(),
              mcpPermissionPolicies,
            ),
          }
        : {}),
      promptAssets,
      runtimeState: runtimeStateTrace.getState,
      task,
      transcript: {
        roundStart(round, modelName) {
          console.log(`\n[round ${round}] model=${modelName}`);
        },
        promptAssembly(round, summary) {
          console.log(formatPromptAssemblyTranscript(round, summary));
        },
        contextCompaction(compaction) {
          console.log(formatContextCompactionTranscript(compaction));
        },
        roundState(round, state) {
          console.log(formatRuntimeStateTranscript(state, round));
        },
        toolCall(round, toolName, argumentsText) {
          console.log(formatFunctionCallTranscript(round, toolName, argumentsText));
        },
        permissionDecision(round, decision) {
          console.log(formatPermissionDecisionTranscript(round, decision));
        },
        recoveryAttempt(_round, attempt, maxAttempts) {
          console.log(formatRecoveryTranscript(attempt, maxAttempts));
        },
        toolResult(round, resultText) {
          console.log(`[round ${round}] tool_result:\n${resultText}`);
        },
        verificationResult(_round, result) {
          console.log(formatVerificationTranscript(result));
        },
        finalAnswer(answer) {
          console.log(`\n[final]\n${answer}`);
        },
        finalState(state) {
          console.log(formatRuntimeStateTranscript(state));
        },
      },
      ...(verifier ? { verifier } : {}),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (getRuntimeState) {
      console.error(formatRuntimeStateTranscript(getRuntimeState()));
    }
    console.error(`forge-harness failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await pluginMcpActivation?.close();
    await mcpSession?.close();
  }
}

async function runCronWorkerCli(cliArgs: ParsedCliArgs): Promise<void> {
  if (!cliArgs.cronWorker) {
    return;
  }

  const cwd = process.cwd();
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS;
  const cronSchedules = createFileCronScheduleStore({ cwd });
  const workerSession = await createCliSessionTrace({
    cwd,
    maxToolRounds,
    model,
    task: `cron worker (${cliArgs.cronWorker})`,
  });
  const workerTracePath = path.relative(cwd, workerSession.paths.tracePath);

  console.log(formatSessionTranscript(workerSession.metadata.id, workerTracePath));

  const worker = createCronWorker({
    cwd,
    onLog(message) {
      console.log(message);
    },
    recorder: workerSession.recorder,
    runScheduledTask(task) {
      return runScheduledCronTask({
        baseCwd: cwd,
        maxToolRounds,
        model,
        task,
        worktree: cliArgs.worktree === true,
      });
    },
    store: cronSchedules,
  });

  if (cliArgs.cronWorker === "once") {
    await worker.runOnce();
    return;
  }

  process.once("SIGINT", () => {
    worker.stop();
  });
  process.once("SIGTERM", () => {
    worker.stop();
  });
  await worker.runForever();
}

interface RunScheduledCronTaskOptions {
  baseCwd: string;
  maxToolRounds: number;
  model: string;
  task: CronSchedule;
  worktree?: boolean;
}

async function runScheduledCronTask(options: RunScheduledCronTaskOptions): Promise<ScheduledRunResult> {
  const scheduledTask = `[Scheduled cron_id=${options.task.id}] ${options.task.prompt}`;
  let executionCwd = options.baseCwd;
  const sessionTrace = await createCliSessionTrace({
    cwd: options.baseCwd,
    maxToolRounds: options.maxToolRounds,
    model: options.model,
    task: scheduledTask,
  });
  const runtimeStateTrace = createRuntimeStateRecorder(sessionTrace.recorder);
  const lifecycleEmitter = createLifecycleEmitter({
    recorder: runtimeStateTrace.recorder,
  });
  const displayTracePath = path.relative(options.baseCwd, sessionTrace.paths.tracePath);

  console.log(`[cron-worker] scheduled session=${sessionTrace.metadata.id} trace=${displayTracePath}`);

  try {
    const workspace = options.worktree
      ? await prepareWorktreeSession({
          baseCwd: options.baseCwd,
          lifecycleEmitter,
          sessionTrace,
        })
      : undefined;

    if (workspace) {
      executionCwd = workspace.path;
      console.log(formatWorkspaceTranscript(toDisplayWorkspace(workspace, options.baseCwd)));
    }

    await runMinimalLoop({
      ...(workspace ? { baseCwd: options.baseCwd, workspace } : {}),
      childSessionRunner: createChildSessionRunner({
        baseCwd: options.baseCwd,
        model: options.model,
        parentLifecycleEmitter: lifecycleEmitter,
        parentSessionId: sessionTrace.metadata.id,
      }),
      cwd: executionCwd,
      lifecycleEmitter,
      maxToolRounds: options.maxToolRounds,
      model: options.model,
      ...(workspace ? { promptAssets: await loadRepoPromptAssets(options.baseCwd) } : {}),
      runtimeState: runtimeStateTrace.getState,
      task: scheduledTask,
    });

    return {
      sessionId: sessionTrace.metadata.id,
      status: "completed",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      sessionId: sessionTrace.metadata.id,
      status: "failed",
    };
  }
}

function toDisplayWorkspace(
  workspace: SessionWorkspaceMetadata,
  baseCwd: string,
): SessionWorkspaceMetadata {
  return {
    ...workspace,
    path: path.relative(baseCwd, workspace.path),
  };
}
