import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { TeamTaskActor, TeamTaskResultSource } from "../../src/domain/teamTask.js";
import type { AsyncChildSessionManager } from "../../src/extensions/childSessions.js";
import {
  GitIntegrationError,
  type GitIntegrationService,
} from "../../src/runtime/gitIntegration.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";
import {
  createTeamTaskToolRuntime,
  taskCreateToolDefinition,
  taskIntegrateToolDefinition,
  taskTransitionToolDefinition,
  taskUpdateToolDefinition,
  taskVerifyToolDefinition,
} from "../../src/tools/teamTaskTools.js";

const leader: TeamTaskActor = { role: "leader", sessionId: "leader-session" };

describe("team task tool contract", () => {
  it("declares v2 contract, transition, verify, and integrate schemas", () => {
    expect(taskCreateToolDefinition).toMatchObject({
      name: "task_create",
      parameters: {
        additionalProperties: false,
        required: ["title", "description", "acceptance", "kind"],
      },
    });
    expect(taskUpdateToolDefinition.parameters).not.toHaveProperty("properties.status");
    expect(taskTransitionToolDefinition).toMatchObject({ name: "task_transition" });
    expect(taskVerifyToolDefinition).toMatchObject({
      name: "task_verify",
      parameters: { required: ["id", "command"] },
    });
    expect(taskIntegrateToolDefinition).toMatchObject({ name: "task_integrate" });
  });

  it("uses a role-level static tool facet", async () => {
    const { store } = await fixture();
    const teammate: TeamTaskActor = {
      name: "researcher",
      profile: "research",
      role: "teammate",
      sessionId: "teammate-session",
    };
    const child: TeamTaskActor = {
      delegatedTaskId: "task_001",
      profile: "research",
      role: "child",
      sessionId: "child-session",
    };

    expect(createTeamTaskToolRuntime({ actor: leader, store }).toolDefinitions().map((tool) => tool.name))
      .toEqual([
        "task_list",
        "task_get",
        "task_create",
        "task_update",
        "task_add_evidence",
        "task_transition",
        "task_verify",
        "task_integrate",
      ]);
    expect(createTeamTaskToolRuntime({ actor: teammate, store }).toolDefinitions().map((tool) => tool.name))
      .toEqual(["task_list", "task_get", "task_add_evidence", "task_transition"]);
    expect(createTeamTaskToolRuntime({ actor: child, store }).toolDefinitions().map((tool) => tool.name))
      .toEqual(["task_list", "task_get", "task_add_evidence"]);
  });

  it("creates and updates only pending contract fields", async () => {
    const { runtime, store } = await leaderFixture();
    const created = await execute(runtime, "task_create", {
      acceptance: ["Reviewed"],
      description: "Research",
      kind: "research",
      title: "Research task",
    });
    expect(created).toMatchObject({
      metadata: {
        task: { kind: "research", status: "pending" },
        taskGraphMutation: { operation: "create", taskId: "task_001" },
      },
      status: "completed",
    });

    await expect(execute(runtime, "task_update", {
      id: "task_001",
      status: "completed",
    })).resolves.toMatchObject({
      metadata: { reasonCode: "invalid_input" },
      status: "failed",
    });
    await execute(runtime, "task_update", {
      id: "task_001",
      title: "Updated task",
    });
    expect((await store.get("task_001")).task.title).toBe("Updated task");
  });

  it("drives the research acquire, evidence, submit, and review protocol", async () => {
    const { runtime, store } = await leaderFixture();
    await execute(runtime, "task_create", {
      acceptance: ["Reviewed"],
      description: "Research",
      kind: "research",
      title: "Research task",
    });
    await execute(runtime, "task_transition", {
      action: "assign",
      assignee: "leader",
      id: "task_001",
    });
    await execute(runtime, "task_add_evidence", {
      id: "task_001",
      summary: "Found evidence",
    });
    await execute(runtime, "task_transition", {
      action: "submit_result",
      id: "task_001",
      summary: "Answer",
    });
    const reviewed = await execute(runtime, "task_transition", {
      action: "review_result",
      decision: "pass",
      id: "task_001",
      reason: "Accepted",
    });

    expect(reviewed).toMatchObject({
      metadata: {
        task: { status: "completed" },
        taskGraphMutation: {
          nextStatus: "completed",
          previousStatus: "submitted",
        },
      },
      status: "completed",
    });
    expect((await store.get("task_001")).task.verdict).toMatchObject({ status: "passed" });
  });

  it("exposes actor-filtered availableActions", async () => {
    const { runtime } = await leaderFixture();
    await execute(runtime, "task_create", {
      acceptance: ["Reviewed"],
      description: "Research",
      kind: "research",
      title: "Research task",
    });
    const result = await execute(runtime, "task_get", { id: "task_001" });

    expect(result).toMatchObject({
      metadata: {
        availableActions: expect.arrayContaining(["assign", "update", "delete"]),
        ready: true,
      },
      status: "completed",
    });
    expect(result.content).toContain("available_actions:");
  });

  it("resolves a one-shot edit child by childSessionId and never accepts a workspace path", async () => {
    const { store } = await fixture();
    const source: TeamTaskResultSource = {
      childSessionId: "child-session",
      kind: "child",
      profile: "edit",
      workspace: { branch: "child-branch", path: "/registered/source" },
    };
    const childSessions = {
      resolveEditSource: vi.fn(() => source),
    } as unknown as AsyncChildSessionManager;
    const gitIntegration = createGitMock(source);
    const runtime = createTeamTaskToolRuntime({
      actor: leader,
      childSessions,
      gitIntegration,
      store,
    });
    await execute(runtime, "task_create", {
      acceptance: ["Integrated"],
      description: "Edit",
      kind: "edit",
      title: "Edit task",
      verificationCommand: "npm test",
    });
    await execute(runtime, "task_transition", {
      action: "assign",
      assignee: "leader",
      id: "task_001",
    });
    await execute(runtime, "task_add_evidence", {
      id: "task_001",
      summary: "Child changed the file",
    });

    const submitted = await execute(runtime, "task_transition", {
      action: "submit_result",
      childSessionId: "child-session",
      id: "task_001",
      summary: "Ready",
    });

    expect(childSessions.resolveEditSource).toHaveBeenCalledWith("child-session", "task_001");
    expect(gitIntegration.capture).toHaveBeenCalledWith(source);
    expect(submitted).toMatchObject({
      metadata: { task: { status: "submitted", submission: { source } } },
      status: "completed",
    });
    await expect(execute(runtime, "task_transition", {
      action: "submit_result",
      id: "task_001",
      summary: "workspace: /model/chosen/path",
      workspace: "/model/chosen/path",
    })).resolves.toMatchObject({
      metadata: { reasonCode: "invalid_input" },
      status: "failed",
    });
  });

  it("records verify and integration receipts through their dedicated tools", async () => {
    const { store } = await fixture();
    const source: TeamTaskResultSource = {
      childSessionId: "child-session",
      kind: "child",
      profile: "edit",
      workspace: { branch: "child-branch", path: "/registered/source" },
    };
    const gitIntegration = createGitMock(source);
    const runtime = createTeamTaskToolRuntime({
      actor: leader,
      childSessions: {
        resolveEditSource: () => source,
      } as unknown as AsyncChildSessionManager,
      gitIntegration,
      store,
    });
    await execute(runtime, "task_create", {
      acceptance: ["Integrated"],
      description: "Edit",
      kind: "edit",
      title: "Edit task",
      verificationCommand: "npm test",
    });
    await execute(runtime, "task_transition", {
      action: "assign",
      assignee: "leader",
      id: "task_001",
    });
    await execute(runtime, "task_add_evidence", { id: "task_001", summary: "Ready" });
    await execute(runtime, "task_transition", {
      action: "submit_result",
      childSessionId: "child-session",
      id: "task_001",
      summary: "Ready",
    });

    expect(await execute(runtime, "task_verify", {
      command: "npm test",
      id: "task_001",
    })).toMatchObject({ status: "completed" });
    expect(await execute(runtime, "task_integrate", {
      id: "task_001",
    })).toMatchObject({
      metadata: { task: { status: "completed" } },
      status: "completed",
    });
  });

  it("clears a stale verified submission when integration detects source drift", async () => {
    const { store } = await fixture();
    const source: TeamTaskResultSource = {
      childSessionId: "child-session",
      kind: "child",
      profile: "edit",
      workspace: { branch: "child-branch", path: "/registered/source" },
    };
    const gitIntegration = createGitMock(source);
    vi.mocked(gitIntegration.integrate).mockRejectedValueOnce(
      new GitIntegrationError("source_drift", "source changed after verification"),
    );
    const runtime = createTeamTaskToolRuntime({
      actor: leader,
      childSessions: {
        resolveEditSource: () => source,
      } as unknown as AsyncChildSessionManager,
      gitIntegration,
      store,
    });
    await execute(runtime, "task_create", {
      acceptance: ["Integrated"],
      description: "Edit",
      kind: "edit",
      title: "Edit task",
      verificationCommand: "npm test",
    });
    await execute(runtime, "task_transition", {
      action: "assign",
      assignee: "leader",
      id: "task_001",
    });
    await execute(runtime, "task_add_evidence", { id: "task_001", summary: "Ready" });
    await execute(runtime, "task_transition", {
      action: "submit_result",
      childSessionId: "child-session",
      id: "task_001",
      summary: "Ready",
    });
    await execute(runtime, "task_verify", {
      command: "npm test",
      id: "task_001",
    });

    expect(await execute(runtime, "task_integrate", {
      id: "task_001",
    })).toMatchObject({
      metadata: {
        reasonCode: "source_drift",
        task: { status: "in_progress" },
      },
      status: "failed",
    });
    expect((await store.get("task_001")).task).not.toHaveProperty("submission");
    expect((await store.get("task_001")).task).not.toHaveProperty("verdict");
  });

  it("keeps child evidence scoped to its delegated Leader-owned task", async () => {
    const { store } = await fixture();
    await store.create(leader, {
      acceptance: ["Reviewed"],
      description: "Research",
      kind: "research",
      title: "Research",
    });
    await store.transition(leader, {
      action: "assign",
      assignee: { role: "leader" },
      id: "task_001",
    });
    const childRuntime = createTeamTaskToolRuntime({
      actor: {
        delegatedTaskId: "task_999",
        profile: "research",
        role: "child",
        sessionId: "child-session",
      },
      store,
    });

    expect(await execute(childRuntime, "task_add_evidence", {
      id: "task_001",
      summary: "Wrong task",
    })).toMatchObject({
      metadata: { reasonCode: "delegated_task_mismatch" },
      status: "failed",
    });
    expect((await store.get("task_001")).task.evidence).toEqual([]);
  });
});

function createGitMock(source: TeamTaskResultSource): GitIntegrationService {
  return {
    capture: vi.fn(async () => ({
      changedFiles: ["demo.txt"],
      fingerprint: "fingerprint",
      head: "head",
      status: ["?? demo.txt"],
    })),
    integrate: vi.fn(async () => ({
      fingerprint: "fingerprint",
      integratedAt: "2026-07-28T00:00:00.000Z",
      integratedCommit: "integrated",
      source,
      sourceCommit: "source",
      targetBefore: "before",
    })),
    review: vi.fn(async () => ({
      changedFiles: ["demo.txt"],
      diff: "+demo",
      fingerprint: "fingerprint",
      fingerprintStatus: "current" as const,
      head: "head",
      status: ["?? demo.txt"],
    })),
    verify: vi.fn(async () => ({
      actualFingerprint: "fingerprint",
      command: "npm test",
      exitCode: 0,
      output: "passed",
      sourceDrifted: false,
    })),
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-task-tools-"));
  const store = createFileTeamTaskStore({
    graphPath: path.join(root, "task-graph.json"),
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  await store.initialize();
  return { root, store };
}

async function leaderFixture() {
  const result = await fixture();
  return {
    ...result,
    runtime: createTeamTaskToolRuntime({ actor: leader, store: result.store }),
  };
}

async function execute(
  runtime: ReturnType<typeof createTeamTaskToolRuntime>,
  name: string,
  args: Record<string, unknown>,
) {
  return runtime.execute(
    { arguments: JSON.stringify(args), name },
    { callId: `call_${name}`, round: 1 },
  );
}
