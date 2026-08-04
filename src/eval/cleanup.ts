import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const EVAL_RUN_MARKER = ".forge-eval-run.json";

export interface EvalRunMarker {
  artifactType: "forge-eval-run";
  runId: string;
  status: "completed" | "invalid" | "running";
  worktrees: Array<{
    gitRoot: string;
    path: string;
  }>;
}

export interface RemoveEvalWorktreeInput {
  gitRoot: string;
  worktreePath: string;
}

export interface CleanEvalRunsOptions {
  confirmed: boolean;
  evalRoot: string;
  repositoryRoot: string;
  removeWorktree?: (input: RemoveEvalWorktreeInput) => Promise<void>;
}

export interface CleanEvalRunsResult {
  removedRunIds: string[];
  skippedActiveRunIds: string[];
  skippedUnmarkedNames: string[];
}

interface PreparedRun {
  marker: EvalRunMarker;
  root: string;
  worktrees: RemoveEvalWorktreeInput[];
}

export async function cleanEvalRuns(options: CleanEvalRunsOptions): Promise<CleanEvalRunsResult> {
  if (!options.confirmed) {
    throw new Error("eval clean requires confirmation; pass --yes for non-interactive cleanup");
  }
  const exists = await assertEvalRootBoundary(options.repositoryRoot, options.evalRoot);
  if (!exists) {
    return emptyResult();
  }
  const evalRoot = path.resolve(options.evalRoot);

  const entries = (await fs.readdir(evalRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const prepared: PreparedRun[] = [];
  const skippedActiveRunIds: string[] = [];
  const skippedUnmarkedNames: string[] = [];

  for (const entry of entries) {
    const runRoot = path.join(evalRoot, entry.name);
    const entryStat = await fs.lstat(runRoot);
    if (entry.isSymbolicLink() || entryStat.isSymbolicLink()) {
      throw new Error(`eval clean refuses symlinked run entry ${entry.name}`);
    }
    if (!entryStat.isDirectory()) {
      skippedUnmarkedNames.push(entry.name);
      continue;
    }

    const marker = await readMarker(path.join(runRoot, EVAL_RUN_MARKER));
    if (!marker) {
      skippedUnmarkedNames.push(entry.name);
      continue;
    }
    if (marker.runId !== entry.name) {
      throw new Error(`eval run marker id ${marker.runId} does not match directory ${entry.name}`);
    }
    if (marker.status === "running") {
      skippedActiveRunIds.push(marker.runId);
      continue;
    }

    const worktrees = await Promise.all(marker.worktrees.map(async (worktree) => {
      const gitRoot = resolveLexicallyInsideRun(runRoot, worktree.gitRoot);
      const worktreePath = resolveLexicallyInsideRun(runRoot, worktree.path);
      await Promise.all([
        assertRealPathInsideRun(runRoot, gitRoot),
        assertRealPathInsideRun(runRoot, worktreePath),
      ]);
      return { gitRoot, worktreePath };
    }));
    prepared.push({ marker, root: runRoot, worktrees });
  }

  const removeWorktree = options.removeWorktree ?? removeRegisteredWorktree;
  const removedRunIds: string[] = [];
  for (const run of prepared) {
    for (const worktree of run.worktrees) {
      await removeWorktree(worktree);
    }
    await fs.rm(run.root, { recursive: true });
    removedRunIds.push(run.marker.runId);
  }

  return { removedRunIds, skippedActiveRunIds, skippedUnmarkedNames };
}

async function assertEvalRootBoundary(repositoryRootInput: string, evalRootInput: string): Promise<boolean> {
  const repositoryRoot = path.resolve(repositoryRootInput);
  const forgeRoot = path.join(repositoryRoot, ".forge");
  const expectedEvalRoot = path.join(forgeRoot, "evals");
  const evalRoot = path.resolve(evalRootInput);
  if (evalRoot !== expectedEvalRoot) {
    throw new Error("eval clean root must be exactly <repository>/.forge/evals");
  }
  const repositoryStat = await fs.lstat(repositoryRoot);
  if (repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory()) {
    throw new Error("repository root must be a real directory, not a symlink");
  }
  for (const [label, candidate] of [
    [".forge directory", forgeRoot],
    ["eval clean root", evalRoot],
  ] as const) {
    const stat = await lstatIfExists(candidate);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} must be a real directory, not a symlink`);
    }
  }
  const [realRepositoryRoot, realForgeRoot, realEvalRoot] = await Promise.all([
    fs.realpath(repositoryRoot),
    fs.realpath(forgeRoot),
    fs.realpath(evalRoot),
  ]);
  if (realForgeRoot !== path.join(realRepositoryRoot, ".forge")
    || realEvalRoot !== path.join(realForgeRoot, "evals")) {
    throw new Error("eval clean root escaped the repository path chain");
  }
  return true;
}

async function readMarker(markerPath: string): Promise<EvalRunMarker | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!isRecord(raw)
    || raw.artifactType !== "forge-eval-run"
    || typeof raw.runId !== "string"
    || !/^[a-z0-9][a-z0-9-]*$/.test(raw.runId)
    || !["completed", "invalid", "running"].includes(String(raw.status))
    || !Array.isArray(raw.worktrees)
    || !raw.worktrees.every((worktree) => isRecord(worktree)
      && typeof worktree.gitRoot === "string"
      && typeof worktree.path === "string")) {
    throw new Error(`invalid eval run marker at ${markerPath}`);
  }
  return raw as unknown as EvalRunMarker;
}

function resolveLexicallyInsideRun(runRoot: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("registered worktree paths must stay inside the eval run");
  }
  const resolved = path.resolve(runRoot, relativePath);
  const relative = path.relative(runRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("registered worktree paths must stay inside the eval run");
  }
  return resolved;
}

async function assertRealPathInsideRun(runRoot: string, resolved: string): Promise<void> {
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error("registered worktree paths must not be symlinks");
  }
  const [realRunRoot, realResolved] = await Promise.all([
    fs.realpath(runRoot),
    fs.realpath(resolved),
  ]);
  const realRelative = path.relative(realRunRoot, realResolved);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("registered worktree paths must stay inside the eval run");
  }
}

async function removeRegisteredWorktree(input: RemoveEvalWorktreeInput): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", input.worktreePath], {
    cwd: input.gitRoot,
  });
}

async function lstatIfExists(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function emptyResult(): CleanEvalRunsResult {
  return { removedRunIds: [], skippedActiveRunIds: [], skippedUnmarkedNames: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
