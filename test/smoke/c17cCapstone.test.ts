import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import type { TeamTaskActor } from "../../src/domain/teamTask.js";
import type { TeammateManager } from "../../src/extensions/teammates.js";
import { lookupDemoIssue } from "../../src/extensions/mcpDemoServer.js";
import { createCompletionGate } from "../../src/runtime/completionGate.js";
import { createGitIntegrationService } from "../../src/runtime/gitIntegration.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";
import { createCommandVerifier } from "../../src/runtime/verification.js";
import { createTeamTaskToolRuntime } from "../../src/tools/teamTaskTools.js";

const execFileAsync = promisify(execFile);
const timestamp = "2026-07-28T00:00:00.000Z";
const leader: TeamTaskActor = { role: "leader", sessionId: "leader-session" };
const researcher: TeamTaskActor = {
  name: "researcher",
  profile: "research",
  role: "teammate",
  sessionId: "researcher-session",
};
const editor: TeamTaskActor = {
  name: "editor",
  profile: "edit",
  role: "teammate",
  sessionId: "editor-session",
};

it("runs the c17c capstone protocol through integrated artifact and completion gate", async () => {
  const git = await createThreeWorktreeFixture();
  const store = createFileTeamTaskStore({
    graphPath: path.join(git.root, "task-graph.json"),
    now: () => new Date(timestamp),
  });
  await store.initialize();
  const integration = createGitIntegrationService({
    now: () => new Date(timestamp),
    targetCwd: git.leader,
  });
  const teammates = stoppedTeammates();
  const leaderRuntime = createTeamTaskToolRuntime({
    actor: leader,
    gitIntegration: integration,
    store,
    teammates,
  });
  const researcherRuntime = createTeamTaskToolRuntime({ actor: researcher, store });
  const editorRuntime = createTeamTaskToolRuntime({
    actor: editor,
    gitIntegration: integration,
    ownWorkspace: { branch: "editor-work", path: git.editor },
    store,
  });
  const childRuntime = createTeamTaskToolRuntime({
    actor: {
      delegatedTaskId: "task_001",
      profile: "research",
      role: "child",
      sessionId: "child-research",
    },
    store,
  });

  await executeCompleted(leaderRuntime, "task_create", {
    ...researchContract("One-shot issue research"),
    dependencies: [],
  });
  await executeCompleted(leaderRuntime, "task_create", {
    ...researchContract("Assigned teammate research"),
    dependencies: [],
  });
  await executeCompleted(leaderRuntime, "task_create", {
    acceptance: ["c17c artifact is integrated"],
    dependencies: [],
    description: "Create the capstone artifact",
    kind: "edit",
    title: "Create c17c artifact",
    verificationCommand:
      "grep -Fx 'issue: FH-16' c17c-coordination-demo.txt && grep -Fx 'status: integrated by c17c' c17c-coordination-demo.txt",
  });

  await executeCompleted(leaderRuntime, "task_transition", {
    action: "assign",
    assignee: "leader",
    id: "task_001",
  });
  await executeCompleted(leaderRuntime, "task_transition", {
    action: "assign",
    assignee: "researcher",
    id: "task_002",
  });
  await executeCompleted(editorRuntime, "task_transition", {
    action: "claim",
    id: "task_003",
  });

  const issue = lookupDemoIssue("FH-16");
  expect(issue.found).toBe(true);
  await executeCompleted(childRuntime, "task_add_evidence", {
    id: "task_001",
    references: [{ kind: "external", value: "issue-workflow-demo:FH-16" }],
    summary: issue.text,
  });
  await executeCompleted(leaderRuntime, "task_transition", {
    action: "submit_result",
    id: "task_001",
    summary: "FH-16 was loaded through the local issue fixture",
  });
  await executeCompleted(leaderRuntime, "task_transition", {
    action: "review_result",
    decision: "pass",
    id: "task_001",
    reason: "Issue evidence is present",
  });

  await executeCompleted(researcherRuntime, "task_add_evidence", {
    id: "task_002",
    references: [{ kind: "external", value: "issue-workflow-demo:FH-16" }],
    summary: "The completion gate must wait for integration and shutdown",
  });
  await executeCompleted(researcherRuntime, "task_transition", {
    action: "submit_result",
    id: "task_002",
    summary: "Coordination requirements confirmed",
  });
  await executeCompleted(leaderRuntime, "task_transition", {
    action: "review_result",
    decision: "pass",
    id: "task_002",
    reason: "Research acceptance is satisfied",
  });

  await executeCompleted(editorRuntime, "task_transition", {
    action: "submit_plan",
    id: "task_003",
    steps: ["Create the exact artifact", "Run the contract verifier"],
    summary: "One file, two exact lines",
  });
  await executeCompleted(leaderRuntime, "task_transition", {
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
  await executeCompleted(editorRuntime, "task_add_evidence", {
    id: "task_003",
    references: [{ kind: "artifact", value: "c17c-coordination-demo.txt" }],
    summary: "Created the exact artifact",
  });
  await executeCompleted(editorRuntime, "task_transition", {
    action: "submit_result",
    id: "task_003",
    summary: "Artifact ready",
  });
  const submitted = await executeCompleted(leaderRuntime, "task_get", {
    id: "task_003",
  });
  expect(submitted.metadata?.review).toMatchObject({
    changedFiles: ["c17c-coordination-demo.txt"],
    fingerprintStatus: "current",
  });
  await executeCompleted(leaderRuntime, "task_verify", {
    command:
      "grep -Fx 'issue: FH-16' c17c-coordination-demo.txt && grep -Fx 'status: integrated by c17c' c17c-coordination-demo.txt",
    id: "task_003",
  });
  await executeCompleted(leaderRuntime, "task_integrate", { id: "task_003" });

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
    teammates,
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
    async resolveAssignee(name) {
      if (name !== "researcher") {
        throw new Error(`unknown teammate "${name}"`);
      }
      return {
        name: "researcher",
        profile: "research",
        role: "teammate",
      };
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

async function executeCompleted(
  runtime: ReturnType<typeof createTeamTaskToolRuntime>,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await runtime.execute(
    { arguments: JSON.stringify(args), name },
    { callId: `call_${name}`, round: 1 },
  );
  expect(result.status, result.content).toBe("completed");
  return result;
}
