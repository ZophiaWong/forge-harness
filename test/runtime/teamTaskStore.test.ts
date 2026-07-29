import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  TEAM_TASK_GRAPH_SCHEMA_VERSION,
  parseTeamTaskGraphFile,
} from "../../src/domain/teamTask.js";
import {
  TEAM_TASK_LOCK_TIMEOUT_MS,
  createFileTeamTaskStore,
} from "../../src/runtime/teamTaskStore.js";

const leader = { role: "leader" as const, sessionId: "leader-session" };

describe("FileTeamTaskStore persistence", () => {
  it("initializes the exact empty v2 graph once", async () => {
    const { graphPath, store } = await fixture();
    const expected = {
      nextTaskSequence: 1,
      revision: 0,
      schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
      tasks: [],
    };

    expect(await store.initialize()).toEqual(expected);
    expect(await store.initialize()).toEqual(expected);
    expect(JSON.parse(await fs.readFile(graphPath, "utf8"))).toEqual(expected);
  });

  it("never recreates an initialized graph that disappears", async () => {
    const { graphPath, store } = await fixture();
    await store.initialize();
    await fs.unlink(graphPath);

    await expect(store.initialize()).rejects.toMatchObject({
      code: "graph_missing",
      health: "degraded",
    });
  });

  it("serializes first initialization and concurrent creates across store instances", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-task-store-"));
    const graphPath = path.join(root, "task-graph.json");
    const first = createFileTeamTaskStore({ graphPath });
    const second = createFileTeamTaskStore({ graphPath });

    expect(await Promise.all([first.initialize(), second.initialize()])).toEqual([
      expect.objectContaining({ revision: 0 }),
      expect.objectContaining({ revision: 0 }),
    ]);
    const created = await Promise.all([
      first.create(leader, contract("First")),
      second.create(leader, contract("Second")),
    ]);

    expect(created.map((result) => result.task.id).sort()).toEqual(["task_001", "task_002"]);
    expect(created.map((result) => result.revision).sort()).toEqual([1, 2]);
  });

  it("reports malformed JSON, unsupported schemas, and invalid combinations as degraded", async () => {
    const { graphPath, store } = await fixture();
    await store.initialize();

    await fs.writeFile(graphPath, "{bad json", "utf8");
    await expect(store.read()).rejects.toMatchObject({ code: "graph_malformed" });

    await fs.writeFile(graphPath, JSON.stringify({
      nextTaskSequence: 1,
      revision: 0,
      schemaVersion: 1,
      tasks: [],
    }));
    await expect(store.read()).rejects.toMatchObject({ code: "schema_unsupported" });

    expect(() => parseTeamTaskGraphFile({
      nextTaskSequence: 2,
      revision: 1,
      schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
      tasks: [{
        acceptance: ["Accepted"],
        createdAt: "2026-07-28T00:00:00.000Z",
        dependencies: [],
        description: "Invalid edit task",
        evidence: [],
        id: "task_001",
        kind: "edit",
        status: "pending",
        title: "Invalid",
        trace: [],
        transferCount: 0,
        updatedAt: "2026-07-28T00:00:00.000Z",
      }],
    })).toThrowError(expect.objectContaining({ code: "graph_invalid" }));
  });

  it("keeps update restricted to an unacquired pending contract", async () => {
    const { store } = await initializedFixture();
    await store.create(leader, contract("Pending"));
    await store.update(leader, "task_001", {
      description: "Updated while pending",
      title: "Updated",
    });
    expect(await store.get("task_001")).toMatchObject({
      task: {
        description: "Updated while pending",
        title: "Updated",
      },
    });

    await store.transition(leader, {
      action: "assign",
      assignee: { role: "leader" },
      id: "task_001",
    });
    await expect(
      store.update(leader, "task_001", { title: "Too late" }),
    ).rejects.toMatchObject({ code: "contract_frozen" });
    await expect(
      store.update(leader, "task_001", { status: "completed" } as never),
    ).rejects.toMatchObject({ code: "contract_frozen" });
  });

  it("deletes only untouched pending tasks without dependents", async () => {
    const { store } = await initializedFixture();
    await store.create(leader, contract("Foundation"));
    await store.create(leader, {
      ...contract("Dependent"),
      dependencies: ["task_001"],
    });

    await expect(store.delete(leader, "task_001")).rejects.toMatchObject({
      code: "delete_not_allowed",
    });
    await store.delete(leader, "task_002");
    expect((await store.list()).tasks.map((task) => task.id)).toEqual(["task_001"]);
  });

  it("times out on an existing lock without mutating the graph", async () => {
    const { graphPath, store } = await initializedFixture();
    await fs.writeFile(`${graphPath}.lock`, "held", "utf8");
    const started = performance.now();

    await expect(store.create(leader, contract("Blocked"))).rejects.toMatchObject({
      code: "task_store_busy",
      health: "degraded",
    });

    expect(performance.now() - started).toBeGreaterThanOrEqual(
      TEAM_TASK_LOCK_TIMEOUT_MS - 100,
    );
    expect((await store.read()).revision).toBe(0);
  });

  it("returns defensive clones from reads and mutations", async () => {
    const { store } = await initializedFixture();
    const created = await store.create(leader, contract("Clone"));
    created.task.title = "mutated";
    const graph = await store.read();
    graph.tasks[0]!.title = "also mutated";

    expect((await store.get("task_001")).task.title).toBe("Clone");
  });
});

function contract(title: string) {
  return {
    acceptance: ["The result is reviewed"],
    description: "Scoped research task",
    kind: "research" as const,
    title,
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-task-store-"));
  const graphPath = path.join(root, "task-graph.json");
  return {
    graphPath,
    store: createFileTeamTaskStore({
      graphPath,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    }),
  };
}

async function initializedFixture() {
  const result = await fixture();
  await result.store.initialize();
  return result;
}
