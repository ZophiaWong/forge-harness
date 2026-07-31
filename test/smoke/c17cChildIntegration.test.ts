import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createGitIntegrationService } from "../../src/runtime/gitIntegration.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";

const execFileAsync = promisify(execFile);
const leader = { role: "leader" as const, sessionId: "leader-session" };

it("integrates the focused one-shot edit child artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-c17c-child-smoke-"));
  const target = path.join(root, "target");
  const child = path.join(root, "child");
  await fs.mkdir(target);
  await git(target, ["init", "-b", "main"]);
  await git(target, ["config", "user.name", "Forge Smoke"]);
  await git(target, ["config", "user.email", "forge-smoke@example.com"]);
  await fs.writeFile(path.join(target, "README.md"), "base\n", "utf8");
  await git(target, ["add", "README.md"]);
  await git(target, ["commit", "-m", "base"]);
  await git(target, ["worktree", "add", "-b", "child-work", child, "HEAD"]);
  await fs.writeFile(
    path.join(child, "c17c-child-integration-demo.txt"),
    "status: one-shot integrated\n",
    "utf8",
  );

  const source = {
    childSessionId: "child-edit-session",
    kind: "child" as const,
    profile: "edit" as const,
    workspace: { branch: "child-work", path: child },
  };
  const integration = createGitIntegrationService({ targetCwd: target });
  const snapshot = await integration.capture(source);
  const store = createFileTeamTaskStore({ graphPath: path.join(root, "task-graph.json") });
  await store.initialize();
  await store.create(leader, {
    acceptance: ["The one-shot artifact is integrated"],
    description: "Integrate one edit child result",
    kind: "edit",
    title: "One-shot child artifact",
    verificationCommand:
      "grep -Fx 'status: one-shot integrated' c17c-child-integration-demo.txt",
  });
  await store.transition(leader, {
    action: "assign",
    assignee: { role: "leader" },
    id: "task_001",
  });
  await store.addEvidence(
    {
      delegatedTaskId: "task_001",
      profile: "edit",
      role: "child",
      sessionId: "child-edit-session",
    },
    "task_001",
    { callId: "child-result", round: 1, summary: "Created the exact artifact" },
  );
  await store.transition(leader, {
    action: "submit_result",
    changedFiles: snapshot.changedFiles,
    fingerprint: snapshot.fingerprint,
    id: "task_001",
    source,
    summary: "Child handoff is registered",
  });
  const task = (await store.get("task_001")).task;
  const verification = await integration.verify(task, task.verificationCommand as string);
  await store.recordVerification(leader, "task_001", {
    command: verification.command,
    exitCode: verification.exitCode,
    fingerprint: verification.actualFingerprint,
    summary: verification.output,
  });
  await store.recordIntegration(
    leader,
    "task_001",
    await integration.integrate((await store.get("task_001")).task),
  );

  expect(await fs.readFile(
    path.join(target, "c17c-child-integration-demo.txt"),
    "utf8",
  )).toBe("status: one-shot integrated\n");
  expect((await store.get("task_001")).task.status).toBe("completed");
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
