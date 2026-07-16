import { describe, expect, it, vi } from "vitest";

import { createDelegateTool } from "../../src/tools/delegateTool.js";

describe("delegate tool", () => {
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
