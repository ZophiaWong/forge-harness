import { mkdirSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { TeamTaskActor } from "../../src/domain/teamTask.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";
import {
  createTeamTaskToolRuntime,
  taskAddEvidenceToolDefinition,
  taskCreateToolDefinition,
  taskGetToolDefinition,
  taskListToolDefinition,
  taskUpdateToolDefinition,
} from "../../src/tools/teamTaskTools.js";

describe("team task tool definitions", () => {
  it("declare narrow object schemas for the five task operations", () => {
    expect(taskListToolDefinition).toMatchObject({
      name: "task_list",
      parameters: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object",
      },
      strict: true,
      type: "function",
    });
    expect(taskGetToolDefinition).toMatchObject({
      name: "task_get",
      parameters: {
        additionalProperties: false,
        required: ["id"],
        type: "object",
      },
      strict: true,
    });
    expect(taskCreateToolDefinition).toMatchObject({
      name: "task_create",
      parameters: {
        additionalProperties: false,
        required: ["title", "description", "acceptance"],
        type: "object",
      },
      strict: false,
    });
    expect(taskUpdateToolDefinition).toMatchObject({
      name: "task_update",
      parameters: {
        additionalProperties: false,
        required: ["id"],
        type: "object",
      },
      strict: false,
    });
    expect(taskUpdateToolDefinition.parameters.properties).toMatchObject({
      delete: { type: "boolean" },
      status: {
        enum: ["pending", "in_progress", "blocked", "completed"],
        type: "string",
      },
    });
    expect(taskAddEvidenceToolDefinition).toMatchObject({
      name: "task_add_evidence",
      parameters: {
        additionalProperties: false,
        required: ["id", "summary"],
        type: "object",
      },
      strict: false,
    });
    expect(taskAddEvidenceToolDefinition.parameters.properties).toMatchObject({
      references: {
        items: {
          additionalProperties: false,
          properties: {
            kind: {
              enum: ["artifact", "trace", "external"],
              type: "string",
            },
            value: { type: "string" },
          },
          required: ["kind", "value"],
          type: "object",
        },
        type: "array",
      },
    });

    expect(Object.keys(
      taskListToolDefinition.parameters.properties as Record<string, unknown>,
    )).toEqual([]);
    expect(taskListToolDefinition.parameters.required).toEqual([]);
    expect(Object.keys(
      taskGetToolDefinition.parameters.properties as Record<string, unknown>,
    ).sort()).toEqual(["id"]);
    expect(taskGetToolDefinition.parameters.required).toEqual(["id"]);
    expect(Object.keys(
      taskCreateToolDefinition.parameters.properties as Record<string, unknown>,
    ).sort()).toEqual(["acceptance", "dependencies", "description", "title"]);
    expect(taskCreateToolDefinition.parameters.required).toEqual([
      "title",
      "description",
      "acceptance",
    ]);
    expect(Object.keys(
      taskUpdateToolDefinition.parameters.properties as Record<string, unknown>,
    ).sort()).toEqual([
      "acceptance",
      "blockedReason",
      "delete",
      "dependencies",
      "description",
      "id",
      "status",
      "title",
    ]);
    expect(taskUpdateToolDefinition.parameters.required).toEqual(["id"]);
    const addEvidenceProperties =
      taskAddEvidenceToolDefinition.parameters.properties as Record<string, unknown>;
    expect(Object.keys(addEvidenceProperties).sort()).toEqual(["id", "references", "summary"]);
    expect(taskAddEvidenceToolDefinition.parameters.required).toEqual(["id", "summary"]);
    const referencesSchema = addEvidenceProperties.references as {
      items: {
        properties: Record<string, unknown>;
        required: string[];
      };
    };
    expect(Object.keys(referencesSchema.items.properties).sort()).toEqual(["kind", "value"]);
    expect(referencesSchema.items.required).toEqual(["kind", "value"]);
  });
});

describe("createTeamTaskToolRuntime role matrix", () => {
  it.each([
    {
      actor: { role: "leader", sessionId: "root-session" } as const,
      expected: [
        "task_list",
        "task_get",
        "task_create",
        "task_update",
        "task_add_evidence",
      ],
      label: "leader",
    },
    {
      actor: { role: "child", sessionId: "child-ad-hoc" } as const,
      expected: ["task_list", "task_get"],
      label: "root-linked child without a delegated task",
    },
    {
      actor: {
        delegatedTaskId: "task_001",
        role: "child",
        sessionId: "child-linked",
      } as const,
      expected: ["task_list", "task_get", "task_add_evidence"],
      label: "root-linked child with a delegated task",
    },
  ])("exposes the $label tools", ({ actor, expected }) => {
    const runtime = roleRuntime(actor);

    expect(runtime.toolDefinitions().map((definition) => definition.name)).toEqual(expected);
  });
});

describe("team task inspection tools", () => {
  it("lists the current revision and compact ID-sorted task summaries", async () => {
    const { actor, runtime, store } = await initializedRuntime();
    await store.create(actor, {
      acceptance: ["First result is reviewed"],
      description: "Complete the first slice.",
      title: "First task",
    });
    await store.create(actor, {
      acceptance: ["Second result is reviewed"],
      dependencies: ["task_001"],
      description: "Complete the dependent slice.",
      title: "Second task",
    });

    const result = await runtime.execute({
      arguments: "{}",
      name: "task_list",
    });

    expect(result).toEqual({
      content: [
        "revision: 2",
        "tasks:",
        "- task_001 | status=pending | ready=true | dependencies=(none) | evidence=0 | First task",
        "- task_002 | status=pending | ready=false | dependencies=task_001 | evidence=0 | Second task",
      ].join("\n"),
      metadata: {
        observationSummary: "listed 2 team tasks at revision 2",
        revision: 2,
        tasks: [
          {
            dependencies: [],
            evidenceCount: 0,
            id: "task_001",
            ready: true,
            status: "pending",
            title: "First task",
          },
          {
            dependencies: ["task_001"],
            evidenceCount: 0,
            id: "task_002",
            ready: false,
            status: "pending",
            title: "Second task",
          },
        ],
      },
      status: "completed",
      toolName: "task_list",
    });
  });

  it("gets the full contract, blocked reason, evidence, and reporter provenance", async () => {
    const { actor, runtime, store } = await initializedRuntime();
    await store.create(actor, {
      acceptance: ["Build exits 0", "Focused test passes"],
      description: "Implement the tool projection.",
      title: "Implement tools",
    });
    await store.update(actor, "task_001", { status: "in_progress" });
    await store.addEvidence(actor, "task_001", {
      callId: "call_store_setup",
      references: [
        { kind: "artifact", value: "src/tools/teamTaskTools.ts" },
        { kind: "trace", value: ".forge/sessions/root/trace.jsonl" },
      ],
      round: 3,
      summary: "Focused tool tests pass.",
    });
    await store.update(actor, "task_001", {
      blockedReason: "Waiting for review",
      status: "blocked",
    });

    const result = await runtime.execute({
      arguments: JSON.stringify({ id: "task_001" }),
      name: "task_get",
    });

    expect(result.status).toBe("completed");
    expect(result.toolName).toBe("task_get");
    expect(result.metadata).toMatchObject({
      observationSummary: "read team task task_001 at revision 4",
      ready: false,
      revision: 4,
      task: {
        acceptance: ["Build exits 0", "Focused test passes"],
        blockedReason: "Waiting for review",
        dependencies: [],
        description: "Implement the tool projection.",
        id: "task_001",
        status: "blocked",
        title: "Implement tools",
      },
    });
    expect(result.content).toContain("revision: 4");
    expect(result.content).toContain("id: task_001");
    expect(result.content).toContain("title: Implement tools");
    expect(result.content).toContain("description: Implement the tool projection.");
    expect(result.content).toContain("status: blocked");
    expect(result.content).toContain("ready: false");
    expect(result.content).toContain("blocked_reason: Waiting for review");
    expect(result.content).toContain("dependencies: (none)");
    expect(result.content).toContain("acceptance:\n- Build exits 0\n- Focused test passes");
    expect(result.content).toContain("evidence:\n- summary: Focused tool tests pass.");
    expect(result.content).toContain("  reported_by_role: leader");
    expect(result.content).toContain("  reported_by_session_id: root-session");
    expect(result.content).toContain("  call_id: call_store_setup");
    expect(result.content).toContain("  round: 3");
    expect(result.content).toContain("  reported_at:");
    expect(result.content).toContain("  references:");
    expect(result.content).toContain("  - artifact: src/tools/teamTaskTools.ts");
    expect(result.content).toContain("  - trace: .forge/sessions/root/trace.jsonl");
  });
});

describe("team task mutation tools", () => {
  it("creates, updates, and appends contextual evidence with revision metadata", async () => {
    const { runtime, store } = await initializedRuntime();

    const created = await runtime.execute({
      arguments: JSON.stringify({
        acceptance: ["Focused test passes"],
        description: "Implement the task tools.",
        title: "Task tools",
      }),
      name: "task_create",
    });

    expect(created).toMatchObject({
      content: expect.stringContaining(
        "revision: 1\noperation: create\nnext_status: pending\ntask:\nid: task_001",
      ),
      metadata: {
        observationSummary: "created team task task_001 at revision 1",
        revision: 1,
        task: {
          acceptance: ["Focused test passes"],
          dependencies: [],
          description: "Implement the task tools.",
          evidence: [],
          id: "task_001",
          status: "pending",
          title: "Task tools",
        },
        taskGraphMutation: {
          nextStatus: "pending",
          operation: "create",
          revision: 1,
          taskId: "task_001",
        },
      },
      status: "completed",
      toolName: "task_create",
    });

    const updated = await runtime.execute({
      arguments: JSON.stringify({
        acceptance: ["Focused test passes", "Build passes"],
        description: "Implement and verify the task tools.",
        id: "task_001",
        status: "in_progress",
        title: "Team task tools",
      }),
      name: "task_update",
    });

    expect(updated).toMatchObject({
      content: expect.stringContaining(
        "revision: 2\noperation: update\nprevious_status: pending\nnext_status: in_progress",
      ),
      metadata: {
        observationSummary: "updated team task task_001 at revision 2",
        revision: 2,
        task: {
          acceptance: ["Focused test passes", "Build passes"],
          description: "Implement and verify the task tools.",
          id: "task_001",
          status: "in_progress",
          title: "Team task tools",
        },
        taskGraphMutation: {
          nextStatus: "in_progress",
          operation: "update",
          previousStatus: "pending",
          revision: 2,
          taskId: "task_001",
        },
      },
      status: "completed",
      toolName: "task_update",
    });

    const evidence = await runtime.execute(
      {
        arguments: JSON.stringify({
          id: "task_001",
          references: [
            { kind: "artifact", value: "src/tools/teamTaskTools.ts" },
          ],
          summary: "The focused suite passes.",
        }),
        name: "task_add_evidence",
      },
      { callId: "call_evidence", round: 7 },
    );

    expect(evidence).toMatchObject({
      content: expect.stringContaining("revision: 3\noperation: add_evidence"),
      metadata: {
        observationSummary: "added evidence to team task task_001 at revision 3",
        revision: 3,
        task: {
          evidence: [
            {
              references: [
                { kind: "artifact", value: "src/tools/teamTaskTools.ts" },
              ],
              callId: "call_evidence",
              reportedByRole: "leader",
              reportedBySessionId: "root-session",
              round: 7,
              summary: "The focused suite passes.",
            },
          ],
          id: "task_001",
          status: "in_progress",
        },
        taskGraphMutation: {
          operation: "add_evidence",
          revision: 3,
          taskId: "task_001",
        },
      },
      status: "completed",
      toolName: "task_add_evidence",
    });

    const completed = await runtime.execute({
      arguments: JSON.stringify({ id: "task_001", status: "completed" }),
      name: "task_update",
    });

    expect(completed).toMatchObject({
      metadata: {
        revision: 4,
        task: {
          id: "task_001",
          status: "completed",
        },
        taskGraphMutation: {
          nextStatus: "completed",
          operation: "update",
          previousStatus: "in_progress",
          revision: 4,
          taskId: "task_001",
        },
      },
      status: "completed",
      toolName: "task_update",
    });
    await expect(store.get("task_001")).resolves.toMatchObject({
      revision: 4,
      task: {
        evidence: [
          expect.objectContaining({
            callId: "call_evidence",
            reportedBySessionId: "root-session",
            round: 7,
          }),
        ],
        status: "completed",
      },
    });
  });

  it("deletes through task_update and returns the removed task at the new revision", async () => {
    const { runtime, store } = await initializedRuntime();
    await runtime.execute({
      arguments: JSON.stringify({
        acceptance: ["No longer needed"],
        description: "A disposable task.",
        title: "Disposable",
      }),
      name: "task_create",
    });

    const result = await runtime.execute({
      arguments: JSON.stringify({ delete: true, id: "task_001" }),
      name: "task_update",
    });

    expect(result).toMatchObject({
      content: expect.stringContaining("revision: 2\noperation: delete\ntask:\nid: task_001"),
      metadata: {
        observationSummary: "deleted team task task_001 at revision 2",
        revision: 2,
        task: {
          id: "task_001",
          status: "pending",
          title: "Disposable",
        },
        taskGraphMutation: {
          operation: "delete",
          revision: 2,
          taskId: "task_001",
        },
      },
      status: "completed",
      toolName: "task_update",
    });
    await expect(store.list()).resolves.toEqual({ revision: 2, tasks: [] });
  });
});

describe("team task tool failures", () => {
  it("rejects malformed argument shapes with stable metadata and no graph mutation", async () => {
    const { runtime, store } = await initializedRuntime();
    const malformedCalls = [
      { arguments: JSON.stringify({ extra: true }), name: "task_list" },
      { arguments: "[]", name: "task_get" },
      {
        arguments: JSON.stringify({
          acceptance: ["Pass"],
          description: "Description",
          extra: true,
          title: "Title",
        }),
        name: "task_create",
      },
      { arguments: JSON.stringify({ id: "task_001" }), name: "task_update" },
      {
        arguments: JSON.stringify({
          delete: true,
          id: "task_001",
          title: "Conflicting patch",
        }),
        name: "task_update",
      },
      { arguments: "{bad json", name: "task_add_evidence" },
    ];

    for (const call of malformedCalls) {
      const result = await runtime.execute(call);

      expect(result).toMatchObject({
        content: expect.stringContaining("reason_code: invalid_input\ngraph_health: healthy"),
        metadata: {
          graphHealth: "healthy",
          observationSummary: `${call.name} failed: invalid_input`,
          reasonCode: "invalid_input",
        },
        status: "failed",
        toolName: call.name,
      });
    }

    await expect(store.list()).resolves.toEqual({ revision: 0, tasks: [] });
  });

  it("rejects missing handler call provenance without appending evidence", async () => {
    const { runtime, store } = await initializedRuntime();
    await runtime.execute({
      arguments: JSON.stringify({
        acceptance: ["Pass"],
        description: "Collect evidence.",
        title: "Evidence task",
      }),
      name: "task_create",
    });
    await runtime.execute({
      arguments: JSON.stringify({ id: "task_001", status: "in_progress" }),
      name: "task_update",
    });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        id: "task_001",
        summary: "Missing runtime context.",
      }),
      name: "task_add_evidence",
    });

    expect(result).toMatchObject({
      metadata: {
        graphHealth: "healthy",
        observationSummary: "task_add_evidence failed: invalid_input",
        reasonCode: "invalid_input",
      },
      status: "failed",
      toolName: "task_add_evidence",
    });
    await expect(store.get("task_001")).resolves.toMatchObject({
      revision: 2,
      task: {
        evidence: [],
        status: "in_progress",
      },
    });
  });

  it("preserves stable healthy store failures and the current revision", async () => {
    const { runtime, store } = await initializedRuntime();
    await runtime.execute({
      arguments: JSON.stringify({
        acceptance: ["First passes"],
        description: "Complete first.",
        title: "First",
      }),
      name: "task_create",
    });
    await runtime.execute({
      arguments: JSON.stringify({
        acceptance: ["Second passes"],
        dependencies: ["task_001"],
        description: "Complete second.",
        title: "Second",
      }),
      name: "task_create",
    });

    const result = await runtime.execute({
      arguments: JSON.stringify({ id: "task_002", status: "in_progress" }),
      name: "task_update",
    });

    expect(result).toEqual({
      content: [
        'failed_reason: task "task_002" is not ready',
        "reason_code: task_not_ready",
        "graph_health: healthy",
      ].join("\n"),
      metadata: {
        graphHealth: "healthy",
        observationSummary: "task_update failed: task_not_ready",
        reasonCode: "task_not_ready",
      },
      status: "failed",
      toolName: "task_update",
    });
    await expect(store.list()).resolves.toMatchObject({
      revision: 2,
      tasks: [
        { id: "task_001", status: "pending" },
        { id: "task_002", status: "pending" },
      ],
    });
  });

  it("preserves stable degraded graph failures", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-team-task-missing-"));
    const actor = { role: "leader", sessionId: "root-session" } as const;
    const runtime = createTeamTaskToolRuntime({
      actor,
      store: createFileTeamTaskStore({
        graphPath: path.join(directory, "task-graph.json"),
      }),
    });

    const result = await runtime.execute({ arguments: "{}", name: "task_list" });

    expect(result).toMatchObject({
      content: expect.stringContaining(
        "reason_code: graph_missing\ngraph_health: degraded",
      ),
      metadata: {
        graphHealth: "degraded",
        observationSummary: "task_list failed: graph_missing",
        reasonCode: "graph_missing",
      },
      status: "failed",
      toolName: "task_list",
    });
  });

  it("returns a committed mutation with a stable degraded cleanup warning", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-team-task-cleanup-"));
    const graphPath = path.join(directory, "task-graph.json");
    const lockPath = `${graphPath}.lock`;
    const actor = { role: "leader", sessionId: "root-session" } as const;
    const store = createFileTeamTaskStore({
      graphPath,
      now: () => {
        unlinkSync(lockPath);
        mkdirSync(lockPath);
        return new Date("2026-07-26T04:00:00.000Z");
      },
    });
    await store.initialize();
    const runtime = createTeamTaskToolRuntime({ actor, store });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        acceptance: ["Focused test passes"],
        description: "Commit before cleanup.",
        title: "Cleanup warning",
      }),
      name: "task_create",
    });

    expect(result).toMatchObject({
      metadata: {
        graphHealth: "degraded",
        observationSummary: "created team task task_001 at revision 1",
        revision: 1,
        task: {
          id: "task_001",
          status: "pending",
          title: "Cleanup warning",
        },
        taskGraphMutation: {
          nextStatus: "pending",
          operation: "create",
          revision: 1,
          taskId: "task_001",
        },
        warningCode: "store_io",
        warningReason: "task graph mutation committed but lock cleanup failed",
      },
      status: "completed",
      toolName: "task_create",
    });
    expect(result.metadata).not.toHaveProperty("reasonCode");
    expect(result.content).toContain("revision: 1\noperation: create");
    expect(result.content).toContain(
      [
        "warning_reason: task graph mutation committed but lock cleanup failed",
        "warning_code: store_io",
        "graph_health: degraded",
      ].join("\n"),
    );
    await expect(store.read()).resolves.toMatchObject({
      revision: 1,
      tasks: [{ id: "task_001", status: "pending" }],
    });
    expect((await fs.stat(lockPath)).isDirectory()).toBe(true);
  });

  it("lets the store reject evidence outside a child's delegated task without mutation", async () => {
    const { actor, store } = await initializedRuntime();
    await store.create(actor, {
      acceptance: ["First passes"],
      description: "First task.",
      title: "First",
    });
    await store.create(actor, {
      acceptance: ["Second passes"],
      description: "Second task.",
      title: "Second",
    });
    await store.update(actor, "task_001", { status: "in_progress" });
    await store.update(actor, "task_002", { status: "in_progress" });
    const childRuntime = createTeamTaskToolRuntime({
      actor: {
        delegatedTaskId: "task_001",
        role: "child",
        sessionId: "child-session",
      },
      store,
    });

    const result = await childRuntime.execute(
      {
        arguments: JSON.stringify({
          id: "task_002",
          summary: "Evidence for the wrong task.",
        }),
        name: "task_add_evidence",
      },
      { callId: "call_child", round: 2 },
    );

    expect(result).toMatchObject({
      metadata: {
        graphHealth: "healthy",
        observationSummary: "task_add_evidence failed: delegated_task_mismatch",
        reasonCode: "delegated_task_mismatch",
      },
      status: "failed",
      toolName: "task_add_evidence",
    });
    await expect(store.get("task_002")).resolves.toMatchObject({
      revision: 4,
      task: {
        evidence: [],
        status: "in_progress",
      },
    });
  });
});

function roleRuntime(actor: TeamTaskActor) {
  return createTeamTaskToolRuntime({
    actor,
    store: createFileTeamTaskStore({
      graphPath: path.join(os.tmpdir(), `forge-team-task-role-${actor.sessionId}.json`),
    }),
  });
}

async function initializedRuntime() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-team-task-tools-"));
  const actor = { role: "leader", sessionId: "root-session" } as const;
  const store = createFileTeamTaskStore({
    graphPath: path.join(directory, "task-graph.json"),
    now: () => new Date("2026-07-26T04:00:00.000Z"),
  });
  await store.initialize();

  return {
    actor,
    runtime: createTeamTaskToolRuntime({ actor, store }),
    store,
  };
}
