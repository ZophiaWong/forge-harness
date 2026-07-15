import { describe, expect, it, vi } from "vitest";

import { createDelegateTool } from "../../src/tools/delegateTool.js";

describe("delegate tool", () => {
  it("requires a task and explicit known profile", async () => {
    const runner = {
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

  it("rejects maxToolRounds outside the parent cap", async () => {
    const runner = {
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
