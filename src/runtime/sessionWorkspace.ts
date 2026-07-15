import {
  createGitWorktreeWorkspace,
  createWorktreeBranchName,
  createWorktreePath,
  type WorkspaceSetupError,
} from "./workspace.js";
import {
  createSessionMetadata,
  type CliSessionTrace,
  type SessionWorkspaceMetadata,
  writeSessionMetadata,
} from "./session.js";
import type { LifecycleEmitter } from "../extensions/lifecycle.js";

export interface PrepareWorktreeSessionOptions {
  baseCwd: string;
  lifecycleEmitter: LifecycleEmitter;
  sessionTrace: CliSessionTrace;
}

export async function prepareWorktreeSession(
  options: PrepareWorktreeSessionOptions,
): Promise<SessionWorkspaceMetadata> {
  try {
    const binding = await createGitWorktreeWorkspace({
      baseCwd: options.baseCwd,
      sessionId: options.sessionTrace.metadata.id,
    });
    const workspace = toSessionWorkspaceMetadata(binding);
    const metadata = createSessionMetadata({
      ...(options.sessionTrace.metadata.child ? { child: options.sessionTrace.metadata.child } : {}),
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

export function toSessionWorkspaceMetadata(binding: {
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

export function workspaceSetupFailureDetails(
  error: unknown,
  baseCwd: string,
  sessionId: string,
): { branch: string; reason: string; workspacePath: string } {
  if (isWorkspaceSetupError(error)) {
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

function isWorkspaceSetupError(error: unknown): error is WorkspaceSetupError {
  return error instanceof Error && error.name === "WorkspaceSetupError" && "branch" in error && "workspacePath" in error;
}
