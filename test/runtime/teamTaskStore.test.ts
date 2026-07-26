import { mkdirSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  TEAM_TASK_GRAPH_SCHEMA_VERSION,
  type TeamTaskActor,
} from "../../src/domain/teamTask.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";

describe("FileTeamTaskStore", () => {
  it("initializes the supplied root-session graph path once with the exact empty schema", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });

    const initialized = await store.initialize();
    const initializedAgain = await store.initialize();

    expect(initialized).toEqual({
      nextTaskSequence: 1,
      revision: 0,
      schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
      tasks: [],
    });
    expect(initializedAgain).toEqual(initialized);
    expect(JSON.parse(await fs.readFile(graphPath, "utf8"))).toEqual(initialized);
  });

  it("never resets or recreates a graph after this store has initialized it", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());

    expect(await store.initialize()).toMatchObject({
      nextTaskSequence: 2,
      revision: 1,
      tasks: [{ id: "task_001" }],
    });

    await fs.unlink(graphPath);
    await expect(store.initialize()).rejects.toMatchObject({
      code: "graph_missing",
      health: "degraded",
    });
  });

  it("does not recreate a deleted initialized graph when a fresh store reopens the path", async () => {
    const graphPath = await createGraphPath();
    const firstStore = createFileTeamTaskStore({ graphPath });
    await firstStore.initialize();
    await firstStore.create(leader, validCreateInput());
    await fs.unlink(graphPath);

    const reopenedStore = createFileTeamTaskStore({ graphPath });

    await expect(reopenedStore.initialize()).rejects.toMatchObject({
      code: "graph_missing",
      health: "degraded",
    });
    await expect(fs.access(graphPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes first-time initialization from two store instances", async () => {
    const graphPath = await createGraphPath();
    const firstStore = createFileTeamTaskStore({ graphPath });
    const secondStore = createFileTeamTaskStore({ graphPath });

    const [first, second] = await Promise.all([
      firstStore.initialize(),
      secondStore.initialize(),
    ]);

    expect(first).toEqual(second);
    expect(first).toEqual({
      nextTaskSequence: 1,
      revision: 0,
      schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
      tasks: [],
    });
  });

  it("maps initialization directory setup failures to a stable degraded store error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-team-task-invalid-parent-"));
    const invalidParent = path.join(root, "not-a-directory");
    await fs.writeFile(invalidParent, "file blocks mkdir", "utf8");
    const store = createFileTeamTaskStore({
      graphPath: path.join(invalidParent, "task-graph.json"),
    });

    await expect(store.initialize()).rejects.toMatchObject({
      code: "store_io",
      health: "degraded",
      name: "TeamTaskStoreError",
    });
  });

  it("reads fresh clones without acquiring or being distracted by sibling files", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    const initialized = await store.initialize();
    initialized.tasks.push({ id: "mutated-return-value" } as never);
    await fs.writeFile(`${graphPath}.orphan.tmp`, "{not json", "utf8");
    await fs.writeFile(`${graphPath}.lock`, "held", "utf8");

    const firstRead = await store.read();
    firstRead.tasks.push({ id: "mutated-read" } as never);

    expect(await store.read()).toEqual({
      nextTaskSequence: 1,
      revision: 0,
      schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
      tasks: [],
    });
  });

  it("reports a missing initialized graph as degraded instead of falling back to empty state", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await fs.unlink(graphPath);

    await expect(store.read()).rejects.toMatchObject({
      code: "graph_missing",
      health: "degraded",
    });
  });

  it("reports malformed JSON and unknown schema versions with stable degraded codes", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();

    await fs.writeFile(graphPath, "{not json", "utf8");
    await expect(store.read()).rejects.toMatchObject({
      code: "graph_malformed",
      health: "degraded",
    });

    await fs.writeFile(
      graphPath,
      `${JSON.stringify({
        nextTaskSequence: 1,
        revision: 0,
        schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION + 1,
        tasks: [],
      })}\n`,
      "utf8",
    );
    await expect(store.read()).rejects.toMatchObject({
      code: "schema_unsupported",
      health: "degraded",
    });
  });

  it("reports invalid graph fields with a stable degraded code", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await fs.writeFile(
      graphPath,
      `${JSON.stringify({
        nextTaskSequence: 0,
        ready: true,
        revision: -1,
        schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
        tasks: [],
      })}\n`,
      "utf8",
    );

    await expect(store.read()).rejects.toMatchObject({
      code: "graph_invalid",
      health: "degraded",
    });
  });

  it("rejects legacy evidence provenance and reference field names in persisted graphs", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();

    await writeGraphFixture(graphPath, {
      nextTaskSequence: 2,
      revision: 1,
      schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
      tasks: [
        {
          ...taskRecord("task_001"),
          evidence: [
            {
              reporterCallId: "legacy-call",
              reporterRole: "leader",
              reporterRound: 1,
              reporterSessionId: "leader-session",
              summary: "legacy provenance",
              timestamp: "2026-07-26T03:00:00.000Z",
            },
          ],
          status: "in_progress",
        },
      ],
    });

    await expect(store.read()).rejects.toMatchObject({
      code: "graph_invalid",
      health: "degraded",
    });

    await writeGraphFixture(graphPath, {
      nextTaskSequence: 2,
      revision: 1,
      schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
      tasks: [
        {
          ...taskRecord("task_001"),
          evidence: [
            {
              ...evidenceRecord(),
              references: [{ type: "artifact", value: "legacy-reference" }],
            },
          ],
          status: "in_progress",
        },
      ],
    });

    await expect(store.read()).rejects.toMatchObject({
      code: "graph_invalid",
      health: "degraded",
    });
  });

  it("creates normalized pending tasks with monotonic ids, revisions, and compact derived summaries", async () => {
    const graphPath = await createGraphPath();
    const now = new Date("2026-07-26T03:00:00.000Z");
    const store = createFileTeamTaskStore({ graphPath, now: () => now });
    await store.initialize();

    const first = await store.create(leader, {
      acceptance: [" test proves the behavior "],
      description: " implement the shared store ",
      title: " task graph ",
    });
    const second = await store.create(leader, {
      acceptance: ["second task is persisted"],
      description: "Create another task",
      title: "Second task",
    });

    expect(first).toEqual({
      nextStatus: "pending",
      operation: "create",
      revision: 1,
      task: {
        acceptance: ["test proves the behavior"],
        createdAt: "2026-07-26T03:00:00.000Z",
        dependencies: [],
        description: "implement the shared store",
        evidence: [],
        id: "task_001",
        status: "pending",
        title: "task graph",
        updatedAt: "2026-07-26T03:00:00.000Z",
      },
    });
    expect(second.task.id).toBe("task_002");
    expect(second.revision).toBe(2);
    expect(await store.list()).toEqual({
      revision: 2,
      tasks: [
        {
          dependencies: [],
          evidenceCount: 0,
          id: "task_001",
          ready: true,
          status: "pending",
          title: "task graph",
        },
        {
          dependencies: [],
          evidenceCount: 0,
          id: "task_002",
          ready: true,
          status: "pending",
          title: "Second task",
        },
      ],
    });
    expect(await store.get("task_001")).toEqual({
      ready: true,
      revision: 2,
      task: first.task,
    });

    const persisted = JSON.parse(await fs.readFile(graphPath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({ nextTaskSequence: 3, revision: 2 });
    expect(JSON.stringify(persisted)).not.toContain('"ready"');
  });

  it("rejects non-leader creation and invalid contracts without changing the revision", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();

    await expect(
      store.create({ role: "child", sessionId: "child-session" }, validCreateInput()),
    ).rejects.toMatchObject({
      code: "permission_denied",
      health: "healthy",
    });

    for (const input of [
      { ...validCreateInput(), title: " " },
      { ...validCreateInput(), description: "" },
      { ...validCreateInput(), acceptance: [] },
      { ...validCreateInput(), acceptance: ["okay", " "] },
    ]) {
      await expect(store.create(leader, input)).rejects.toMatchObject({
        code: "invalid_input",
        health: "healthy",
      });
    }

    expect((await store.read()).revision).toBe(0);
  });

  it("serializes concurrent mutations from separate store instances without losing ids or revisions", async () => {
    const graphPath = await createGraphPath();
    const firstStore = createFileTeamTaskStore({ graphPath });
    const secondStore = createFileTeamTaskStore({ graphPath });
    await firstStore.initialize();

    const created = await Promise.all([
      firstStore.create(leader, {
        acceptance: ["first exists"],
        description: "First concurrent write",
        title: "First",
      }),
      secondStore.create(leader, {
        acceptance: ["second exists"],
        description: "Second concurrent write",
        title: "Second",
      }),
    ]);

    expect(created.map((result) => result.task.id).sort()).toEqual(["task_001", "task_002"]);
    expect(created.map((result) => result.revision).sort()).toEqual([1, 2]);
    expect(await firstStore.list()).toMatchObject({
      revision: 2,
      tasks: [{ id: "task_001" }, { id: "task_002" }],
    });
  });

  it("times out on an existing lock without reclaiming it or mutating the graph", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    const lockPath = `${graphPath}.lock`;
    await fs.writeFile(lockPath, "held by another writer", "utf8");
    const startedAt = performance.now();

    const failure = await store.create(leader, validCreateInput()).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "task_store_busy",
      health: "degraded",
    });
    expect(failure).not.toHaveProperty("committedMutation");

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(await fs.readFile(lockPath, "utf8")).toBe("held by another writer");
    expect((await store.read()).revision).toBe(0);
  });

  it("maps lock cleanup failures to a stable degraded store error", async () => {
    const graphPath = await createGraphPath();
    const lockPath = `${graphPath}.lock`;
    const store = createFileTeamTaskStore({
      graphPath,
      now: () => {
        unlinkSync(lockPath);
        mkdirSync(lockPath);
        return new Date("2026-07-26T03:00:00.000Z");
      },
    });
    await store.initialize();

    const failure = await store.create(leader, validCreateInput()).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "store_io",
      committedMutation: {
        nextStatus: "pending",
        operation: "create",
        revision: 1,
        task: {
          acceptance: ["task behavior is verified"],
          createdAt: "2026-07-26T03:00:00.000Z",
          dependencies: [],
          description: "Implement the task",
          evidence: [],
          id: "task_001",
          status: "pending",
          title: "Shared task",
          updatedAt: "2026-07-26T03:00:00.000Z",
        },
      },
      health: "degraded",
      name: "TeamTaskStoreError",
    });
    expect((await store.read()).revision).toBe(1);
    expect((await fs.stat(lockPath)).isDirectory()).toBe(true);
  });

  it("derives readiness from completed dependencies and never stores it", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, {
      acceptance: ["foundation exists"],
      description: "Create the foundation",
      title: "Foundation",
    });
    await store.create(leader, {
      acceptance: ["dependent exists"],
      dependencies: ["task_001"],
      description: "Wait for the foundation",
      title: "Dependent",
    });

    expect(await store.list()).toMatchObject({
      revision: 2,
      tasks: [
        { id: "task_001", ready: true },
        { dependencies: ["task_001"], id: "task_002", ready: false },
      ],
    });
    expect(JSON.stringify(JSON.parse(await fs.readFile(graphPath, "utf8")))).not.toContain('"ready"');
  });

  it("rejects duplicate, unknown, and self dependencies during creation without mutating the graph", async () => {
    for (const dependencies of [
      ["task_999"],
      ["task_001"],
    ]) {
      const graphPath = await createGraphPath();
      const store = createFileTeamTaskStore({ graphPath });
      await store.initialize();

      await expect(
        store.create(leader, { ...validCreateInput(), dependencies }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        health: "healthy",
      });
      expect(await store.read()).toMatchObject({ nextTaskSequence: 1, revision: 0, tasks: [] });
    }

    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());

    await expect(
      store.create(leader, { ...validCreateInput(), dependencies: ["task_001", "task_001"] }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      health: "healthy",
    });
    expect(await store.read()).toMatchObject({ nextTaskSequence: 2, revision: 1 });
  });

  it("degrades duplicate, unknown, self, and cyclic dependencies loaded from disk", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    const invalidTaskSets = [
      [taskRecord("task_001"), taskRecord("task_001")],
      [taskRecord("task_001", ["task_999"])],
      [taskRecord("task_001", ["task_001"])],
      [
        taskRecord("task_001", ["task_002"]),
        taskRecord("task_002", ["task_001"]),
      ],
    ];

    for (const tasks of invalidTaskSets) {
      await writeGraphFixture(graphPath, {
        nextTaskSequence: 3,
        revision: 2,
        schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
        tasks,
      });
      await expect(store.read()).rejects.toMatchObject({
        code: "graph_invalid",
        health: "degraded",
      });
    }
  });

  it("degrades strict task-field violations and a reused next sequence loaded from disk", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();

    for (const task of [
      { ...taskRecord("task_001"), ready: true },
      { ...taskRecord("task_001"), title: " " },
      { ...taskRecord("task_001"), status: "unknown" },
      { ...taskRecord("task_001"), evidence: "not-an-array" },
    ]) {
      await writeGraphFixture(graphPath, {
        nextTaskSequence: 2,
        revision: 1,
        schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
        tasks: [task],
      });
      await expect(store.read()).rejects.toMatchObject({
        code: "graph_invalid",
        health: "degraded",
      });
    }

    await writeGraphFixture(graphPath, {
      nextTaskSequence: 1,
      revision: 1,
      schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
      tasks: [taskRecord("task_001")],
    });
    await expect(store.read()).rejects.toMatchObject({
      code: "graph_invalid",
      health: "degraded",
    });
  });

  it("enforces the listed pending, in-progress, and blocked transitions", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());

    await expect(
      store.update(leader, "task_001", { status: "blocked" }),
    ).rejects.toMatchObject({ code: "blocked_reason_required" });

    const blocked = await store.update(leader, "task_001", {
      blockedReason: " waiting for input ",
      status: "blocked",
    });
    expect(blocked).toMatchObject({
      nextStatus: "blocked",
      operation: "update",
      previousStatus: "pending",
      revision: 2,
      task: { blockedReason: "waiting for input", status: "blocked" },
    });

    await expect(
      store.update(leader, "task_001", { status: "in_progress" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    const pending = await store.update(leader, "task_001", { status: "pending" });
    expect(pending.task).not.toHaveProperty("blockedReason");
    expect(pending).toMatchObject({
      nextStatus: "pending",
      previousStatus: "blocked",
      revision: 3,
    });

    await store.update(leader, "task_001", { status: "in_progress" });
    await expect(
      store.update(leader, "task_001", { status: "blocked" }),
    ).rejects.toMatchObject({ code: "blocked_reason_required" });
    await store.update(leader, "task_001", {
      blockedReason: "dependency failed",
      status: "blocked",
    });
    await store.update(leader, "task_001", { status: "pending" });
    await store.update(leader, "task_001", { status: "in_progress" });
    const returned = await store.update(leader, "task_001", { status: "pending" });

    expect(returned).toMatchObject({
      nextStatus: "pending",
      previousStatus: "in_progress",
      task: { evidence: [], status: "pending" },
    });
  });

  it("starts a pending task only when every dependency is completed", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());
    await store.create(leader, {
      ...validCreateInput(),
      dependencies: ["task_001"],
      title: "Dependent",
    });

    await expect(
      store.update(leader, "task_002", { status: "in_progress" }),
    ).rejects.toMatchObject({
      code: "task_not_ready",
      health: "healthy",
    });
    expect((await store.read()).revision).toBe(2);

    await store.update(leader, "task_001", { status: "in_progress" });
    await expect(
      store.update(leader, "task_002", { status: "in_progress" }),
    ).rejects.toMatchObject({ code: "task_not_ready" });
  });

  it("lets a leader edit contracts while pending or blocked and freezes them while in progress", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());

    const pendingEdit = await store.update(leader, "task_001", {
      acceptance: [" updated criterion "],
      dependencies: [],
      description: " updated description ",
      title: " updated title ",
    });
    expect(pendingEdit).toMatchObject({
      operation: "update",
      revision: 2,
      task: {
        acceptance: ["updated criterion"],
        dependencies: [],
        description: "updated description",
        status: "pending",
        title: "updated title",
      },
    });
    expect(pendingEdit).not.toHaveProperty("previousStatus");

    await store.update(leader, "task_001", {
      blockedReason: "waiting",
      status: "blocked",
    });
    await store.update(leader, "task_001", {
      blockedReason: "still waiting",
      description: "blocked tasks remain editable",
    });
    expect(await store.get("task_001")).toMatchObject({
      task: {
        blockedReason: "still waiting",
        description: "blocked tasks remain editable",
      },
    });

    await store.update(leader, "task_001", { status: "pending" });
    await store.update(leader, "task_001", { status: "in_progress" });
    await expect(
      store.update(leader, "task_001", { title: "forbidden" }),
    ).rejects.toMatchObject({
      code: "contract_frozen",
      health: "healthy",
    });
    await expect(
      store.update(leader, "task_001", { status: "pending", title: "bypass" }),
    ).rejects.toMatchObject({ code: "contract_frozen" });
  });

  it("rejects update-time unknown, self, duplicate, and cyclic topology without revision changes", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());
    await store.create(leader, {
      ...validCreateInput(),
      dependencies: ["task_001"],
      title: "Dependent",
    });

    for (const dependencies of [
      ["task_999"],
      ["task_001"],
      ["task_002", "task_002"],
      ["task_002"],
    ]) {
      const taskId = dependencies[0] === "task_001" ? "task_001" : "task_001";
      await expect(
        store.update(leader, taskId, { dependencies }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        health: "healthy",
      });
      expect((await store.read()).revision).toBe(2);
    }

    await store.update(leader, "task_001", { description: "lock was released after failures" });
    expect((await store.read()).revision).toBe(3);
  });

  it("rejects child updates, empty patches, invalid reasons, and unlisted transitions", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());

    await expect(
      store.update({ role: "child", sessionId: "child-session" }, "task_001", { title: "no" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(store.update(leader, "task_001", {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      store.update(leader, "task_001", { blockedReason: "not blocked" }),
    ).rejects.toMatchObject({ code: "blocked_reason_not_allowed" });
    await expect(
      store.update(leader, "task_001", { blockedReason: " ", status: "blocked" }),
    ).rejects.toMatchObject({ code: "blocked_reason_required" });
    await expect(
      store.update(leader, "task_001", { status: "completed" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect((await store.read()).revision).toBe(1);
  });

  it("appends typed evidence only while in progress with actor provenance", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({
      graphPath,
      now: () => new Date("2026-07-26T04:00:00.000Z"),
    });
    await store.initialize();
    await store.create(leader, validCreateInput());

    await expect(
      store.addEvidence(leader, "task_001", validEvidenceInput()),
    ).rejects.toMatchObject({
      code: "evidence_not_allowed",
      health: "healthy",
    });

    await store.update(leader, "task_001", { status: "in_progress" });
    const added = await store.addEvidence(leader, "task_001", {
      callId: " call_leader ",
      references: [
        { kind: "artifact", value: " test/runtime/teamTaskStore.test.ts " },
        { kind: "trace", value: " trace-event-1 " },
        { kind: "external", value: " https://example.test/evidence " },
      ],
      round: 3,
      summary: " tests passed ",
    });

    expect(added).toEqual({
      operation: "add_evidence",
      revision: 3,
      task: expect.objectContaining({
        evidence: [
          {
            references: [
              { kind: "artifact", value: "test/runtime/teamTaskStore.test.ts" },
              { kind: "trace", value: "trace-event-1" },
              { kind: "external", value: "https://example.test/evidence" },
            ],
            callId: "call_leader",
            reportedAt: "2026-07-26T04:00:00.000Z",
            reportedByRole: "leader",
            reportedBySessionId: "leader-session",
            round: 3,
            summary: "tests passed",
          },
        ],
      }),
    });

    added.task.evidence[0]!.summary = "mutated return";
    expect((await store.get("task_001")).task.evidence[0]!.summary).toBe("tests passed");
  });

  it("lets a child append only to its delegated task and preserves append-only evidence across retry", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());
    await store.update(leader, "task_001", { status: "in_progress" });

    for (const actor of [
      { role: "child", sessionId: "child-session" } as const,
      { delegatedTaskId: "task_999", role: "child", sessionId: "child-session" } as const,
    ]) {
      await expect(
        store.addEvidence(actor, "task_001", validEvidenceInput()),
      ).rejects.toMatchObject({
        code: "delegated_task_mismatch",
        health: "healthy",
      });
    }

    await store.addEvidence(
      {
        delegatedTaskId: "task_001",
        role: "child",
        sessionId: "child-session",
      },
      "task_001",
      { ...validEvidenceInput(), callId: "call_child", summary: "child evidence" },
    );
    await store.update(leader, "task_001", { status: "pending" });
    expect((await store.get("task_001")).task.evidence).toHaveLength(1);

    await store.update(leader, "task_001", { status: "in_progress" });
    await store.addEvidence(leader, "task_001", {
      ...validEvidenceInput(),
      callId: "call_retry",
      summary: "retry evidence",
    });

    expect((await store.get("task_001")).task.evidence.map((record) => record.summary)).toEqual([
      "child evidence",
      "retry evidence",
    ]);
  });

  it("requires valid evidence and a leader before completing, then freezes the completed task", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());
    await store.create(leader, {
      ...validCreateInput(),
      dependencies: ["task_001"],
      title: "Dependent",
    });
    await store.update(leader, "task_001", { status: "in_progress" });

    await expect(
      store.update(leader, "task_001", { status: "completed" }),
    ).rejects.toMatchObject({
      code: "evidence_required",
      health: "healthy",
    });
    await expect(
      store.update(
        {
          delegatedTaskId: "task_001",
          role: "child",
          sessionId: "child-session",
        },
        "task_001",
        { status: "completed" },
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });

    await store.addEvidence(leader, "task_001", validEvidenceInput());
    const completed = await store.update(leader, "task_001", { status: "completed" });
    expect(completed).toMatchObject({
      nextStatus: "completed",
      previousStatus: "in_progress",
      task: { status: "completed" },
    });
    expect((await store.get("task_001")).ready).toBe(false);
    expect((await store.get("task_002")).ready).toBe(true);

    await expect(
      store.update(leader, "task_001", { status: "pending" }),
    ).rejects.toMatchObject({ code: "task_frozen" });
    await expect(
      store.update(leader, "task_001", { description: "forbidden" }),
    ).rejects.toMatchObject({ code: "task_frozen" });
    await expect(
      store.addEvidence(leader, "task_001", validEvidenceInput()),
    ).rejects.toMatchObject({ code: "evidence_not_allowed" });
  });

  it("rejects malformed evidence and completion with incomplete dependencies without mutating", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());
    await store.update(leader, "task_001", { status: "in_progress" });

    for (const input of [
      { ...validEvidenceInput(), summary: " " },
      { ...validEvidenceInput(), callId: "" },
      { ...validEvidenceInput(), round: 0 },
      {
        ...validEvidenceInput(),
        references: [{ kind: "unknown", value: "ref" }],
      },
      {
        ...validEvidenceInput(),
        references: [{ kind: "artifact", value: " " }],
      },
      {
        ...validEvidenceInput(),
        references: [{ type: "artifact", value: "legacy-reference-field" }],
      },
    ]) {
      await expect(
        store.addEvidence(leader, "task_001", input as never),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect((await store.get("task_001")).task.evidence).toEqual([]);

    await writeGraphFixture(graphPath, {
      nextTaskSequence: 3,
      revision: 7,
      schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
      tasks: [
        taskRecord("task_001"),
        {
          ...taskRecord("task_002", ["task_001"]),
          evidence: [evidenceRecord()],
          status: "in_progress",
        },
      ],
    });
    await expect(
      store.update(leader, "task_002", { status: "completed" }),
    ).rejects.toMatchObject({
      code: "dependencies_incomplete",
      health: "healthy",
    });
    expect((await store.read()).revision).toBe(7);
  });

  it("deletes only an unreferenced pending task without evidence and never reuses its id", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());
    await store.create(leader, {
      ...validCreateInput(),
      dependencies: ["task_001"],
      title: "Dependent",
    });

    await expect(store.delete(leader, "task_001")).rejects.toMatchObject({
      code: "delete_not_allowed",
      health: "healthy",
    });
    expect((await store.read()).revision).toBe(2);

    const deleted = await store.delete(leader, "task_002");
    expect(deleted).toMatchObject({
      operation: "delete",
      revision: 3,
      task: { id: "task_002", status: "pending" },
    });

    const replacement = await store.create(leader, {
      ...validCreateInput(),
      title: "Replacement",
    });
    expect(replacement).toMatchObject({
      revision: 4,
      task: { id: "task_003" },
    });
    expect((await store.read()).nextTaskSequence).toBe(4);
  });

  it("rejects child, non-pending, and evidenced-task deletion without mutation", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    await store.initialize();
    await store.create(leader, validCreateInput());

    await expect(
      store.delete({ role: "child", sessionId: "child-session" }, "task_001"),
    ).rejects.toMatchObject({ code: "permission_denied" });

    await store.update(leader, "task_001", { status: "in_progress" });
    await expect(store.delete(leader, "task_001")).rejects.toMatchObject({
      code: "delete_not_allowed",
    });

    await store.addEvidence(leader, "task_001", validEvidenceInput());
    await store.update(leader, "task_001", { status: "pending" });
    await expect(store.delete(leader, "task_001")).rejects.toMatchObject({
      code: "delete_not_allowed",
    });

    expect(await store.get("task_001")).toMatchObject({
      revision: 4,
      task: { evidence: [expect.any(Object)], status: "pending" },
    });
  });
});

async function createGraphPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-team-task-"));
  return path.join(root, ".forge", "sessions", "root-session", "task-graph.json");
}

const leader: TeamTaskActor = {
  role: "leader",
  sessionId: "leader-session",
};

function validCreateInput() {
  return {
    acceptance: ["task behavior is verified"],
    description: "Implement the task",
    title: "Shared task",
  };
}

function validEvidenceInput() {
  return {
    callId: "call_1",
    round: 1,
    summary: "verification passed",
  };
}

function taskRecord(id: string, dependencies: string[] = []) {
  return {
    acceptance: ["criterion"],
    createdAt: "2026-07-26T03:00:00.000Z",
    dependencies,
    description: "Description",
    evidence: [],
    id,
    status: "pending",
    title: "Title",
    updatedAt: "2026-07-26T03:00:00.000Z",
  };
}

function evidenceRecord() {
  return {
    callId: "call_1",
    reportedAt: "2026-07-26T03:00:00.000Z",
    reportedByRole: "leader",
    reportedBySessionId: "leader-session",
    round: 1,
    summary: "evidence",
  };
}

async function writeGraphFixture(graphPath: string, graph: unknown): Promise<void> {
  await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}
