import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";
import {
  createDelegateTool,
  delegateToolDefinition,
  type ChildSessionRunRequest,
} from "../../src/tools/delegateTool.js";

describe("delegate tool", () => {
  it("declares a nullable taskId link without changing the existing delegation fields", () => {
    expect(delegateToolDefinition).toMatchObject({
      name: "delegate",
      parameters: {
        additionalProperties: false,
        properties: {
          taskId: {
            type: ["string", "null"],
          },
        },
        required: ["task", "profile", "taskId", "maxToolRounds", "runInBackground"],
        type: "object",
      },
      strict: true,
    });
  });

  it("rejects missing and non-in-progress task links without starting a child or mutating the graph", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    const leader = { role: "leader", sessionId: "root-session" } as const;
    await store.initialize();
    await store.create(leader, {
      acceptance: ["The child reports findings"],
      description: "Investigate the integration boundary.",
      kind: "research",
      title: "Investigate integration",
    });
    const before = await store.read();
    const requests: ChildSessionRunRequest[] = [];
    const tool = createDelegateTool({
      maxToolRounds: 8,
      runner: capturingRunner(requests),
      taskStore: store,
    });

    const missing = await tool.handler({
      callId: "call_missing",
      rawArguments: JSON.stringify({
        maxToolRounds: null,
        profile: "research",
        runInBackground: false,
        task: "Inspect the missing task.",
        taskId: "task_999",
      }),
      round: 2,
    });
    const pending = await tool.handler({
      callId: "call_pending",
      rawArguments: JSON.stringify({
        maxToolRounds: null,
        profile: "research",
        runInBackground: false,
        task: "Inspect the pending task.",
        taskId: "task_001",
      }),
      round: 2,
    });

    expect(missing).toMatchObject({
      status: "failed",
      toolName: "delegate",
    });
    expect(missing.content).toContain("task_999");
    expect(pending).toMatchObject({
      status: "failed",
      toolName: "delegate",
    });
    expect(pending.content).toContain("in_progress");
    expect(pending.content).toContain('action="assign"');
    expect(pending.content).toContain('assignee="leader"');
    expect(requests).toEqual([]);
    expect(await store.read()).toEqual(before);
  });

  it("propagates an in-progress task link without changing task status or evidence", async () => {
    const graphPath = await createGraphPath();
    const store = createFileTeamTaskStore({ graphPath });
    const leader = { role: "leader", sessionId: "root-session" } as const;
    await store.initialize();
    await store.create(leader, {
      acceptance: ["The child reports findings"],
      description: "Investigate the integration boundary.",
      kind: "research",
      title: "Investigate integration",
    });
    await store.transition(leader, {
      action: "assign",
      assignee: { role: "leader" },
      id: "task_001",
    });
    const before = await store.read();
    const requests: ChildSessionRunRequest[] = [];
    const tool = createDelegateTool({
      maxToolRounds: 8,
      runner: capturingRunner(requests),
      taskStore: store,
    });

    const result = await tool.handler({
      callId: "call_linked",
      rawArguments: JSON.stringify({
        maxToolRounds: 4,
        profile: "research",
        runInBackground: false,
        task: "Inspect the active task.",
        taskId: "task_001",
      }),
      round: 2,
    });
    const secondResult = await tool.handler({
      callId: "call_linked_again",
      rawArguments: JSON.stringify({
        maxToolRounds: 3,
        profile: "research",
        runInBackground: true,
        task: "Inspect the same active task independently.",
        taskId: "task_001",
      }),
      round: 3,
    });

    expect(result).toMatchObject({
      status: "completed",
      toolName: "delegate",
    });
    expect(secondResult).toMatchObject({
      status: "completed",
      toolName: "delegate",
    });
    expect(requests).toEqual([
      {
        maxToolRounds: 4,
        parentCallId: "call_linked",
        parentRound: 2,
        profile: "research",
        runInBackground: false,
        task: "Inspect the active task.",
        taskId: "task_001",
      },
      {
        maxToolRounds: 3,
        parentCallId: "call_linked_again",
        parentRound: 3,
        profile: "research",
        runInBackground: true,
        task: "Inspect the same active task independently.",
        taskId: "task_001",
      },
    ]);
    expect(await store.read()).toEqual(before);
  });

  it("requires a task and explicit known profile", async () => {
    const runner = {
      start: vi.fn(),
      run: vi.fn(),
    };
    const tool = createDelegateTool({
      maxToolRounds: 8,
      parentCallId: () => "call_delegate",
      parentRound: () => 2,
      runner,
    });

    await expect(tool.handler({ rawArguments: JSON.stringify({ profile: "research" }) })).resolves.toMatchObject({
      status: "failed",
      toolName: "delegate",
    });
    await expect(tool.handler({ rawArguments: JSON.stringify({ profile: "audit", task: "Inspect docs." }) })).resolves.toMatchObject({
      status: "failed",
      toolName: "delegate",
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("passes validated delegate requests to the child session runner", async () => {
    const runner = {
      start: vi.fn(),
      run: vi.fn().mockResolvedValue({
        childSessionId: "child-1",
        finalAnswer: "Found the relevant docs.",
        profile: "research",
        status: "completed",
        tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
      }),
    };
    const tool = createDelegateTool({
      maxToolRounds: 8,
      parentCallId: () => "call_delegate",
      parentRound: () => 2,
      runner,
    });

    const result = await tool.handler({
      rawArguments: JSON.stringify({
        maxToolRounds: 4,
        profile: "research",
        task: "Inspect the c14 tutorial.",
      }),
    });

    expect(runner.run).toHaveBeenCalledWith({
      maxToolRounds: 4,
      parentCallId: "call_delegate",
      parentRound: 2,
      profile: "research",
      runInBackground: false,
      task: "Inspect the c14 tutorial.",
    });
    expect(result).toMatchObject({
      status: "completed",
      toolName: "delegate",
    });
    expect(result.content).toContain("child_session_id: child-1");
    expect(result.content).toContain("profile: research");
    expect(result.content).toContain("trace_path: /repo/.forge/sessions/child-1/trace.jsonl");
    expect(result.content).toContain("handoff:");
    expect(result.content).toContain("Found the relevant docs.");
  });

  it("starts an async child session when runInBackground is true", async () => {
    const runner = {
      run: vi.fn(),
      start: vi.fn().mockReturnValue({
        childSessionId: "child-async-1",
        profile: "edit",
        promise: Promise.resolve({
          changedFiles: ["docs/tutorial/c15b-async-child-sessions-parallel-handoff.md"],
          childSessionId: "child-async-1",
          finalAnswer: "Updated the tutorial draft.",
          profile: "edit",
          status: "completed",
          tracePath: "/repo/.forge/sessions/child-async-1/trace.jsonl",
          workspace: {
            branch: "forge/run/child-async-1",
            path: "/repo/.forge/worktrees/child-async-1",
          },
        }),
        status: "running",
        tracePath: "/repo/.forge/sessions/child-async-1/trace.jsonl",
      }),
    };
    const tool = createDelegateTool({
      maxToolRounds: 8,
      parentCallId: () => "call_delegate",
      parentRound: () => 2,
      runner,
    });

    const result = await tool.handler({
      rawArguments: JSON.stringify({
        maxToolRounds: null,
        profile: "edit",
        runInBackground: true,
        task: "Draft c15b tutorial text.",
      }),
    });

    expect(runner.start).toHaveBeenCalledWith({
      maxToolRounds: 8,
      parentCallId: "call_delegate",
      parentRound: 2,
      profile: "edit",
      runInBackground: true,
      task: "Draft c15b tutorial text.",
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "completed",
      toolName: "delegate",
    });
    expect(result.content).toContain("child_session_id: child-async-1");
    expect(result.content).toContain("profile: edit");
    expect(result.content).toContain("status: running");
    expect(result.content).toContain("trace_path: /repo/.forge/sessions/child-async-1/trace.jsonl");
  });

  it("defaults runInBackground null or omitted to synchronous delegation", async () => {
    const runner = {
      start: vi.fn(),
      run: vi.fn().mockResolvedValue({
        childSessionId: "child-1",
        finalAnswer: "Found the relevant docs.",
        profile: "research",
        status: "completed",
        tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
      }),
    };
    const tool = createDelegateTool({
      maxToolRounds: 8,
      parentCallId: () => "call_delegate",
      parentRound: () => 2,
      runner,
    });

    await tool.handler({
      rawArguments: JSON.stringify({
        maxToolRounds: null,
        profile: "research",
        runInBackground: null,
        task: "Inspect the c14 tutorial.",
      }),
    });
    await tool.handler({
      rawArguments: JSON.stringify({
        profile: "research",
        task: "Inspect the c14 tutorial again.",
      }),
    });

    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("rejects maxToolRounds outside the parent cap", async () => {
    const runner = {
      start: vi.fn(),
      run: vi.fn(),
    };
    const tool = createDelegateTool({
      maxToolRounds: 3,
      parentCallId: () => "call_delegate",
      parentRound: () => 2,
      runner,
    });

    await expect(
      tool.handler({
        rawArguments: JSON.stringify({
          maxToolRounds: 4,
          profile: "research",
          task: "Inspect docs.",
        }),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      toolName: "delegate",
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
});

async function createGraphPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-delegate-task-"));
  return path.join(directory, "task-graph.json");
}

function capturingRunner(requests: ChildSessionRunRequest[]) {
  return {
    async run(request: ChildSessionRunRequest) {
      requests.push(request);
      return {
        childSessionId: "child-linked",
        finalAnswer: "Found the relevant integration boundary.",
        profile: request.profile,
        status: "completed" as const,
        tracePath: "/repo/.forge/sessions/child-linked/trace.jsonl",
      };
    },
    async start(request: ChildSessionRunRequest) {
      requests.push(request);
      return {
        childSessionId: "child-linked",
        profile: request.profile,
        promise: Promise.resolve({
          childSessionId: "child-linked",
          finalAnswer: "Found the relevant integration boundary.",
          profile: request.profile,
          status: "completed" as const,
          tracePath: "/repo/.forge/sessions/child-linked/trace.jsonl",
        }),
        status: "running" as const,
        tracePath: "/repo/.forge/sessions/child-linked/trace.jsonl",
      };
    },
  };
}
