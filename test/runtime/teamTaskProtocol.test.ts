import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseTeamTaskGraphFile,
  TEAM_TASK_GRAPH_SCHEMA_VERSION,
  type TeamTaskActor,
  type TeamTaskIntegrationReceipt,
  type TeamTaskResultSource,
} from "../../src/domain/teamTask.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";

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

describe("TaskGraph coordination protocol v2", () => {
  it("persists v2 contracts and exposes protocol actions without storing readiness", async () => {
    const { graphPath, store } = await createStore();
    const created = await store.create(leader, editContract());

    expect(created.task).toMatchObject({
      kind: "edit",
      status: "pending",
      trace: [],
      transferCount: 0,
      verificationCommand: "npm run test",
    });
    expect(await store.get(created.task.id)).toMatchObject({
      availableActions: expect.arrayContaining(["assign", "claim", "update"]),
      ready: true,
    });
    expect(await store.list()).toMatchObject({
      tasks: [{
        availableActions: expect.arrayContaining(["assign", "claim"]),
        kind: "edit",
        ready: true,
      }],
    });
    const persisted = JSON.parse(await fs.readFile(graphPath, "utf8")) as Record<string, unknown>;
    expect(persisted.schemaVersion).toBe(TEAM_TASK_GRAPH_SCHEMA_VERSION);
    expect(JSON.stringify(persisted)).not.toContain('"ready"');
    expect(JSON.stringify(persisted)).not.toContain('"availableActions"');
  });

  it("serializes concurrent claim to one winner and enforces teammate capacity", async () => {
    const { graphPath, store } = await createStore();
    await store.create(leader, researchContract("First"));
    await store.create(leader, researchContract("Second"));
    await store.create(leader, editContract("Wrong profile"));
    const secondStore = createFileTeamTaskStore({ graphPath });

    const results = await Promise.allSettled([
      store.transition(researcher, { action: "claim", id: "task_001" }),
      secondStore.transition(researcher, { action: "claim", id: "task_001" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      store.transition(researcher, { action: "claim", id: "task_002" }),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    await expect(
      store.transition(researcher, { action: "claim", id: "task_003" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await store.get("task_001")).toMatchObject({
      task: {
        owner: { name: "researcher", role: "teammate" },
        status: "in_progress",
      },
    });
  });

  it("completes research only after evidence, submission, and Leader review", async () => {
    const { store } = await createStore();
    await store.create(leader, researchContract());
    await store.transition(leader, {
      action: "assign",
      assignee: { name: "researcher", profile: "research", role: "teammate" },
      id: "task_001",
    });
    await store.addEvidence(researcher, "task_001", evidence("Research notes"));
    await store.transition(researcher, {
      action: "submit_result",
      id: "task_001",
      summary: "Found the relevant behavior",
    });

    const completed = await store.transition(leader, {
      action: "review_result",
      decision: "pass",
      id: "task_001",
      reason: "Acceptance criteria are satisfied",
    });

    expect(completed).toMatchObject({
      nextStatus: "completed",
      previousStatus: "submitted",
      task: {
        status: "completed",
        verdict: { status: "passed" },
      },
    });
    const invalidCompleted = await store.read();
    delete invalidCompleted.tasks[0]?.verdict;
    expect(() => parseTeamTaskGraphFile(invalidCompleted)).toThrowError(
      expect.objectContaining({ code: "graph_invalid" }),
    );
  });

  it("gates long-lived edit work on an approved plan and completes only after verify and receipt", async () => {
    const { store } = await createStore();
    await store.create(leader, editContract());
    await store.transition(editor, { action: "claim", id: "task_001" });
    expect((await store.get("task_001")).availableActions).not.toContain("submit_result");
    await store.addEvidence(editor, "task_001", evidence("Edited the requested file"));

    await expect(
      store.transition(editor, {
        action: "submit_result",
        changedFiles: ["demo.txt"],
        fingerprint: "fingerprint-1",
        id: "task_001",
        source: teammateSource,
        summary: "Implemented the change",
      }),
    ).rejects.toMatchObject({ code: "plan_not_approved" });

    await store.transition(editor, {
      action: "submit_plan",
      id: "task_001",
      steps: ["Edit demo.txt", "Run the contract verifier"],
      summary: "Minimal artifact change",
    });
    await store.transition(leader, {
      action: "review_plan",
      decision: "approve",
      id: "task_001",
      reason: "Plan is scoped to the task",
    });
    expect((await store.get("task_001")).availableActions).toContain("submit_result");
    await expect(
      store.transition(leader, {
        action: "review_plan",
        decision: "approve",
        id: "task_001",
        reason: "A duplicate approval must be stale",
      }),
    ).rejects.toMatchObject({ code: "stale_approval" });
    await store.transition(editor, {
      action: "submit_result",
      changedFiles: ["demo.txt"],
      fingerprint: "fingerprint-1",
      id: "task_001",
      source: teammateSource,
      summary: "Implemented the change",
    });

    await store.recordVerification(leader, "task_001", {
      command: "npm run test",
      exitCode: 0,
      fingerprint: "fingerprint-1",
      summary: "Verifier passed",
    });
    expect(await store.get("task_001")).toMatchObject({
      availableActions: expect.arrayContaining(["integrate"]),
      task: { status: "submitted" },
    });
    expect((await store.get("task_001")).availableActions).not.toContain("verify");

    const receipt: TeamTaskIntegrationReceipt = {
      fingerprint: "fingerprint-1",
      integratedAt: "2026-07-28T00:00:00.000Z",
      integratedCommit: "integrated-commit",
      source: teammateSource,
      sourceCommit: "source-commit",
      targetBefore: "target-before",
    };
    const prematureReceipt = await store.read();
    prematureReceipt.tasks[0]!.integrationReceipt = receipt;
    expect(() => parseTeamTaskGraphFile(prematureReceipt)).toThrowError(
      expect.objectContaining({ code: "graph_invalid" }),
    );
    const integrated = await store.recordIntegration(leader, "task_001", receipt);

    expect(integrated).toMatchObject({
      nextStatus: "completed",
      operation: "integrate",
      task: {
        integrationReceipt: receipt,
        status: "completed",
      },
    });
  });

  it("clears failed edit submission for retry while preserving evidence and an approved plan", async () => {
    const { store } = await createStore();
    await store.create(leader, editContract());
    await store.transition(editor, { action: "claim", id: "task_001" });
    await store.transition(editor, {
      action: "submit_plan",
      id: "task_001",
      steps: ["Make the edit"],
      summary: "Small edit",
    });
    await store.transition(leader, {
      action: "review_plan",
      decision: "approve",
      id: "task_001",
      reason: "Approved",
    });
    await store.addEvidence(editor, "task_001", evidence("First attempt"));
    await store.transition(editor, {
      action: "submit_result",
      changedFiles: ["demo.txt"],
      fingerprint: "fingerprint-1",
      id: "task_001",
      source: teammateSource,
      summary: "First attempt",
    });

    const retried = await store.recordVerification(leader, "task_001", {
      command: "npm run test",
      exitCode: 1,
      fingerprint: "fingerprint-1",
      summary: "Verifier failed",
    });

    expect(retried).toMatchObject({
      nextStatus: "in_progress",
      task: {
        evidence: expect.any(Array),
        plan: { status: "approved" },
        status: "in_progress",
      },
    });
    expect(retried.task).not.toHaveProperty("submission");
    expect(retried.task.evidence).toHaveLength(1);
  });

  it("permits one cooperative transfer, resets edit plan, and freezes blocked tasks", async () => {
    const { store } = await createStore();
    const secondEditor: TeamTaskActor = {
      name: "editor-two",
      profile: "edit",
      role: "teammate",
      sessionId: "editor-two-session",
    };
    await store.create(leader, editContract());
    await store.transition(editor, { action: "claim", id: "task_001" });
    await store.transition(editor, {
      action: "submit_plan",
      id: "task_001",
      steps: ["Initial plan"],
      summary: "Initial plan",
    });
    await store.transition(editor, {
      action: "submit_handoff",
      id: "task_001",
      summary: "No files changed; transfer is safe",
    });
    const transferred = await store.transition(leader, {
      action: "transfer",
      assignee: { name: "editor-two", profile: "edit", role: "teammate" },
      id: "task_001",
    });

    expect(transferred.task).toMatchObject({
      owner: { name: "editor-two", role: "teammate" },
      transferCount: 1,
    });
    expect(transferred.task).not.toHaveProperty("plan");
    await expect(
      store.transition(leader, {
        action: "transfer",
        assignee: { name: "editor", profile: "edit", role: "teammate" },
        id: "task_001",
      }),
    ).rejects.toMatchObject({ code: "transfer_exhausted" });

    await store.transition(leader, {
      action: "block",
      code: "external_dependency",
      id: "task_001",
      reason: "Required input is unavailable",
    });
    await expect(
      store.transition(secondEditor, {
        action: "submit_plan",
        id: "task_001",
        steps: ["Retry"],
        summary: "Retry",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });
});

const teammateSource: TeamTaskResultSource = {
  kind: "teammate",
  name: "editor",
  profile: "edit",
  sessionId: "editor-session",
  workspace: {
    branch: "forge/teammate-editor",
    path: "/tmp/editor-worktree",
  },
};

function researchContract(title = "Research task") {
  return {
    acceptance: ["The question is answered with evidence"],
    description: "Investigate one scoped question",
    kind: "research" as const,
    title,
  };
}

function editContract(title = "Edit task") {
  return {
    acceptance: ["The artifact is integrated"],
    description: "Create the requested artifact",
    kind: "edit" as const,
    title,
    verificationCommand: "npm run test",
  };
}

function evidence(summary: string) {
  return {
    callId: "call-evidence",
    round: 1,
    summary,
  };
}

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-task-protocol-"));
  const graphPath = path.join(root, "task-graph.json");
  const store = createFileTeamTaskStore({
    graphPath,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  await store.initialize();
  return { graphPath, store };
}
