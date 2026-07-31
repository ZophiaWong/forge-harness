import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type {
  TeamTaskActor,
  TeamTaskResultSource,
} from "../../src/domain/teamTask.js";
import {
  GitIntegrationError,
  createGitIntegrationService,
} from "../../src/runtime/gitIntegration.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";

const execFileAsync = promisify(execFile);
const leader: TeamTaskActor = { role: "leader", sessionId: "leader-session" };

describe("GitIntegrationService", () => {
  it("fingerprints tracked, untracked, and deleted paths and integrates an exact source commit", async () => {
    const fixture = await createGitFixture();
    await fs.writeFile(path.join(fixture.source, "tracked.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(fixture.source, "added.txt"), "added\n", "utf8");
    await fs.unlink(path.join(fixture.source, "deleted.txt"));
    const service = createGitIntegrationService({
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      targetCwd: fixture.target,
    });
    const source = childSource(fixture.source);

    const snapshot = await service.capture(source);
    expect(snapshot.changedFiles).toEqual(["added.txt", "deleted.txt", "tracked.txt"]);
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const task = await submittedVerifiedTask(fixture, source, snapshot);
    const receipt = await service.integrate(task);

    expect(await fs.readFile(path.join(fixture.target, "tracked.txt"), "utf8")).toBe("changed\n");
    expect(await fs.readFile(path.join(fixture.target, "added.txt"), "utf8")).toBe("added\n");
    await expect(fs.access(path.join(fixture.target, "deleted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(["status", "--porcelain=v1"], fixture.target)).toBe("");
    expect(await git(["show", "-s", "--format=%B", receipt.sourceCommit], fixture.source))
      .toContain("forge(task_001): Edit artifact");
    expect(await git(["show", "-s", "--format=%B", receipt.sourceCommit], fixture.source))
      .toContain("Forge-Task: task_001");
    expect(receipt).toMatchObject({
      fingerprint: snapshot.fingerprint,
      source,
      targetBefore: fixture.initialCommit,
    });
  });

  it("rejects a dirty target before creating the source commit", async () => {
    const fixture = await createGitFixture();
    await fs.writeFile(path.join(fixture.source, "tracked.txt"), "source\n", "utf8");
    await fs.writeFile(path.join(fixture.target, "dirty.txt"), "dirty\n", "utf8");
    const service = createGitIntegrationService({ targetCwd: fixture.target });
    const source = childSource(fixture.source);
    const snapshot = await service.capture(source);
    const task = await submittedVerifiedTask(fixture, source, snapshot);

    await expect(service.integrate(task)).rejects.toMatchObject({
      code: "dirty_target",
      name: "GitIntegrationError",
    });
    expect(await git(["rev-parse", "HEAD"], fixture.source)).toBe(fixture.initialCommit);
  });

  it("aborts a conflicting cherry-pick, leaves the target clean, and retains the source commit", async () => {
    const fixture = await createGitFixture();
    await fs.writeFile(path.join(fixture.source, "tracked.txt"), "source version\n", "utf8");
    const service = createGitIntegrationService({ targetCwd: fixture.target });
    const source = childSource(fixture.source);
    const snapshot = await service.capture(source);
    const task = await submittedVerifiedTask(fixture, source, snapshot);
    await fs.writeFile(path.join(fixture.target, "tracked.txt"), "target version\n", "utf8");
    await git(["add", "tracked.txt"], fixture.target);
    await git(["commit", "-m", "target divergence"], fixture.target);

    const failure = await service.integrate(task).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitIntegrationError);
    expect(failure).toMatchObject({
      code: "integration_conflict",
      sourceCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(await git(["status", "--porcelain=v1"], fixture.target)).toBe("");
    await expect(
      fs.access(path.join(
        await git(["rev-parse", "--path-format=absolute", "--git-dir"], fixture.target),
        "CHERRY_PICK_HEAD",
      )),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(["rev-parse", "HEAD"], fixture.source)).toBe(
      (failure as GitIntegrationError).sourceCommit,
    );
  });

  it("detects verification output drift and reports the new fingerprint", async () => {
    const fixture = await createGitFixture();
    await fs.writeFile(path.join(fixture.source, "tracked.txt"), "source\n", "utf8");
    const service = createGitIntegrationService({ targetCwd: fixture.target });
    const source = childSource(fixture.source);
    const snapshot = await service.capture(source);
    const task = await submittedVerifiedTask(fixture, source, snapshot, "printf drift > generated.txt");

    const outcome = await service.verify(task, "printf drift > generated.txt");

    expect(outcome).toMatchObject({
      exitCode: 1,
      sourceDrifted: true,
    });
    expect(outcome.actualFingerprint).not.toBe(snapshot.fingerprint);
  });
});

async function submittedVerifiedTask(
  fixture: GitFixture,
  source: TeamTaskResultSource,
  snapshot: { changedFiles: string[]; fingerprint: string },
  command = "test -f tracked.txt",
) {
  const graphPath = path.join(fixture.root, `graph-${cryptoRandom()}.json`);
  const store = createFileTeamTaskStore({
    graphPath,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  await store.initialize();
  await store.create(leader, {
    acceptance: ["The change is integrated"],
    description: "Edit one artifact",
    kind: "edit",
    title: "Edit artifact",
    verificationCommand: command,
  });
  await store.transition(leader, {
    action: "assign",
    assignee: { role: "leader" },
    id: "task_001",
  });
  await store.addEvidence(leader, "task_001", {
    callId: "evidence",
    round: 1,
    summary: "Source is ready",
  });
  await store.transition(leader, {
    action: "submit_result",
    changedFiles: snapshot.changedFiles,
    fingerprint: snapshot.fingerprint,
    id: "task_001",
    source,
    summary: "Ready to verify",
  });
  await store.recordVerification(leader, "task_001", {
    command,
    exitCode: 0,
    fingerprint: snapshot.fingerprint,
    summary: "passed",
  });
  return (await store.get("task_001")).task;
}

interface GitFixture {
  initialCommit: string;
  root: string;
  source: string;
  target: string;
}

async function createGitFixture(): Promise<GitFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-git-integration-"));
  const target = path.join(root, "target");
  const source = path.join(root, "source");
  await fs.mkdir(target);
  await git(["init", "-b", "main"], target);
  await git(["config", "user.name", "Forge Test"], target);
  await git(["config", "user.email", "forge-test@example.com"], target);
  await fs.writeFile(path.join(target, "tracked.txt"), "base\n", "utf8");
  await fs.writeFile(path.join(target, "deleted.txt"), "delete me\n", "utf8");
  await git(["add", "."], target);
  await git(["commit", "-m", "initial"], target);
  const initialCommit = await git(["rev-parse", "HEAD"], target);
  await git(["worktree", "add", "-b", "source-work", source, initialCommit], target);
  return { initialCommit, root, source, target };
}

function childSource(workspacePath: string): TeamTaskResultSource {
  return {
    childSessionId: "child-session",
    kind: "child",
    profile: "edit",
    workspace: {
      branch: "source-work",
      path: workspacePath,
    },
  };
}

async function git(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

function cryptoRandom(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
