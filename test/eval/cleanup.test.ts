import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanEvalRuns,
  EVAL_RUN_MARKER,
  type EvalRunMarker,
} from "../../src/eval/cleanup.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function createEvalRoot(): Promise<string> {
  const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-clean-"));
  tempRoots.push(repositoryRoot);
  const evalRoot = path.join(repositoryRoot, ".forge", "evals");
  await fs.mkdir(evalRoot, { recursive: true });
  return evalRoot;
}

function repositoryRootFor(evalRoot: string): string {
  return path.dirname(path.dirname(evalRoot));
}

async function createRun(
  evalRoot: string,
  runId: string,
  status: EvalRunMarker["status"],
  worktrees: EvalRunMarker["worktrees"] = [],
): Promise<string> {
  const runRoot = path.join(evalRoot, runId);
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(path.join(runRoot, EVAL_RUN_MARKER), JSON.stringify({
    artifactType: "forge-eval-run",
    runId,
    status,
    worktrees,
  }), "utf8");
  return runRoot;
}

describe("eval artifact cleanup", () => {
  it("requires explicit confirmation before deleting marked runs", async () => {
    const evalRoot = await createEvalRoot();
    const runRoot = await createRun(evalRoot, "run-001", "completed");

    await expect(cleanEvalRuns({
      confirmed: false,
      evalRoot,
      repositoryRoot: repositoryRootFor(evalRoot),
    })).rejects.toThrow(/--yes/);
    await expect(fs.stat(runRoot)).resolves.toBeDefined();
  });

  it("returns an empty result when the repository has no .forge directory", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-repo-"));
    tempRoots.push(repositoryRoot);
    const removeWorktree = vi.fn(async () => {});

    await expect(cleanEvalRuns({
      confirmed: true,
      evalRoot: path.join(repositoryRoot, ".forge", "evals"),
      repositoryRoot,
      removeWorktree,
    })).resolves.toEqual({
      removedRunIds: [],
      skippedActiveRunIds: [],
      skippedUnmarkedNames: [],
    });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("returns an empty result when .forge has no evals directory", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-repo-"));
    tempRoots.push(repositoryRoot);
    await fs.mkdir(path.join(repositoryRoot, ".forge"));
    const removeWorktree = vi.fn(async () => {});

    await expect(cleanEvalRuns({
      confirmed: true,
      evalRoot: path.join(repositoryRoot, ".forge", "evals"),
      repositoryRoot,
      removeWorktree,
    })).resolves.toEqual({
      removedRunIds: [],
      skippedActiveRunIds: [],
      skippedUnmarkedNames: [],
    });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("removes completed runs after registered worktrees while preserving active and unmarked directories", async () => {
    const evalRoot = await createEvalRoot();
    const completed = await createRun(evalRoot, "run-001", "completed", [{
      gitRoot: "fixture",
      path: "fixture-worktree",
    }]);
    await fs.mkdir(path.join(completed, "fixture"));
    await fs.mkdir(path.join(completed, "fixture-worktree"));
    const active = await createRun(evalRoot, "run-002", "running");
    const unmarked = path.join(evalRoot, "notes");
    await fs.mkdir(unmarked);
    const removeWorktree = vi.fn(async () => {});

    const result = await cleanEvalRuns({
      confirmed: true,
      evalRoot,
      repositoryRoot: repositoryRootFor(evalRoot),
      removeWorktree,
    });

    expect(result).toEqual({
      removedRunIds: ["run-001"],
      skippedActiveRunIds: ["run-002"],
      skippedUnmarkedNames: ["notes"],
    });
    expect(removeWorktree).toHaveBeenCalledWith({
      gitRoot: path.join(completed, "fixture"),
      worktreePath: path.join(completed, "fixture-worktree"),
    });
    await expect(fs.stat(completed)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(active)).resolves.toBeDefined();
    await expect(fs.stat(unmarked)).resolves.toBeDefined();
  });

  it("rejects symlinked run directories before deleting any valid run", async () => {
    const evalRoot = await createEvalRoot();
    const valid = await createRun(evalRoot, "run-001", "completed");
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-external-"));
    tempRoots.push(external);
    await fs.symlink(external, path.join(evalRoot, "run-link"));

    await expect(cleanEvalRuns({
      confirmed: true,
      evalRoot,
      repositoryRoot: repositoryRootFor(evalRoot),
    })).rejects.toThrow(/symlink/);
    await expect(fs.stat(valid)).resolves.toBeDefined();
    await expect(fs.stat(external)).resolves.toBeDefined();
  });

  it("rejects worktree registrations that escape the marked run", async () => {
    const evalRoot = await createEvalRoot();
    const runRoot = await createRun(evalRoot, "run-001", "completed", [{
      gitRoot: "fixture",
      path: "../outside",
    }]);
    const outside = path.join(evalRoot, "outside");
    await fs.mkdir(outside);

    await expect(cleanEvalRuns({
      confirmed: true,
      evalRoot,
      repositoryRoot: repositoryRootFor(evalRoot),
    })).rejects.toThrow(/inside the eval run/);
    await expect(fs.stat(runRoot)).resolves.toBeDefined();
    await expect(fs.stat(outside)).resolves.toBeDefined();
  });

  it("rejects a registered worktree path that resolves through a symlink", async () => {
    const evalRoot = await createEvalRoot();
    const runRoot = await createRun(evalRoot, "run-001", "completed", [{
      gitRoot: "fixture",
      path: "linked-worktree",
    }]);
    await fs.mkdir(path.join(runRoot, "fixture"));
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-external-"));
    tempRoots.push(external);
    await fs.symlink(external, path.join(runRoot, "linked-worktree"));
    const removeWorktree = vi.fn(async () => {});

    await expect(cleanEvalRuns({
      confirmed: true,
      evalRoot,
      repositoryRoot: repositoryRootFor(evalRoot),
      removeWorktree,
    }))
      .rejects.toThrow(/symlink|inside the eval run/);
    expect(removeWorktree).not.toHaveBeenCalled();
    await expect(fs.stat(runRoot)).resolves.toBeDefined();
    await expect(fs.stat(external)).resolves.toBeDefined();
  });

  it("rejects a symlinked .forge ancestor before deleting any run", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-repo-"));
    const externalForge = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-external-forge-"));
    tempRoots.push(repositoryRoot, externalForge);
    const evalRoot = path.join(repositoryRoot, ".forge", "evals");
    const externalEvalRoot = path.join(externalForge, "evals");
    await fs.mkdir(externalEvalRoot);
    const runRoot = await createRun(externalEvalRoot, "run-001", "completed");
    await fs.symlink(externalForge, path.join(repositoryRoot, ".forge"));

    await expect(cleanEvalRuns({ confirmed: true, evalRoot, repositoryRoot }))
      .rejects.toThrow(/\.forge.*symlink|real directory/);
    await expect(fs.stat(runRoot)).resolves.toBeDefined();
  });
});
