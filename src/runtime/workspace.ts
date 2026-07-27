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

export interface CreateGitTeammateWorkspaceOptions {
  baseCwd: string;
  name: string;
  rootSessionId: string;
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

export function createTeammateWorktreePath(
  baseCwd: string,
  rootSessionId: string,
  name: string,
): string {
  validateWorkspaceSegment(rootSessionId, "root session id");
  validateWorkspaceSegment(name, "teammate name");
  return path.join(
    baseCwd,
    ".forge",
    "worktrees",
    rootSessionId,
    "teammates",
    name,
  );
}

export function createTeammateWorktreeBranchName(
  rootSessionId: string,
  name: string,
): string {
  validateWorkspaceSegment(rootSessionId, "root session id");
  validateWorkspaceSegment(name, "teammate name");
  return `forge/teammate/${rootSessionId}/${name}`;
}

export async function createGitWorktreeWorkspace(
  options: CreateGitWorktreeWorkspaceOptions,
): Promise<WorkspaceBinding> {
  const baseCwd = path.resolve(options.baseCwd);
  const workspacePath = createWorktreePath(baseCwd, options.sessionId);
  const branch = createWorktreeBranchName(options.sessionId);

  return createWorkspace({ baseCwd, branch, workspacePath });
}

export async function createGitTeammateWorkspace(
  options: CreateGitTeammateWorkspaceOptions,
): Promise<WorkspaceBinding> {
  const baseCwd = path.resolve(options.baseCwd);
  const workspacePath = createTeammateWorktreePath(
    baseCwd,
    options.rootSessionId,
    options.name,
  );
  const branch = createTeammateWorktreeBranchName(options.rootSessionId, options.name);

  return createWorkspace({ baseCwd, branch, workspacePath });
}

async function createWorkspace(options: {
  baseCwd: string;
  branch: string;
  workspacePath: string;
}): Promise<WorkspaceBinding> {
  const { baseCwd, branch, workspacePath } = options;
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

function validateWorkspaceSegment(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) {
    throw new Error(`${field} must contain only letters, numbers, and hyphens`);
  }
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
