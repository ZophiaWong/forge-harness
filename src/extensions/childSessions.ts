import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadRepoPromptAssets } from "../context/promptAssembly.js";
import { DEFAULT_MODEL, runMinimalLoop, type ResponseCreate } from "../core/minimalLoop.js";
import type { PermissionApprover, PermissionPolicy } from "../governance/types.js";
import {
  createCliSessionTrace,
  type ChildSessionProfile,
  type SessionTaskGraphBinding,
  type SessionWorkspaceMetadata,
} from "../runtime/session.js";
import { prepareWorktreeSession } from "../runtime/sessionWorkspace.js";
import { createFileTeamTaskStore } from "../runtime/teamTaskStore.js";
import type { TraceRecorder } from "../runtime/trace.js";
import { createNoopTraceRecorder } from "../runtime/trace.js";
import { createEditTool } from "../tools/editTool.js";
import { createFindTool } from "../tools/findTool.js";
import { createGrepTool } from "../tools/grepTool.js";
import { createLsTool } from "../tools/lsTool.js";
import { createReadTool } from "../tools/readTool.js";
import { createToolRuntime } from "../tools/runtime.js";
import { createTeamTaskTools } from "../tools/teamTaskTools.js";
import { createTodoTool } from "../tools/todoTool.js";
import type {
  ChildSessionRunHandle,
  ChildSessionRunRequest,
  ChildSessionRunResult,
  DelegateChildSessionRunner,
} from "../tools/delegateTool.js";
import type { ToolRuntime } from "../tools/types.js";
import { createWriteTool } from "../tools/writeTool.js";
import { createLifecycleEmitter, type LifecycleEmitter } from "./lifecycle.js";
import type { TeamTaskResultSource } from "../domain/teamTask.js";
import type { TeamTaskActor } from "../domain/teamTask.js";
import type { GitIntegrationService } from "../runtime/gitIntegration.js";

const execFileAsync = promisify(execFile);

export type ChildSessionRunner = DelegateChildSessionRunner;

export interface CreateChildSessionRunnerOptions {
  apiKey?: string;
  approver?: PermissionApprover;
  baseCwd: string;
  baseURL?: string;
  model?: string;
  parentLifecycleEmitter: LifecycleEmitter;
  parentSessionId: string;
  permissionPolicy?: PermissionPolicy;
  responseCreate?: ResponseCreate;
  signal?: AbortSignal;
  taskGraph?: SessionTaskGraphBinding;
}

export function createChildSessionRunner(options: CreateChildSessionRunnerOptions): ChildSessionRunner {
  return {
    async run(request) {
      return (await startChildSession(options, request)).promise;
    },
    async start(request) {
      return startChildSession(options, request);
    },
  };
}

export function createChildProfileToolRuntime(options: {
  cwd: string;
  gitIntegration?: GitIntegrationService;
  ownWorkspace?: {
    branch: string;
    path: string;
  };
  profile: ChildSessionProfile;
  sessionId?: string;
  taskActor?: TeamTaskActor;
  taskGraph?: SessionTaskGraphBinding;
}): ToolRuntime {
  const inspectTools = [
    createReadTool(options.cwd),
    createLsTool(options.cwd),
    createGrepTool(options.cwd),
    createFindTool(options.cwd),
    createTodoTool(),
  ];
  const taskTools = options.taskGraph && options.sessionId
    ? createTeamTaskTools({
        actor: options.taskActor ?? {
          ...(options.taskGraph.delegatedTaskId
            ? { delegatedTaskId: options.taskGraph.delegatedTaskId }
            : {}),
          profile: options.profile,
          role: "child",
          sessionId: options.sessionId,
        },
        ...(options.gitIntegration ? { gitIntegration: options.gitIntegration } : {}),
        ...(options.ownWorkspace ? { ownWorkspace: options.ownWorkspace } : {}),
        store: createFileTeamTaskStore({ graphPath: options.taskGraph.taskGraphPath }),
      })
    : [];

  if (options.profile === "research") {
    return createToolRuntime([...inspectTools, ...taskTools]);
  }

  return createToolRuntime([
    ...inspectTools.slice(0, 4),
    createEditTool(options.cwd),
    createWriteTool(options.cwd),
    createTodoTool(),
    ...taskTools,
  ]);
}

export function formatChildProfileTask(options: {
  profile: ChildSessionProfile;
  task: string;
  taskId?: string;
}): string {
  const contract =
    options.profile === "research"
      ? [
          "You are a fresh research child session.",
          "Use inspect-only tools to investigate the delegated task without editing project files.",
          ...(options.taskId
            ? [
                "task_add_evidence is permitted coordination metadata and does not edit project files.",
                "Use it when the delegated task requests evidence.",
                "Follow the explicit delegated task before doing any broader investigation; do not inspect unrelated files after the requested evidence is recorded.",
              ]
            : []),
          "Report findings, evidence, open questions, and the next step in your final answer.",
        ].join("\n")
      : [
          "You are a fresh edit child session running in an isolated git worktree.",
          "Use file editing tools only for the delegated task.",
          "In your final answer, describe what changed, the evidence you checked, and the review or merge next step.",
        ].join("\n");

  return [
    contract,
    ...(options.taskId ? ["", `Linked team task ID: ${options.taskId}`] : []),
    "",
    "Delegated task:",
    options.task,
  ].join("\n");
}

export async function listChangedFiles(cwd: string): Promise<string[]> {
  const status = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd });

  return status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3))
    .filter((file) => file.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

async function startChildSession(
  options: CreateChildSessionRunnerOptions,
  request: ChildSessionRunRequest,
): Promise<ChildSessionRunHandle> {
  options.signal?.throwIfAborted();
  const childTask = formatChildProfileTask({
    profile: request.profile,
    task: request.task,
    ...(request.taskId ? { taskId: request.taskId } : {}),
  });
  if (request.taskId && !options.taskGraph) {
    throw new Error("linked child session requires a root task graph binding");
  }
  const taskGraph = options.taskGraph
    ? {
        ...(request.taskId ? { delegatedTaskId: request.taskId } : {}),
        rootSessionId: options.taskGraph.rootSessionId,
        taskGraphPath: options.taskGraph.taskGraphPath,
      }
    : undefined;
  const childTrace = await createCliSessionTrace({
    child: {
      parentCallId: request.parentCallId,
      parentSessionId: options.parentSessionId,
      profile: request.profile,
      role: "child",
    },
    cwd: options.baseCwd,
    maxToolRounds: request.maxToolRounds,
    model: options.model ?? DEFAULT_MODEL,
    task: childTask,
    ...(taskGraph ? { taskGraph } : {}),
  });
  const childLifecycleEmitter = createLifecycleEmitter({ recorder: childTrace.recorder });
  let executionCwd = options.baseCwd;
  let workspace: SessionWorkspaceMetadata | undefined;
  const childController = new AbortController();
  const parentSignal = options.signal;
  let parentAbortListener: (() => void) | undefined;
  if (parentSignal?.aborted) {
    childController.abort(parentSignal.reason);
  } else if (parentSignal) {
    parentAbortListener = () => childController.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", parentAbortListener, { once: true });
  }
  const detachParentAbortListener = (): void => {
    if (parentSignal && parentAbortListener) {
      parentSignal.removeEventListener("abort", parentAbortListener);
      parentAbortListener = undefined;
    }
  };

  try {
    await options.parentLifecycleEmitter.emit({
      childSessionId: childTrace.metadata.id,
      parentCallId: request.parentCallId,
      profile: request.profile,
      round: request.parentRound,
      runInBackground: request.runInBackground,
      task: request.task,
      tracePath: childTrace.paths.tracePath,
      type: "child_session_started",
    });
  } catch (error) {
    detachParentAbortListener();
    throw error;
  }

  const promise = (async (): Promise<ChildSessionRunResult> => {
    let minimalLoopStarted = false;
    try {
      childController.signal.throwIfAborted();
      if (request.profile === "edit") {
        workspace = await prepareWorktreeSession({
          baseCwd: options.baseCwd,
          lifecycleEmitter: childLifecycleEmitter,
          sessionTrace: childTrace,
        });
        executionCwd = workspace.path;
      }
      childController.signal.throwIfAborted();
      const promptAssets = await loadRepoPromptAssets(options.baseCwd);
      childController.signal.throwIfAborted();

      minimalLoopStarted = true;
      const final = await runMinimalLoop({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.approver ? { approver: options.approver } : {}),
        baseCwd: options.baseCwd,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        cwd: executionCwd,
        lifecycleEmitter: childLifecycleEmitter,
        maxToolRounds: request.maxToolRounds,
        model: options.model,
        ...(options.permissionPolicy ? { permissionPolicy: options.permissionPolicy } : {}),
        promptAssets,
        ...(options.responseCreate ? { responseCreate: options.responseCreate } : {}),
        signal: childController.signal,
        task: childTask,
        toolRuntime: createChildProfileToolRuntime({
          cwd: executionCwd,
          profile: request.profile,
          sessionId: childTrace.metadata.id,
          ...(taskGraph ? { taskGraph } : {}),
        }),
        ...(workspace ? { workspace } : {}),
      });
      const changedFiles = workspace ? await listChangedFiles(workspace.path) : undefined;
      const result: ChildSessionRunResult = {
        ...(changedFiles ? { changedFiles } : {}),
        childSessionId: childTrace.metadata.id,
        finalAnswer: final.finalAnswer,
        profile: request.profile,
        status: "completed",
        tracePath: childTrace.paths.tracePath,
        ...(workspace ? { workspace: { branch: workspace.branch, path: workspace.path } } : {}),
      };

      await options.parentLifecycleEmitter.emit({
        childSessionId: childTrace.metadata.id,
        parentCallId: request.parentCallId,
        profile: request.profile,
        round: request.parentRound,
        runInBackground: request.runInBackground,
        status: "completed",
        tracePath: childTrace.paths.tracePath,
        type: "child_session_finished",
        ...(workspace ? { workspace } : {}),
      });
      await options.parentLifecycleEmitter.emit({
        ...(changedFiles ? { changedFiles } : {}),
        childSessionId: childTrace.metadata.id,
        finalAnswer: final.finalAnswer,
        parentCallId: request.parentCallId,
        profile: request.profile,
        round: request.parentRound,
        tracePath: childTrace.paths.tracePath,
        type: "child_session_handoff",
        ...(workspace ? { workspace } : {}),
      });

      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!minimalLoopStarted) {
        await childLifecycleEmitter.emit({ message: reason, type: "session_failed" });
        await childLifecycleEmitter.emit({ rounds: 0, status: "failed", type: "session_ended" });
      }
      await options.parentLifecycleEmitter.emit({
        childSessionId: childTrace.metadata.id,
        parentCallId: request.parentCallId,
        profile: request.profile,
        reason,
        round: request.parentRound,
        runInBackground: request.runInBackground,
        status: "failed",
        tracePath: childTrace.paths.tracePath,
        type: "child_session_finished",
        ...(workspace ? { workspace } : {}),
      });

      return {
        childSessionId: childTrace.metadata.id,
        finalAnswer: `Child session failed: ${reason}`,
        profile: request.profile,
        status: "failed",
        tracePath: childTrace.paths.tracePath,
        ...(workspace ? { workspace: { branch: workspace.branch, path: workspace.path } } : {}),
      };
    }
  })().finally(detachParentAbortListener);

  return {
    cancel() {
      childController.abort();
    },
    childSessionId: childTrace.metadata.id,
    profile: request.profile,
    promise,
    status: "running",
    tracePath: childTrace.paths.tracePath,
  };
}

export function createNoopChildSessionRunner(): ChildSessionRunner {
  const recorder: TraceRecorder = createNoopTraceRecorder();
  const parentLifecycleEmitter = createLifecycleEmitter({ recorder });

  return createChildSessionRunner({
    baseCwd: process.cwd(),
    parentLifecycleEmitter,
    parentSessionId: "noop-parent",
  });
}

export type AsyncChildSessionStatus = "running" | "completed" | "failed";

export interface AsyncChildSessionNotification {
  changedFiles?: string[];
  childSessionId: string;
  finalAnswer?: string;
  profile: ChildSessionProfile;
  status: AsyncChildSessionStatus;
  tracePath: string;
  workspace?: {
    branch: string;
    path: string;
  };
}

export interface AsyncChildSessionManager extends ChildSessionRunner {
  cancelRunning(): Promise<void>;
  drainNotifications(): AsyncChildSessionNotification[];
  getTerminal(childSessionId: string): ChildSessionTerminalRecord | undefined;
  pendingCount(): number;
  resolveEditSource(childSessionId: string, taskId: string): TeamTaskResultSource;
  runningNotifications(): AsyncChildSessionNotification[];
  settleBeforeFinal(): Promise<AsyncChildSessionNotification[]>;
}

export interface ChildSessionTerminalRecord {
  consumedByTaskId?: string;
  request: ChildSessionRunRequest;
  result: ChildSessionRunResult;
}

export class ChildSessionCancellationContractError extends Error {
  readonly childSessionId: string;

  constructor(childSessionId: string, options: { cause: unknown }) {
    const causeMessage = options.cause instanceof Error
      ? options.cause.message
      : String(options.cause);
    super(
      `Child session "${childSessionId}" cancel() violated its non-throwing, eventual-settlement contract: ${causeMessage}`,
      options,
    );
    this.name = "ChildSessionCancellationContractError";
    this.childSessionId = childSessionId;
  }
}

export function createAsyncChildSessionManager(options: {
  runner: ChildSessionRunner;
}): AsyncChildSessionManager {
  interface ManagedChildSession {
    handle: ChildSessionRunHandle;
    order: number;
    request: ChildSessionRunRequest;
    result?: ChildSessionRunResult;
    settlement: Promise<void>;
    terminalNotified: boolean;
  }

  const sessions: ManagedChildSession[] = [];
  const terminal = new Map<string, ChildSessionTerminalRecord>();
  let nextOrder = 1;

  const rememberTerminal = (
    request: ChildSessionRunRequest,
    result: ChildSessionRunResult,
  ): void => {
    terminal.set(result.childSessionId, {
      request: structuredClone(request),
      result: structuredClone(result),
    });
  };

  return {
    async cancelRunning() {
      const running = sessions.filter((session) => !session.result);
      const cancellationErrors: unknown[] = [];
      const cancellableSettlements: Promise<void>[] = [];
      for (const session of running) {
        try {
          session.handle.cancel();
          cancellableSettlements.push(session.settlement);
        } catch (error) {
          cancellationErrors.push(new ChildSessionCancellationContractError(
            session.handle.childSessionId,
            { cause: error },
          ));
        }
      }
      const settlements = await Promise.allSettled(cancellableSettlements);
      for (const settlement of settlements) {
        if (settlement.status === "rejected") {
          cancellationErrors.push(settlement.reason);
        }
      }
      if (cancellationErrors.length > 0) {
        throw new AggregateError(
          cancellationErrors,
          `Child session cancellation failed: ${cancellationErrors
            .map((error) => error instanceof Error ? error.message : String(error))
            .join("; ")}`,
        );
      }
    },
    drainNotifications() {
      return sessions
        .filter((session) => session.result && !session.terminalNotified)
        .sort((left, right) => left.order - right.order)
        .map((session) => {
          session.terminalNotified = true;
          return toChildSessionNotification(session);
        });
    },
    pendingCount() {
      return sessions.filter((session) => !session.result).length;
    },
    async run(request) {
      const result = await options.runner.run(request);
      rememberTerminal(request, result);
      return result;
    },
    getTerminal(childSessionId) {
      const record = terminal.get(childSessionId);
      return record ? structuredClone(record) : undefined;
    },
    resolveEditSource(childSessionId, taskId) {
      const record = terminal.get(childSessionId);
      if (!record) {
        throw new Error(`unknown terminal child session "${childSessionId}"`);
      }
      if (record.request.taskId !== taskId) {
        throw new Error(
          `child session "${childSessionId}" was delegated task "${String(record.request.taskId)}", not "${taskId}"`,
        );
      }
      if (
        record.request.profile !== "edit"
        || record.result.profile !== "edit"
        || record.result.status !== "completed"
        || !record.result.workspace
      ) {
        throw new Error(`child session "${childSessionId}" is not a completed edit source`);
      }
      if (record.consumedByTaskId && record.consumedByTaskId !== taskId) {
        throw new Error(
          `child session "${childSessionId}" was already used by task "${record.consumedByTaskId}"`,
        );
      }
      record.consumedByTaskId = taskId;
      return {
        childSessionId,
        kind: "child",
        profile: "edit",
        workspace: {
          branch: record.result.workspace.branch,
          path: record.result.workspace.path,
        },
      };
    },
    runningNotifications() {
      return sessions
        .filter((session) => !session.result)
        .sort((left, right) => left.order - right.order)
        .map((session) => toChildSessionNotification(session));
    },
    async settleBeforeFinal() {
      const running = sessions.filter((session) => !session.result);
      if (running.length > 0) {
        await Promise.race(running.map((session) => session.settlement));
      }
      return this.drainNotifications();
    },
    async start(request) {
      const handle = await options.runner.start(request);
      const session: ManagedChildSession = {
        handle,
        order: nextOrder,
        request: structuredClone(request),
        settlement: Promise.resolve(),
        terminalNotified: false,
      };
      session.settlement = handle.promise.then(
        (result) => {
          session.result = result;
          rememberTerminal(session.request, result);
        },
        (error) => {
          session.result = {
            childSessionId: handle.childSessionId,
            finalAnswer: `Child session failed: ${error instanceof Error ? error.message : String(error)}`,
            profile: handle.profile,
            status: "failed",
            tracePath: handle.tracePath,
          };
          rememberTerminal(session.request, session.result);
        },
      );
      nextOrder += 1;
      sessions.push(session);
      return handle;
    },
  };
}

export function formatChildSessionNotification(notification: AsyncChildSessionNotification): string {
  const lines = [
    "<child_session_notification>",
    `child_session_id: ${notification.childSessionId}`,
    `profile: ${notification.profile}`,
    `status: ${notification.status}`,
    `trace_path: ${notification.tracePath}`,
  ];

  if (notification.workspace) {
    lines.push(`workspace_path: ${notification.workspace.path}`);
    lines.push(`workspace_branch: ${notification.workspace.branch}`);
  }

  if (notification.changedFiles) {
    lines.push("changed_files:");
    lines.push(
      ...(notification.changedFiles.length > 0
        ? notification.changedFiles.map((file) => `- ${file}`)
        : ["(none)"]),
    );
  }

  lines.push("handoff:");
  lines.push(notification.finalAnswer ?? "(child session is still running)");
  lines.push("</child_session_notification>");
  return lines.join("\n");
}

function toChildSessionNotification(session: {
  handle: ChildSessionRunHandle;
  result?: ChildSessionRunResult;
}): AsyncChildSessionNotification {
  if (!session.result) {
    return {
      childSessionId: session.handle.childSessionId,
      profile: session.handle.profile,
      status: "running",
      tracePath: session.handle.tracePath,
    };
  }

  return {
    ...(session.result.changedFiles ? { changedFiles: [...session.result.changedFiles] } : {}),
    childSessionId: session.result.childSessionId,
    finalAnswer: session.result.finalAnswer,
    profile: session.result.profile,
    status: session.result.status,
    tracePath: session.result.tracePath,
    ...(session.result.workspace ? { workspace: { ...session.result.workspace } } : {}),
  };
}
