import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadRepoPromptAssets } from "../context/promptAssembly.js";
import { DEFAULT_MODEL, runMinimalLoop, type ResponseCreate } from "../core/minimalLoop.js";
import type { PermissionApprover, PermissionPolicy } from "../governance/types.js";
import {
  createCliSessionTrace,
  type ChildSessionProfile,
  type SessionWorkspaceMetadata,
} from "../runtime/session.js";
import { prepareWorktreeSession } from "../runtime/sessionWorkspace.js";
import type { TraceRecorder } from "../runtime/trace.js";
import { createNoopTraceRecorder } from "../runtime/trace.js";
import { createEditTool } from "../tools/editTool.js";
import { createFindTool } from "../tools/findTool.js";
import { createGrepTool } from "../tools/grepTool.js";
import { createLsTool } from "../tools/lsTool.js";
import { createReadTool } from "../tools/readTool.js";
import { createToolRuntime } from "../tools/runtime.js";
import { createTodoTool } from "../tools/todoTool.js";
import type {
  ChildSessionRunRequest,
  ChildSessionRunResult,
  DelegateChildSessionRunner,
} from "../tools/delegateTool.js";
import type { ToolRuntime } from "../tools/types.js";
import { createWriteTool } from "../tools/writeTool.js";
import { createLifecycleEmitter, type LifecycleEmitter } from "./lifecycle.js";

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
}

export function createChildSessionRunner(options: CreateChildSessionRunnerOptions): ChildSessionRunner {
  return {
    async run(request) {
      return runChildSession(options, request);
    },
  };
}

export function createChildProfileToolRuntime(options: {
  cwd: string;
  profile: ChildSessionProfile;
}): ToolRuntime {
  const inspectTools = [
    createReadTool(options.cwd),
    createLsTool(options.cwd),
    createGrepTool(options.cwd),
    createFindTool(options.cwd),
    createTodoTool(),
  ];

  if (options.profile === "research") {
    return createToolRuntime(inspectTools);
  }

  return createToolRuntime([...inspectTools.slice(0, 4), createEditTool(options.cwd), createWriteTool(options.cwd), createTodoTool()]);
}

export function formatChildProfileTask(options: { profile: ChildSessionProfile; task: string }): string {
  const contract =
    options.profile === "research"
      ? [
          "You are a fresh research child session.",
          "Use the available read-only tools to investigate the delegated task.",
          "Report findings, evidence, open questions, and the next step in your final answer.",
        ].join("\n")
      : [
          "You are a fresh edit child session running in an isolated git worktree.",
          "Use file editing tools only for the delegated task.",
          "In your final answer, describe what changed, the evidence you checked, and the review or merge next step.",
        ].join("\n");

  return [contract, "", "Delegated task:", options.task].join("\n");
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

async function runChildSession(
  options: CreateChildSessionRunnerOptions,
  request: ChildSessionRunRequest,
): Promise<ChildSessionRunResult> {
  const childTask = formatChildProfileTask({ profile: request.profile, task: request.task });
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
  });
  const childLifecycleEmitter = createLifecycleEmitter({ recorder: childTrace.recorder });
  let executionCwd = options.baseCwd;
  let workspace: SessionWorkspaceMetadata | undefined;

  await options.parentLifecycleEmitter.emit({
    childSessionId: childTrace.metadata.id,
    parentCallId: request.parentCallId,
    profile: request.profile,
    round: request.parentRound,
    task: request.task,
    tracePath: childTrace.paths.tracePath,
    type: "child_session_started",
  });

  try {
    if (request.profile === "edit") {
      workspace = await prepareWorktreeSession({
        baseCwd: options.baseCwd,
        lifecycleEmitter: childLifecycleEmitter,
        sessionTrace: childTrace,
      });
      executionCwd = workspace.path;
    }

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
      promptAssets: await loadRepoPromptAssets(options.baseCwd),
      ...(options.responseCreate ? { responseCreate: options.responseCreate } : {}),
      task: childTask,
      toolRuntime: createChildProfileToolRuntime({ cwd: executionCwd, profile: request.profile }),
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
    await options.parentLifecycleEmitter.emit({
      childSessionId: childTrace.metadata.id,
      parentCallId: request.parentCallId,
      profile: request.profile,
      reason,
      round: request.parentRound,
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
