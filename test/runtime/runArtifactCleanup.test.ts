import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupRunArtifacts,
  inspectRunArtifacts,
  type GitWorktreeAdapter,
} from "../../src/runtime/runArtifactCleanup.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("inspectRunArtifacts", () => {
  it("reports an empty repository as a no-op", async () => {
    const repository = await createRepository();

    await expect(inspectRunArtifacts({ cwd: repository })).resolves.toMatchObject({
      hasArtifacts: false,
      registeredWorktrees: [],
      sessionCount: 0,
      worktreeRootEntryCount: 0,
    });
  });

  it("counts run roots and orders only generated registered worktrees deepest-first", async () => {
    const repository = await createRepository();
    const sessionsRoot = path.join(repository, ".forge", "sessions");
    const worktreesRoot = path.join(repository, ".forge", "worktrees");
    const parent = path.join(worktreesRoot, "run-session");
    const child = path.join(parent, "teammates", "editor");
    const sibling = path.join(worktreesRoot, "another-session");
    const outside = path.join(repository, "external-worktree");
    await fs.mkdir(path.join(sessionsRoot, "session-1"), { recursive: true });
    await fs.mkdir(path.join(sessionsRoot, "session-2"), { recursive: true });
    await fs.mkdir(path.join(worktreesRoot, "residual"), { recursive: true });

    const git: GitWorktreeAdapter = {
      async list() {
        return [parent, outside, sibling, child];
      },
      async prune() {},
      async remove() {},
    };

    await expect(inspectRunArtifacts({ cwd: repository, git })).resolves.toEqual({
      hasArtifacts: true,
      registeredWorktrees: [child, sibling, parent],
      sessionCount: 2,
      sessionsRoot,
      worktreeRootEntryCount: 1,
      worktreesRoot,
    });
  });
});

describe("cleanupRunArtifacts", () => {
  it("removes dirty generated worktrees and run roots while preserving config and branches", async () => {
    const repository = await createRepository();
    const forgeRoot = path.join(repository, ".forge");
    const sessionsRoot = path.join(forgeRoot, "sessions");
    const worktreesRoot = path.join(forgeRoot, "worktrees");
    const runWorktree = path.join(worktreesRoot, "run-session");
    await fs.mkdir(path.join(sessionsRoot, "session-1"), { recursive: true });
    await fs.mkdir(path.join(forgeRoot, "plugins", "demo"), { recursive: true });
    await fs.mkdir(path.join(forgeRoot, "memory"), { recursive: true });
    await fs.mkdir(path.join(forgeRoot, "skills"), { recursive: true });
    await fs.writeFile(path.join(forgeRoot, "mcp.json"), '{"preserve":true}\n');
    await fs.writeFile(path.join(forgeRoot, "plugins", "demo", "plugin.json"), "plugin\n");
    await fs.writeFile(path.join(forgeRoot, "memory", "MEMORY.md"), "memory\n");
    await fs.writeFile(path.join(forgeRoot, "skills", "SKILL.md"), "skill\n");
    await git(repository, ["worktree", "add", "-b", "forge/run/run-session", runWorktree]);
    await fs.writeFile(path.join(runWorktree, "dirty.txt"), "dirty\n");

    const result = await cleanupRunArtifacts({ cwd: repository });

    expect(result.failures).toEqual([]);
    expect(result.removedWorktrees).toEqual([runWorktree]);
    await expect(fs.access(sessionsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(worktreesRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(forgeRoot, "mcp.json"), "utf8")).resolves.toBe(
      '{"preserve":true}\n',
    );
    await expect(
      fs.readFile(path.join(forgeRoot, "plugins", "demo", "plugin.json"), "utf8"),
    ).resolves.toBe("plugin\n");
    await expect(fs.readFile(path.join(forgeRoot, "memory", "MEMORY.md"), "utf8")).resolves.toBe(
      "memory\n",
    );
    await expect(fs.readFile(path.join(forgeRoot, "skills", "SKILL.md"), "utf8")).resolves.toBe(
      "skill\n",
    );
    await expect(
      git(repository, ["show-ref", "--verify", "refs/heads/forge/run/run-session"]),
    ).resolves.toContain("refs/heads/forge/run/run-session");
    await expect(git(repository, ["worktree", "list", "--porcelain"])).resolves.not.toContain(
      runWorktree,
    );
  });

  it("prunes stale registrations and remains idempotent", async () => {
    const repository = await createRepository();
    const worktree = path.join(repository, ".forge", "worktrees", "stale-session");
    await git(repository, ["worktree", "add", "-b", "forge/run/stale-session", worktree]);
    await fs.rm(worktree, { force: true, recursive: true });

    const first = await cleanupRunArtifacts({ cwd: repository });
    const second = await cleanupRunArtifacts({ cwd: repository });

    expect(first.failures).toEqual([]);
    expect(first.pruned).toBe(true);
    expect(second.inventory.hasArtifacts).toBe(false);
    expect(second.failures).toEqual([]);
    await expect(git(repository, ["worktree", "list", "--porcelain"])).resolves.not.toContain(
      worktree,
    );
    await expect(
      git(repository, ["show-ref", "--verify", "refs/heads/forge/run/stale-session"]),
    ).resolves.toContain("refs/heads/forge/run/stale-session");
  });

  it("removes nested registrations before their parents", async () => {
    const repository = await createRepository();
    const worktreesRoot = path.join(repository, ".forge", "worktrees");
    const parent = path.join(worktreesRoot, "run-session");
    const child = path.join(parent, "teammates", "editor");
    await fs.mkdir(child, { recursive: true });
    const operations: string[] = [];
    const git: GitWorktreeAdapter = {
      async list() {
        return [parent, child];
      },
      async remove(_cwd, worktreePath) {
        operations.push(`remove:${worktreePath}`);
      },
      async prune() {
        operations.push("prune");
      },
    };

    const result = await cleanupRunArtifacts({ cwd: repository, git });

    expect(result.failures).toEqual([]);
    expect(operations).toEqual([`remove:${child}`, `remove:${parent}`, "prune"]);
  });

  it("keeps both generated roots when a registered removal fails", async () => {
    const repository = await createRepository();
    const sessionsRoot = path.join(repository, ".forge", "sessions");
    const worktreesRoot = path.join(repository, ".forge", "worktrees");
    const first = path.join(worktreesRoot, "first");
    const second = path.join(worktreesRoot, "second");
    await fs.mkdir(path.join(sessionsRoot, "session-1"), { recursive: true });
    await fs.mkdir(first, { recursive: true });
    await fs.mkdir(second, { recursive: true });
    const operations: string[] = [];
    const git: GitWorktreeAdapter = {
      async list() {
        return [first, second];
      },
      async remove(_cwd, worktreePath) {
        operations.push(`remove:${worktreePath}`);
        if (worktreePath === first) {
          throw new Error("cannot remove first");
        }
      },
      async prune() {
        operations.push("prune");
      },
    };

    const result = await cleanupRunArtifacts({ cwd: repository, git });

    expect(operations).toEqual([`remove:${first}`, `remove:${second}`, "prune"]);
    expect(result.failures).toEqual([
      {
        message: "cannot remove first",
        operation: "remove_worktree",
        path: first,
      },
    ]);
    await expect(fs.access(sessionsRoot)).resolves.toBeUndefined();
    await expect(fs.access(worktreesRoot)).resolves.toBeUndefined();
  });

  it("keeps both generated roots when prune fails", async () => {
    const repository = await createRepository();
    const sessionsRoot = path.join(repository, ".forge", "sessions");
    const worktreesRoot = path.join(repository, ".forge", "worktrees");
    await fs.mkdir(path.join(sessionsRoot, "session-1"), { recursive: true });
    await fs.mkdir(path.join(worktreesRoot, "residual"), { recursive: true });
    const git: GitWorktreeAdapter = {
      async list() {
        return [];
      },
      async remove() {},
      async prune() {
        throw new Error("cannot prune");
      },
    };

    const result = await cleanupRunArtifacts({ cwd: repository, git });

    expect(result.failures).toEqual([
      {
        message: "cannot prune",
        operation: "prune",
        path: worktreesRoot,
      },
    ]);
    await expect(fs.access(sessionsRoot)).resolves.toBeUndefined();
    await expect(fs.access(worktreesRoot)).resolves.toBeUndefined();
  });
});

async function createRepository(): Promise<string> {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "forge-run-cleanup-"));
  temporaryDirectories.push(repository);
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "Forge Test"]);
  await git(repository, ["config", "user.email", "forge-test@example.com"]);
  await fs.writeFile(path.join(repository, "README.md"), "base\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "init"]);
  return repository;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout;
}
