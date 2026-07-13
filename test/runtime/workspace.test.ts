import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createGitWorktreeWorkspace,
  createWorktreeBranchName,
  createWorktreePath,
  WorkspaceSetupError,
} from "../../src/runtime/workspace.js";

const execFileAsync = promisify(execFile);

describe("git worktree workspace", () => {
  it("derives stable worktree path and branch names from the session id", () => {
    expect(createWorktreePath("/repo/forge-harness", "20260713-101500-a1b2c3d4")).toBe(
      path.join("/repo/forge-harness", ".forge", "worktrees", "20260713-101500-a1b2c3d4"),
    );
    expect(createWorktreeBranchName("20260713-101500-a1b2c3d4")).toBe(
      "forge/run/20260713-101500-a1b2c3d4",
    );
  });

  it("creates a session branch and worktree from a clean git repo", async () => {
    const repo = await createGitRepo();
    const binding = await createGitWorktreeWorkspace({
      baseCwd: repo,
      sessionId: "20260713-101500-a1b2c3d4",
    });

    expect(binding).toEqual({
      baseBranch: "main",
      baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      baseCwd: repo,
      branch: "forge/run/20260713-101500-a1b2c3d4",
      mode: "git_worktree",
      path: path.join(repo, ".forge", "worktrees", "20260713-101500-a1b2c3d4"),
    });
    expect(await readText(path.join(binding.path, "README.md"))).toBe("base\n");
    const branch = await git(binding.path, ["branch", "--show-current"]);
    expect(branch.stdout.trim()).toBe("forge/run/20260713-101500-a1b2c3d4");
  });

  it("rejects dirty base repos before creating a worktree", async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, "README.md"), "dirty\n", "utf8");

    await expect(
      createGitWorktreeWorkspace({
        baseCwd: repo,
        sessionId: "20260713-101500-a1b2c3d4",
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceSetupError",
      workspacePath: path.join(repo, ".forge", "worktrees", "20260713-101500-a1b2c3d4"),
      branch: "forge/run/20260713-101500-a1b2c3d4",
    });
  });

  it("rejects non-git directories", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-workspace-non-git-"));

    await expect(
      createGitWorktreeWorkspace({
        baseCwd: cwd,
        sessionId: "20260713-101500-a1b2c3d4",
      }),
    ).rejects.toBeInstanceOf(WorkspaceSetupError);
  });
});

async function createGitRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "forge-workspace-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Forge Test"]);
  await git(repo, ["config", "user.email", "forge-test@example.com"]);
  await fs.writeFile(path.join(repo, "README.md"), "base\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "init"]);
  return repo;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}
