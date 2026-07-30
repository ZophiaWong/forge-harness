import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunArtifactInventory {
  sessionsRoot: string;
  worktreesRoot: string;
  sessionCount: number;
  worktreeRootEntryCount: number;
  registeredWorktrees: string[];
  hasArtifacts: boolean;
}

export interface GitWorktreeAdapter {
  list(cwd: string): Promise<string[]>;
  remove(cwd: string, worktreePath: string): Promise<void>;
  prune(cwd: string): Promise<void>;
}

export interface RunArtifactCleanupFailure {
  operation: "remove_worktree" | "prune";
  path: string;
  message: string;
}

export interface RunArtifactCleanupResult {
  inventory: RunArtifactInventory;
  removedWorktrees: string[];
  failures: RunArtifactCleanupFailure[];
  pruned: boolean;
  sessionsRemoved: boolean;
  worktreesRootRemoved: boolean;
}

export function createGitWorktreeAdapter(): GitWorktreeAdapter {
  return {
    async list(cwd) {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
        cwd,
        encoding: "utf8",
      });
      return stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => path.resolve(cwd, line.slice("worktree ".length)));
    },
    async remove(cwd, worktreePath) {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd,
        encoding: "utf8",
      });
    },
    async prune(cwd) {
      await execFileAsync("git", ["worktree", "prune"], {
        cwd,
        encoding: "utf8",
      });
    },
  };
}

export async function inspectRunArtifacts(options: {
  cwd: string;
  git?: GitWorktreeAdapter;
}): Promise<RunArtifactInventory> {
  const cwd = path.resolve(options.cwd);
  const forgeRoot = path.join(cwd, ".forge");
  const sessionsRoot = path.join(forgeRoot, "sessions");
  const worktreesRoot = path.join(forgeRoot, "worktrees");
  const git = options.git ?? createGitWorktreeAdapter();
  const [sessionCount, worktreeRootEntryCount, worktrees] = await Promise.all([
    countEntries(sessionsRoot),
    countEntries(worktreesRoot),
    git.list(cwd),
  ]);
  const registeredWorktrees = worktrees
    .map((worktreePath) => path.resolve(cwd, worktreePath))
    .filter((worktreePath) => isStrictDescendant(worktreesRoot, worktreePath))
    .sort(compareDeepestFirst);

  return {
    sessionsRoot,
    worktreesRoot,
    sessionCount,
    worktreeRootEntryCount,
    registeredWorktrees,
    hasArtifacts:
      sessionCount > 0 || worktreeRootEntryCount > 0 || registeredWorktrees.length > 0,
  };
}

export async function cleanupRunArtifacts(options: {
  cwd: string;
  git?: GitWorktreeAdapter;
}): Promise<RunArtifactCleanupResult> {
  const cwd = path.resolve(options.cwd);
  const git = options.git ?? createGitWorktreeAdapter();
  const inventory = await inspectRunArtifacts({ cwd, git });
  const removedWorktrees: string[] = [];
  const failures: RunArtifactCleanupFailure[] = [];

  for (const worktreePath of inventory.registeredWorktrees) {
    if (!(await pathExists(worktreePath))) {
      continue;
    }
    try {
      await git.remove(cwd, worktreePath);
      removedWorktrees.push(worktreePath);
    } catch (error) {
      failures.push({
        operation: "remove_worktree",
        path: worktreePath,
        message: errorMessage(error),
      });
    }
  }

  let pruned = false;
  try {
    await git.prune(cwd);
    pruned = true;
  } catch (error) {
    failures.push({
      operation: "prune",
      path: inventory.worktreesRoot,
      message: errorMessage(error),
    });
  }

  if (failures.length > 0) {
    return {
      inventory,
      removedWorktrees,
      failures,
      pruned,
      sessionsRemoved: false,
      worktreesRootRemoved: false,
    };
  }

  assertGeneratedRoot(cwd, inventory.worktreesRoot, "worktrees");
  assertGeneratedRoot(cwd, inventory.sessionsRoot, "sessions");
  await fs.rm(inventory.worktreesRoot, { force: true, recursive: true });
  await fs.rm(inventory.sessionsRoot, { force: true, recursive: true });

  return {
    inventory,
    removedWorktrees,
    failures,
    pruned,
    sessionsRemoved: true,
    worktreesRootRemoved: true,
  };
}

async function countEntries(directory: string): Promise<number> {
  try {
    return (await fs.readdir(directory)).length;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isStrictDescendant(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function compareDeepestFirst(left: string, right: string): number {
  const depthDifference = pathDepth(right) - pathDepth(left);
  return depthDifference === 0 ? left.localeCompare(right) : depthDifference;
}

function pathDepth(target: string): number {
  return path.resolve(target).split(path.sep).filter(Boolean).length;
}

function assertGeneratedRoot(cwd: string, target: string, basename: string): void {
  const forgeRoot = path.join(path.resolve(cwd), ".forge");
  if (path.dirname(target) !== forgeRoot || path.basename(target) !== basename) {
    throw new Error(`Refusing to remove unexpected run artifact path: ${target}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
