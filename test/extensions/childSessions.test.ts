import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ResponseCreate } from "../../src/core/minimalLoop.js";
import {
  createAsyncChildSessionManager,
  createChildSessionRunner,
  createChildProfileToolRuntime,
  formatChildSessionNotification,
  formatChildProfileTask,
  listChangedFiles,
} from "../../src/extensions/childSessions.js";
import { createLifecycleEmitter } from "../../src/extensions/lifecycle.js";
import { createCliSessionTrace, type SessionMetadata } from "../../src/runtime/session.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";
import type { TraceEventPayload } from "../../src/runtime/trace.js";
import type { ChildSessionRunResult } from "../../src/tools/delegateTool.js";

describe("child session profiles", () => {
  it("uses fresh profile tool surfaces without bash, delegate, or cron tools", () => {
    expect(createChildProfileToolRuntime({ cwd: process.cwd(), profile: "research" }).toolDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "todo",
    ]);
    expect(createChildProfileToolRuntime({ cwd: process.cwd(), profile: "edit" }).toolDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "edit",
      "write",
      "todo",
    ]);
  });

  it("combines profile tools with root-bound read and delegated-evidence permissions", async () => {
    const root = await createRootTaskFixture();
    const adHocResearch = createChildProfileToolRuntime({
      cwd: root.repo,
      profile: "research",
      sessionId: "child-ad-hoc",
      taskGraph: root.binding,
    });
    const linkedEdit = createChildProfileToolRuntime({
      cwd: root.repo,
      profile: "edit",
      sessionId: "child-linked",
      taskGraph: {
        ...root.binding,
        delegatedTaskId: "task_001",
      },
    });

    expect(adHocResearch.toolDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "todo",
      "task_list",
      "task_get",
    ]);
    expect(linkedEdit.toolDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "edit",
      "write",
      "todo",
      "task_list",
      "task_get",
      "task_add_evidence",
    ]);
    await expect(
      adHocResearch.execute({ arguments: "{}", name: "task_list" }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      adHocResearch.execute({
        arguments: JSON.stringify({ id: "task_001", summary: "should not be accepted" }),
        name: "task_add_evidence",
      }),
    ).resolves.toMatchObject({ status: "blocked" });
    await expect(
      linkedEdit.execute(
        {
          arguments: JSON.stringify({
            id: "task_001",
            summary: "Verified the child task boundary.",
          }),
          name: "task_add_evidence",
        },
        { callId: "call_evidence", round: 2 },
      ),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(root.store.get("task_001")).resolves.toMatchObject({
      task: {
        evidence: [
          {
            callId: "call_evidence",
            reportedByRole: "child",
            reportedBySessionId: "child-linked",
            round: 2,
            summary: "Verified the child task boundary.",
          },
        ],
      },
    });
  });

  it.each([
    { profile: "research" as const, runInBackground: false },
    { profile: "research" as const, runInBackground: true },
    { profile: "edit" as const, runInBackground: false },
    { profile: "edit" as const, runInBackground: true },
  ])(
    "persists the exact root graph binding for $profile children with runInBackground=$runInBackground",
    async ({ profile, runInBackground }) => {
      const root = await createRootTaskFixture({ git: profile === "edit" });
      const parentEvents: TraceEventPayload[] = [];
      const runner = createChildSessionRunner({
        baseCwd: root.repo,
        parentLifecycleEmitter: createLifecycleEmitter({
          recorder: {
            async record(event) {
              parentEvents.push(event);
            },
          },
        }),
        parentSessionId: root.session.metadata.id,
        responseCreate: async () => ({
          output: [],
          output_text: "Child handoff without graph mutation.",
        }),
        taskGraph: root.binding,
      });
      const request = {
        maxToolRounds: 2,
        parentCallId: `call_${profile}_${String(runInBackground)}`,
        parentRound: 1,
        profile,
        runInBackground,
        task: "Inspect the active team task.",
        taskId: "task_001",
      };
      const before = await root.store.read();
      const result = runInBackground
        ? await (await runner.start(request)).promise
        : await runner.run(request);
      const childMetadata = JSON.parse(
        await fs.readFile(path.join(path.dirname(result.tracePath), "session.json"), "utf8"),
      ) as SessionMetadata;

      expect(result.status).toBe("completed");
      expect(childMetadata.taskGraph).toEqual({
        delegatedTaskId: "task_001",
        rootSessionId: root.session.metadata.id,
        taskGraphPath: root.binding.taskGraphPath,
      });
      expect(path.isAbsolute(childMetadata.taskGraph!.taskGraphPath)).toBe(true);
      if (profile === "edit") {
        expect(childMetadata.cwd).not.toBe(root.repo);
        expect(childMetadata.workspace?.path).toBe(childMetadata.cwd);
      } else {
        expect(childMetadata.cwd).toBe(root.repo);
        expect(childMetadata.workspace).toBeUndefined();
      }
      expect(await root.store.read()).toEqual(before);
      expect(parentEvents.map((event) => event.type)).toContain("child_session_handoff");
    },
  );

  it("preserves an ad-hoc child's root graph binding without granting evidence permission", async () => {
    const root = await createRootTaskFixture();
    const runner = createChildSessionRunner({
      baseCwd: root.repo,
      parentLifecycleEmitter: createLifecycleEmitter({
        recorder: {
          async record() {
            return undefined;
          },
        },
      }),
      parentSessionId: root.session.metadata.id,
      responseCreate: async () => ({
        output: [],
        output_text: "Ad-hoc research complete.",
      }),
      taskGraph: root.binding,
    });

    const result = await runner.run({
      maxToolRounds: 2,
      parentCallId: "call_ad_hoc",
      parentRound: 1,
      profile: "research",
      runInBackground: false,
      task: "Inspect shared task context without owning evidence.",
    });
    const childMetadata = JSON.parse(
      await fs.readFile(path.join(path.dirname(result.tracePath), "session.json"), "utf8"),
    ) as SessionMetadata;
    if (!childMetadata.taskGraph) {
      throw new Error("ad-hoc child did not persist the root task graph binding");
    }
    const runtime = createChildProfileToolRuntime({
      cwd: root.repo,
      profile: "research",
      sessionId: result.childSessionId,
      taskGraph: childMetadata.taskGraph,
    });

    expect(childMetadata.taskGraph).toEqual(root.binding);
    expect(runtime.toolDefinitions().map((tool) => tool.name)).toContain("task_list");
    expect(runtime.toolDefinitions().map((tool) => tool.name)).not.toContain("task_add_evidence");
  });

  it("includes the exact linked team task id in the child model input", async () => {
    const root = await createRootTaskFixture();
    const modelRequests: Parameters<ResponseCreate>[0][] = [];
    const runner = createChildSessionRunner({
      baseCwd: root.repo,
      parentLifecycleEmitter: createLifecycleEmitter({
        recorder: {
          async record() {
            return undefined;
          },
        },
      }),
      parentSessionId: root.session.metadata.id,
      responseCreate: async (request) => {
        modelRequests.push(request);
        return {
          output: [],
          output_text: "Linked task inspected.",
        };
      },
      taskGraph: root.binding,
    });

    const result = await runner.run({
      maxToolRounds: 2,
      parentCallId: "call_linked_input",
      parentRound: 1,
      profile: "research",
      runInBackground: false,
      task: "Inspect the delegated contract.",
      taskId: "task_005",
    });

    expect(result.status).toBe("completed");
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]!.input).toEqual([
      {
        content: expect.stringContaining("Linked team task ID: task_005"),
        role: "user",
      },
    ]);
    expect(JSON.stringify(modelRequests[0]!.input)).not.toContain("task_001");
  });

  it("does not add a linked-task instruction to an ad-hoc child model input", async () => {
    const root = await createRootTaskFixture();
    const modelRequests: Parameters<ResponseCreate>[0][] = [];
    const runner = createChildSessionRunner({
      baseCwd: root.repo,
      parentLifecycleEmitter: createLifecycleEmitter({
        recorder: {
          async record() {
            return undefined;
          },
        },
      }),
      parentSessionId: root.session.metadata.id,
      responseCreate: async (request) => {
        modelRequests.push(request);
        return {
          output: [],
          output_text: "Ad-hoc inspection complete.",
        };
      },
      taskGraph: root.binding,
    });

    const result = await runner.run({
      maxToolRounds: 2,
      parentCallId: "call_ad_hoc_input",
      parentRound: 1,
      profile: "research",
      runInBackground: false,
      task: "Inspect the shared graph generally.",
    });

    expect(result.status).toBe("completed");
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]!.input).toEqual([
      {
        content: expect.stringContaining("Delegated task:\nInspect the shared graph generally."),
        role: "user",
      },
    ]);
    expect(JSON.stringify(modelRequests[0]!.input)).not.toContain("Linked team task ID:");
  });

  it("records a linked child's mutation only in the child trace and never derives evidence from handoff", async () => {
    const root = await createRootTaskFixture();
    const parentEvents: TraceEventPayload[] = [];
    let modelRound = 0;
    const runner = createChildSessionRunner({
      baseCwd: root.repo,
      parentLifecycleEmitter: createLifecycleEmitter({
        recorder: {
          async record(event) {
            parentEvents.push(event);
          },
        },
      }),
      parentSessionId: root.session.metadata.id,
      responseCreate: async () => {
        modelRound += 1;
        return modelRound === 1
          ? {
              output: [
                {
                  arguments: JSON.stringify({
                    id: "task_001",
                    summary: "Verified the child trace boundary.",
                  }),
                  call_id: "call_child_evidence",
                  name: "task_add_evidence",
                  type: "function_call",
                },
              ],
              output_text: "",
            }
          : {
              output: [],
              output_text: "Child evidence recorded.",
            };
      },
      taskGraph: root.binding,
    });

    const result = await runner.run({
      maxToolRounds: 3,
      parentCallId: "call_delegate",
      parentRound: 1,
      profile: "research",
      runInBackground: false,
      task: "Verify the active task.",
      taskId: "task_001",
    });
    const childEvents = (await fs.readFile(result.tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(parentEvents.filter((event) => event.type === "task_graph_mutated")).toEqual([]);
    expect(
      childEvents.filter((event) => event.type === "task_graph_mutated"),
    ).toEqual([
      expect.objectContaining({
        operation: "add_evidence",
        revision: 3,
        sessionId: result.childSessionId,
        taskId: "task_001",
        type: "task_graph_mutated",
      }),
    ]);
    await expect(root.store.get("task_001")).resolves.toMatchObject({
      revision: 3,
      task: {
        evidence: [
          {
            callId: "call_child_evidence",
            reportedBySessionId: result.childSessionId,
            summary: "Verified the child trace boundary.",
          },
        ],
      },
    });
  });

  it("prepends profile-specific prompt prose while preserving child skill invocations", () => {
    const task = formatChildProfileTask({
      profile: "research",
      task: "/chapter-handoff Inspect the previous chapter gap.",
    });

    expect(task).toContain("You are a fresh research child session.");
    expect(task).toContain("Report findings, evidence, open questions, and the next step");
    expect(task).toContain("/chapter-handoff Inspect the previous chapter gap.");
  });

  it("permits linked research children to append task evidence without editing files", () => {
    const task = formatChildProfileTask({
      profile: "research",
      task: "Inspect the delegated task and append evidence.",
      taskId: "task_001",
    });

    expect(task).toContain(
      "task_add_evidence is permitted coordination metadata and does not edit project files",
    );
    expect(task).toContain("Use it when the delegated task requests evidence");
    expect(task).toContain(
      "Follow the explicit delegated task before doing any broader investigation",
    );
    expect(task).toContain(
      "do not inspect unrelated files after the requested evidence is recorded",
    );
  });

  it("lists changed files from git porcelain status without inline diff", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-child-status-"));
    await fs.writeFile(path.join(cwd, "unchanged.txt"), "base\n", "utf8");
    await execGit(cwd, ["init"]);
    await execGit(cwd, ["config", "user.email", "test@example.com"]);
    await execGit(cwd, ["config", "user.name", "Test User"]);
    await execGit(cwd, ["add", "unchanged.txt"]);
    await execGit(cwd, ["commit", "-m", "base"]);
    await fs.writeFile(path.join(cwd, "unchanged.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(cwd, "new.txt"), "new\n", "utf8");

    await expect(listChangedFiles(cwd)).resolves.toEqual(["new.txt", "unchanged.txt"]);
  });
});

describe("AsyncChildSessionManager", () => {
  it("starts multiple child sessions and drains terminal notifications once in start order", async () => {
    const first = createDeferred<ChildSessionRunResult>();
    const second = createDeferred<ChildSessionRunResult>();
    const runner = {
      run: vi.fn(),
      start: vi
        .fn()
        .mockReturnValueOnce({
          childSessionId: "child-1",
          profile: "research",
          promise: first.promise,
          status: "running",
          tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        })
        .mockReturnValueOnce({
          childSessionId: "child-2",
          profile: "edit",
          promise: second.promise,
          status: "running",
          tracePath: "/repo/.forge/sessions/child-2/trace.jsonl",
        }),
    };
    const manager = createAsyncChildSessionManager({ runner });

    const firstStart = await manager.start({
      maxToolRounds: 4,
      parentCallId: "call_1",
      parentRound: 1,
      profile: "research",
      runInBackground: true,
      task: "Inspect docs.",
    });
    const secondStart = await manager.start({
      maxToolRounds: 4,
      parentCallId: "call_2",
      parentRound: 1,
      profile: "edit",
      runInBackground: true,
      task: "Draft docs.",
    });

    expect(firstStart.childSessionId).toBe("child-1");
    expect(secondStart.childSessionId).toBe("child-2");
    expect(manager.pendingCount()).toBe(2);

    second.resolve({
      changedFiles: ["docs/tutorial/c15b-async-child-sessions-parallel-handoff.md"],
      childSessionId: "child-2",
      finalAnswer: "Drafted docs.",
      profile: "edit",
      status: "completed",
      tracePath: "/repo/.forge/sessions/child-2/trace.jsonl",
      workspace: {
        branch: "forge/run/child-2",
        path: "/repo/.forge/worktrees/child-2",
      },
    });
    first.resolve({
      childSessionId: "child-1",
      finalAnswer: "Found the async boundary.",
      profile: "research",
      status: "completed",
      tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
    });
    await flushPromises();

    const notifications = manager.drainNotifications();

    expect(notifications.map((notification) => notification.childSessionId)).toEqual(["child-1", "child-2"]);
    expect(notifications[1]).toMatchObject({
      changedFiles: ["docs/tutorial/c15b-async-child-sessions-parallel-handoff.md"],
      childSessionId: "child-2",
      profile: "edit",
      status: "completed",
      workspace: {
        branch: "forge/run/child-2",
        path: "/repo/.forge/worktrees/child-2",
      },
    });
    expect(manager.drainNotifications()).toEqual([]);
    expect(manager.pendingCount()).toBe(0);
    expect(formatChildSessionNotification(notifications[1]!)).toContain("workspace_branch: forge/run/child-2");
    expect(formatChildSessionNotification(notifications[1]!)).toContain("changed_files:");
  });

  it("formats running notifications without consuming terminal notifications", async () => {
    const deferred = createDeferred<ChildSessionRunResult>();
    const manager = createAsyncChildSessionManager({
      runner: {
        run: vi.fn(),
        start: vi.fn().mockReturnValue({
          childSessionId: "child-1",
          profile: "research",
          promise: deferred.promise,
          status: "running",
          tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        }),
      },
    });

    await manager.start({
      maxToolRounds: 4,
      parentCallId: "call_1",
      parentRound: 1,
      profile: "research",
      runInBackground: true,
      task: "Inspect docs.",
    });

    expect(manager.runningNotifications()).toEqual([
      expect.objectContaining({
        childSessionId: "child-1",
        profile: "research",
        status: "running",
      }),
    ]);

    deferred.resolve({
      childSessionId: "child-1",
      finalAnswer: "Research complete.",
      profile: "research",
      status: "completed",
      tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
    });
    await flushPromises();

    expect(manager.drainNotifications()).toEqual([
      expect.objectContaining({
        childSessionId: "child-1",
        finalAnswer: "Research complete.",
        status: "completed",
      }),
    ]);
  });

  it("waits for child activity at the final gate and returns the terminal handoff", async () => {
    const deferred = createDeferred<ChildSessionRunResult>();
    const manager = createAsyncChildSessionManager({
      runner: {
        run: vi.fn(),
        start: vi.fn().mockReturnValue({
          childSessionId: "child-1",
          profile: "research",
          promise: deferred.promise,
          status: "running",
          tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        }),
      },
    });
    await manager.start({
      maxToolRounds: 4,
      parentCallId: "call_1",
      parentRound: 1,
      profile: "research",
      runInBackground: true,
      task: "Inspect docs.",
    });

    let settled = false;
    const finalGate = manager.settleBeforeFinal().then((notifications) => {
      settled = true;
      return notifications;
    });
    await flushPromises();
    expect(settled).toBe(false);

    deferred.resolve({
      childSessionId: "child-1",
      finalAnswer: "Research complete.",
      profile: "research",
      status: "completed",
      tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
    });

    await expect(finalGate).resolves.toEqual([
      expect.objectContaining({
        childSessionId: "child-1",
        finalAnswer: "Research complete.",
        status: "completed",
      }),
    ]);
    expect(manager.pendingCount()).toBe(0);
  });
});

async function execGit(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", args, { cwd });
}

async function createRootTaskFixture(options: { git?: boolean } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "forge-child-task-"));
  if (options.git) {
    await execGit(repo, ["init", "-b", "main"]);
    await execGit(repo, ["config", "user.email", "test@example.com"]);
    await execGit(repo, ["config", "user.name", "Test User"]);
    await fs.writeFile(path.join(repo, ".gitignore"), ".forge/sessions/\n", "utf8");
    await fs.writeFile(path.join(repo, "README.md"), "base\n", "utf8");
    await execGit(repo, ["add", ".gitignore", "README.md"]);
    await execGit(repo, ["commit", "-m", "base"]);
  }
  const session = await createCliSessionTrace({
    cwd: repo,
    maxToolRounds: 4,
    model: "gpt-5.4-mini",
    task: "Coordinate child work.",
  });
  const binding = session.metadata.taskGraph;
  if (!binding) {
    throw new Error("root session did not expose a task graph binding");
  }
  const store = createFileTeamTaskStore({ graphPath: binding.taskGraphPath });
  const leader = { role: "leader", sessionId: session.metadata.id } as const;
  await store.create(leader, {
    acceptance: ["The child reports findings"],
    description: "Investigate the child runtime integration.",
    kind: "research",
    title: "Investigate child integration",
  });
  await store.transition(leader, {
    action: "assign",
    assignee: { role: "leader" },
    id: "task_001",
  });
  return { binding, repo, session, store };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
