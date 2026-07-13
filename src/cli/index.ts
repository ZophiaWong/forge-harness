#!/usr/bin/env node

import "dotenv/config";
import path from "node:path";

import { createCliApprover } from "./approval.js";
import { type ParsedCliArgs, parseCliArgs, usageText } from "./args.js";
import {
  formatContextCompactionTranscript,
  formatFunctionCallTranscript,
  formatHookLogTranscript,
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
import { createCronWorker, type ScheduledRunResult } from "../extensions/cronWorker.js";
import { createLifecycleEmitter, type LifecycleHook } from "../extensions/lifecycle.js";
import type { CronSchedule } from "../runtime/cronStore.js";
import { createFileCronScheduleStore } from "../runtime/cronStore.js";
import {
  createCliSessionTrace,
  createSessionMetadata,
  type CliSessionTrace,
  type SessionWorkspaceMetadata,
  writeSessionMetadata,
} from "../runtime/session.js";
import { createRuntimeStateRecorder, type RuntimeState } from "../runtime/state.js";
import { createCommandVerifier } from "../runtime/verification.js";
import {
  createGitWorktreeWorkspace,
  createWorktreeBranchName,
  createWorktreePath,
  WorkspaceSetupError,
} from "../runtime/workspace.js";

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

  if (!task) {
    console.error(usageText("forge-harness"));
    process.exitCode = 1;
    return;
  }

  try {
    const baseCwd = process.cwd();
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
    const hooks: LifecycleHook[] = cliArgs.hookLog
      ? [
          {
            name: "event-log",
            handle(event) {
              console.log(formatHookLogTranscript(event));
            },
          },
        ]
      : [];
    const lifecycleEmitter = createLifecycleEmitter({
      hookResultRecorder: sessionTrace.recorder,
      hooks,
      recorder: runtimeStateTrace.recorder,
    });
    getRuntimeState = runtimeStateTrace.getState;
    const displayTracePath = path.relative(baseCwd, sessionTrace.paths.tracePath);

    console.log(formatSessionTranscript(sessionTrace.metadata.id, displayTracePath));

    const workspace = cliArgs.worktree
      ? await prepareWorktreeSession({
          baseCwd,
          lifecycleEmitter,
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

    await runMinimalLoop({
      approver: createCliApprover(),
      ...(workspace ? { baseCwd, workspace } : {}),
      cronSchedules,
      cwd: executionCwd,
      lifecycleEmitter,
      maxToolRounds,
      model,
      ...(workspace ? { promptAssets: await loadRepoPromptAssets(baseCwd) } : {}),
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

interface PrepareWorktreeSessionOptions {
  baseCwd: string;
  lifecycleEmitter: ReturnType<typeof createLifecycleEmitter>;
  sessionTrace: CliSessionTrace;
}

async function prepareWorktreeSession(options: PrepareWorktreeSessionOptions): Promise<SessionWorkspaceMetadata> {
  try {
    const binding = await createGitWorktreeWorkspace({
      baseCwd: options.baseCwd,
      sessionId: options.sessionTrace.metadata.id,
    });
    const workspace = toSessionWorkspaceMetadata(binding);
    const metadata = createSessionMetadata({
      baseCwd: options.baseCwd,
      cwd: workspace.path,
      id: options.sessionTrace.metadata.id,
      maxToolRounds: options.sessionTrace.metadata.maxToolRounds,
      model: options.sessionTrace.metadata.model,
      startedAt: options.sessionTrace.metadata.startedAt,
      task: options.sessionTrace.metadata.task,
      tracePath: options.sessionTrace.metadata.tracePath,
      workspace,
    });

    options.sessionTrace.metadata = metadata;
    await writeSessionMetadata(options.sessionTrace.paths.sessionMetadataPath, metadata);
    return workspace;
  } catch (error) {
    const details = workspaceSetupFailureDetails(error, options.baseCwd, options.sessionTrace.metadata.id);
    await options.lifecycleEmitter.emit({
      baseCwd: options.baseCwd,
      branch: details.branch,
      reason: details.reason,
      type: "workspace_setup_failed",
      workspacePath: details.workspacePath,
    });
    throw error;
  }
}

function toSessionWorkspaceMetadata(binding: {
  baseBranch: string;
  baseCommit: string;
  branch: string;
  mode: "git_worktree";
  path: string;
}): SessionWorkspaceMetadata {
  return {
    baseBranch: binding.baseBranch,
    baseCommit: binding.baseCommit,
    branch: binding.branch,
    mode: binding.mode,
    path: binding.path,
  };
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

function workspaceSetupFailureDetails(
  error: unknown,
  baseCwd: string,
  sessionId: string,
): { branch: string; reason: string; workspacePath: string } {
  if (error instanceof WorkspaceSetupError) {
    return {
      branch: error.branch,
      reason: error.message,
      workspacePath: error.workspacePath,
    };
  }

  return {
    branch: createWorktreeBranchName(sessionId),
    reason: error instanceof Error ? error.message : String(error),
    workspacePath: createWorktreePath(baseCwd, sessionId),
  };
}
