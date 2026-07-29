import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import type { TeammateManager } from "../../src/extensions/teammates.js";
import { lookupDemoIssue } from "../../src/extensions/mcpDemoServer.js";
import { createCompletionGate } from "../../src/runtime/completionGate.js";
import { createGitIntegrationService } from "../../src/runtime/gitIntegration.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";
import { createCommandVerifier } from "../../src/runtime/verification.js";

const execFileAsync = promisify(execFile);
const timestamp = "2026-07-28T00:00:00.000Z";
const leader = { role: "leader" as const, sessionId: "leader-session" };
const researcher = {
  name: "researcher",
  profile: "research" as const,
  role: "teammate" as const,
  sessionId: "researcher-session",
};
const editor = {
  name: "editor",
  profile: "edit" as const,
  role: "teammate" as const,
  sessionId: "editor-session",
};

it("runs the c17c capstone protocol through integrated artifact and completion gate", async () => {
  const git = await createThreeWorktreeFixture();
  const store = createFileTeamTaskStore({
    graphPath: path.join(git.root, "task-graph.json"),
    now: () => new Date(timestamp),
  });
  await store.initialize();
  await store.create(leader, researchContract("One-shot issue research"));
  await store.create(leader, researchContract("Assigned teammate research"));
  await store.create(leader, {
    acceptance: ["c17c artifact is integrated"],
    description: "Create the capstone artifact",
    kind: "edit",
    title: "Create c17c artifact",
    verificationCommand:
      "grep -Fx 'issue: FH-16' c17c-coordination-demo.txt && grep -Fx 'status: integrated by c17c' c17c-coordination-demo.txt",
  });

  await store.transition(leader, {
    action: "assign",
    assignee: { role: "leader" },
    id: "task_001",
  });
  await store.transition(leader, {
    action: "assign",
    assignee: { name: "researcher", profile: "research", role: "teammate" },
    id: "task_002",
  });
  await store.transition(editor, { action: "claim", id: "task_003" });

  const issue = lookupDemoIssue("FH-16");
  expect(issue.found).toBe(true);
  await store.addEvidence(
    { delegatedTaskId: "task_001", profile: "research", role: "child", sessionId: "child-research" },
    "task_001",
    { callId: "issue-lookup", round: 1, summary: issue.text },
  );
  await store.transition(leader, {
    action: "submit_result",
    id: "task_001",
    summary: "FH-16 was loaded through the local issue fixture",
  });
  await store.transition(leader, {
    action: "review_result",
    decision: "pass",
    id: "task_001",
    reason: "Issue evidence is present",
  });

  await store.addEvidence(researcher, "task_002", {
    callId: "researcher-result",
    round: 1,
    summary: "The completion gate must wait for integration and shutdown",
  });
  await store.transition(researcher, {
    action: "submit_result",
    id: "task_002",
    summary: "Coordination requirements confirmed",
  });
  await store.transition(leader, {
    action: "review_result",
    decision: "pass",
    id: "task_002",
    reason: "Research acceptance is satisfied",
  });

  await store.transition(editor, {
    action: "submit_plan",
    id: "task_003",
    steps: ["Create the exact artifact", "Run the contract verifier"],
    summary: "One file, two exact lines",
  });
  await store.transition(leader, {
    action: "review_plan",
    decision: "approve",
    id: "task_003",
    reason: "The plan is minimal and testable",
  });
  await fs.writeFile(
    path.join(git.editor, "c17c-coordination-demo.txt"),
    "issue: FH-16\nstatus: integrated by c17c\n",
    "utf8",
  );
  await store.addEvidence(editor, "task_003", {
    callId: "artifact-created",
    round: 2,
    summary: "Created the exact artifact",
  });
  const source = {
    kind: "teammate" as const,
    name: "editor",
    profile: "edit" as const,
    sessionId: "editor-session",
    workspace: { branch: "editor-work", path: git.editor },
  };
  const integration = createGitIntegrationService({
    now: () => new Date(timestamp),
    targetCwd: git.leader,
  });
  const snapshot = await integration.capture(source);
  await store.transition(editor, {
    action: "submit_result",
    changedFiles: snapshot.changedFiles,
    fingerprint: snapshot.fingerprint,
    id: "task_003",
    source,
    summary: "Artifact ready",
  });
  const verification = await integration.verify(
    (await store.get("task_003")).task,
    (await store.get("task_003")).task.verificationCommand as string,
  );
  await store.recordVerification(leader, "task_003", {
    command: verification.command,
    exitCode: verification.exitCode,
    fingerprint: verification.actualFingerprint,
    summary: verification.output,
  });
  const receipt = await integration.integrate((await store.get("task_003")).task);
  await store.recordIntegration(leader, "task_003", receipt);

  const rootVerification = await createCommandVerifier({
    command: `${JSON.stringify(process.execPath)} -e "" && test -f c17c-coordination-demo.txt`,
    cwd: git.leader,
  }).verify({
    candidateAnswer: "complete",
    cwd: git.leader,
    round: 1,
    task: "c17c capstone",
  });
  expect(rootVerification.status).toBe("passed");
  expect(await createCompletionGate({
    cwd: git.leader,
    taskStore: store,
    teammates: stoppedTeammates(),
  }).evaluate()).toEqual({ status: "ready" });
  expect(await fs.readFile(
    path.join(git.leader, "c17c-coordination-demo.txt"),
    "utf8",
  )).toBe("issue: FH-16\nstatus: integrated by c17c\n");
  await expect(
    fs.access(path.join(git.base, "c17c-coordination-demo.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

function researchContract(title: string) {
  return {
    acceptance: ["Reviewed evidence exists"],
    description: "Research one capstone input",
    kind: "research" as const,
    title,
  };
}

function stoppedTeammates(): TeammateManager {
  return {
    async list() {
      return [
        {
          name: "editor",
          profile: "edit" as const,
          sessionId: "editor-session",
          state: "stopped" as const,
          tracePath: "/trace/editor",
          unreadCount: 0,
        },
        {
          name: "researcher",
          profile: "research" as const,
          sessionId: "researcher-session",
          state: "stopped" as const,
          tracePath: "/trace/researcher",
          unreadCount: 0,
        },
      ];
    },
  } as TeammateManager;
}

async function createThreeWorktreeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-c17c-capstone-"));
  const base = path.join(root, "base");
  const leaderWorktree = path.join(root, "leader");
  const editorWorktree = path.join(root, "editor");
  await fs.mkdir(base);
  await runGit(base, ["init", "-b", "main"]);
  await runGit(base, ["config", "user.name", "Forge Smoke"]);
  await runGit(base, ["config", "user.email", "forge-smoke@example.com"]);
  await fs.writeFile(path.join(base, "README.md"), "base\n", "utf8");
  await runGit(base, ["add", "README.md"]);
  await runGit(base, ["commit", "-m", "base"]);
  await runGit(base, ["worktree", "add", "-b", "leader-work", leaderWorktree, "HEAD"]);
  await runGit(base, ["worktree", "add", "-b", "editor-work", editorWorktree, "HEAD"]);
  return { base, editor: editorWorktree, leader: leaderWorktree, root };
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
