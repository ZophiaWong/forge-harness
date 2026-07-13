import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceBinding {
  baseBranch: string;
  baseCommit: string;
  baseCwd: string;
  branch: string;
  mode: "git_worktree";
  path: string;
}

export interface CreateGitWorktreeWorkspaceOptions {
  baseCwd: string;
  sessionId: string;
}

export class WorkspaceSetupError extends Error {
  readonly baseCwd: string;
  readonly branch: string;
  readonly workspacePath: string;

  constructor(message: string, options: { baseCwd: string; branch: string; workspacePath: string }) {
    super(message);
    this.name = "WorkspaceSetupError";
    this.baseCwd = options.baseCwd;
    this.branch = options.branch;
    this.workspacePath = options.workspacePath;
  }
}

export function createWorktreePath(baseCwd: string, sessionId: string): string {
  return path.join(baseCwd, ".forge", "worktrees", sessionId);
}

export function createWorktreeBranchName(sessionId: string): string {
  return `forge/run/${sessionId}`;
}

export async function createGitWorktreeWorkspace(
  options: CreateGitWorktreeWorkspaceOptions,
): Promise<WorkspaceBinding> {
  const baseCwd = path.resolve(options.baseCwd);
  const workspacePath = createWorktreePath(baseCwd, options.sessionId);
  const branch = createWorktreeBranchName(options.sessionId);

  const fail = (message: string): WorkspaceSetupError =>
    new WorkspaceSetupError(message, { baseCwd, branch, workspacePath });

  const root = await git(["rev-parse", "--show-toplevel"], baseCwd).catch((error: unknown) => {
    throw fail(`worktree isolation requires a git repository: ${formatGitError(error)}`);
  });

  if (path.resolve(root.stdout.trim()) !== baseCwd) {
    throw fail(`base cwd must be the git repository root; got ${baseCwd}`);
  }

  const baseBranch = await git(["branch", "--show-current"], baseCwd).then((result) => result.stdout.trim());
  const baseCommit = await git(["rev-parse", "HEAD"], baseCwd).then((result) => result.stdout.trim());

  if (!baseCommit) {
    throw fail("could not resolve HEAD for worktree base");
  }

  if (await pathExists(workspacePath)) {
    throw fail(`worktree path already exists: ${workspacePath}`);
  }

  const branchExists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], baseCwd)
    .then(() => true)
    .catch(() => false);

  if (branchExists) {
    throw fail(`worktree branch already exists: ${branch}`);
  }

  const status = await git(["status", "--porcelain=v1", "--untracked-files=normal"], baseCwd);
  const dirtyLines = status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !isForgeRuntimeStateStatusLine(line));

  if (dirtyLines.length > 0) {
    throw fail("base repo must be clean before creating an isolated worktree");
  }

  await fs.mkdir(path.dirname(workspacePath), { recursive: true });

  await git(["worktree", "add", workspacePath, "-b", branch, baseCommit], baseCwd).catch((error: unknown) => {
    throw fail(`failed to create git worktree: ${formatGitError(error)}`);
  });

  return {
    baseBranch: baseBranch || "(detached)",
    baseCommit,
    baseCwd,
    branch,
    mode: "git_worktree",
    path: workspacePath,
  };
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

async function pathExists(pathname: string): Promise<boolean> {
  return fs.access(pathname).then(
    () => true,
    () => false,
  );
}

function isForgeRuntimeStateStatusLine(line: string): boolean {
  const pathname = line.slice(3);
  return pathname.startsWith(".forge/sessions/");
}

function formatGitError(error: unknown): string {
  if (isExecError(error)) {
    return (error.stderr || error.message).trim();
  }

  return error instanceof Error ? error.message : String(error);
}

function isExecError(error: unknown): error is Error & { stderr?: string } {
  return error instanceof Error && "stderr" in error;
}
