import { describe, expect, it, vi } from "vitest";

import {
  applyRuntimeStateEvent,
  createInitialRuntimeState,
  createRuntimeStateRecorder,
} from "../../src/runtime/state.js";
import type { TraceEventPayload, TraceRecorder } from "../../src/runtime/trace.js";

function applyEvents(events: TraceEventPayload[]) {
  return events.reduce(applyRuntimeStateEvent, createInitialRuntimeState());
}

describe("RuntimeState projection", () => {
  it("does not project MCP live health into generic runtime state", () => {
    const initial = createInitialRuntimeState();
    const state = applyEvents([
      {
        deniedToolNames: [],
        discoveredToolNames: ["lookup_issue"],
        exposedToolNames: ["mcp_demo_lookup_issue"],
        extraToolNames: [],
        incompatibleTools: [],
        missingToolNames: [],
        serverId: "demo",
        type: "mcp_server_connected",
      },
      {
        phase: "transport",
        reason: "closed",
        serverId: "demo",
        type: "mcp_server_failed",
      },
    ]);

    expect(state).toEqual(initial);
  });

  it("does not project plugin trust or startup health snapshots", () => {
    const initial = createInitialRuntimeState();
    const afterTrust = applyRuntimeStateEvent(initial, {
      approved: true,
      pluginName: "issue-workflow",
      reason: "approved",
      root: "/plugins/issue-workflow",
      type: "plugin_trust_decided",
      version: "0.1.0",
    });
    const afterActivation = applyRuntimeStateEvent(afterTrust, {
      components: {
        hooks: { active: [], declared: [], failed: [] },
        mcpServers: { active: [], declared: [], failed: [] },
        skills: {
          active: ["issue-workflow:triage"],
          declared: ["issue-workflow:triage"],
          failed: [],
        },
      },
      pluginName: "issue-workflow",
      status: "active",
      tools: {
        declared: [],
        denied: [],
        exposed: [],
        extra: [],
        incompatible: [],
        missing: [],
      },
      type: "plugin_activation_result",
      version: "0.1.0",
    });

    expect(afterTrust).toBe(initial);
    expect(afterActivation).toBe(initial);
  });

  it("projects session, model, tool, permission, approval, answer, and end events into a current snapshot", () => {
    const state = applyEvents([
      {
        cwd: "/workspace/forge-harness",
        maxToolRounds: 8,
        model: "gpt-5.4-mini",
        task: "inspect docs",
        type: "session_started",
      },
      {
        inputItemCount: 1,
        model: "gpt-5.4-mini",
        round: 1,
        toolNames: ["read"],
        type: "model_request",
      },
      {
        functionCallCount: 1,
        outputText: "",
        round: 1,
        type: "model_response",
      },
      {
        argumentsText: "{\"path\":\"README.md\"}",
        callId: "call_read",
        round: 1,
        toolName: "read",
        type: "tool_call",
      },
      {
        action: "ask",
        callId: "call_read",
        reason: "test asks",
        risk: "mutating",
        round: 1,
        toolName: "read",
        type: "permission_decision",
      },
      {
        approved: true,
        callId: "call_read",
        reason: "approved by test",
        round: 1,
        toolName: "read",
        type: "approval_result",
      },
      {
        callId: "call_read",
        projectedOutput: "tool: read\nstatus: completed\nobservation: read completed",
        round: 1,
        status: "completed",
        toolName: "read",
        type: "tool_result",
      },
      {
        answer: "done",
        round: 2,
        type: "final_answer",
      },
      {
        rounds: 2,
        status: "completed",
        type: "session_ended",
      },
    ]);

    expect(state).toEqual({
      currentRound: 2,
      cwd: "/workspace/forge-harness",
      ended: true,
      finalAnswer: {
        answer: "done",
        round: 2,
      },
      lastApprovalResult: {
        approved: true,
        callId: "call_read",
        reason: "approved by test",
        round: 1,
        toolName: "read",
      },
      lastModelRequest: {
        inputItemCount: 1,
        model: "gpt-5.4-mini",
        round: 1,
        toolNames: ["read"],
      },
      lastModelResponse: {
        functionCallCount: 1,
        outputText: "",
        round: 1,
      },
      lastPermissionDecision: {
        action: "ask",
        callId: "call_read",
        reason: "test asks",
        risk: "mutating",
        round: 1,
        toolName: "read",
      },
      lastToolCall: {
        argumentsText: "{\"path\":\"README.md\"}",
        callId: "call_read",
        round: 1,
        toolName: "read",
      },
      lastToolResult: {
        callId: "call_read",
        projectedOutput: "tool: read\nstatus: completed\nobservation: read completed",
        round: 1,
        status: "completed",
        toolName: "read",
      },
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      rounds: 2,
      status: "completed",
      task: "inspect docs",
    });
  });

  it("does not treat a blocked permission result as a runtime problem", () => {
    const state = applyEvents([
      {
        cwd: "/workspace/forge-harness",
        maxToolRounds: 8,
        model: "gpt-5.4-mini",
        task: "remove dist",
        type: "session_started",
      },
      {
        action: "deny",
        callId: "call_deny",
        reason: "destructive command is blocked",
        risk: "destructive",
        round: 1,
        toolName: "bash",
        type: "permission_decision",
      },
      {
        callId: "call_deny",
        projectedOutput: "permission_denied: true",
        round: 1,
        status: "blocked",
        toolName: "bash",
        type: "tool_result",
      },
    ]);

    expect(state.lastToolResult?.status).toBe("blocked");
    expect(state.lastPermissionDecision?.action).toBe("deny");
    expect(state.lastProblem).toBeUndefined();
  });

  it("projects workspace setup events into runtime state", () => {
    const workspaceState = applyEvents([
      {
        baseCwd: "/workspace/forge-harness",
        branch: "forge/run/20260713-101500-a1b2c3d4",
        baseBranch: "main",
        baseCommit: "9bd9d56d8c3fe94a72c1707a6f805fe87527ca23",
        type: "workspace_created",
        workspacePath: "/workspace/forge-harness/.forge/worktrees/20260713-101500-a1b2c3d4",
      },
    ]);

    expect(workspaceState.baseCwd).toBe("/workspace/forge-harness");
    expect(workspaceState.workspace).toEqual({
      baseBranch: "main",
      baseCommit: "9bd9d56d8c3fe94a72c1707a6f805fe87527ca23",
      branch: "forge/run/20260713-101500-a1b2c3d4",
      mode: "git_worktree",
      path: "/workspace/forge-harness/.forge/worktrees/20260713-101500-a1b2c3d4",
    });

    const failedState = applyRuntimeStateEvent(workspaceState, {
      baseCwd: "/workspace/forge-harness",
      branch: "forge/run/20260713-101500-a1b2c3d4",
      reason: "base repo must be clean before creating an isolated worktree",
      type: "workspace_setup_failed",
      workspacePath: "/workspace/forge-harness/.forge/worktrees/20260713-101500-a1b2c3d4",
    });

    expect(failedState.lastProblem).toEqual({
      branch: "forge/run/20260713-101500-a1b2c3d4",
      kind: "workspace_setup_failed",
      message: "base repo must be clean before creating an isolated worktree",
      workspacePath: "/workspace/forge-harness/.forge/worktrees/20260713-101500-a1b2c3d4",
    });
  });

  it("records tool failures and session failures as the current problem", () => {
    const failedToolState = applyEvents([
      {
        callId: "call_test",
        projectedOutput: "tool: bash\nstatus: failed\nstderr:\nfailed",
        round: 2,
        status: "failed",
        toolName: "bash",
        type: "tool_result",
      },
    ]);

    expect(failedToolState.lastProblem).toEqual({
      kind: "tool_result",
      message: "tool: bash\nstatus: failed\nstderr:\nfailed",
      round: 2,
      status: "failed",
      toolName: "bash",
    });

    const sessionFailedState = applyRuntimeStateEvent(failedToolState, {
      message: "Minimal loop stopped after 1 tool rounds without a final answer.",
      type: "session_failed",
    });

    expect(sessionFailedState.lastProblem).toEqual({
      kind: "session_failed",
      message: "Minimal loop stopped after 1 tool rounds without a final answer.",
    });
  });

  it("projects candidate answers, verification results, and recovery attempts", () => {
    const failedState = applyEvents([
      {
        answer: "first answer",
        round: 1,
        type: "candidate_answer",
      },
      {
        command: "npm run build",
        exitCode: 1,
        name: "command",
        round: 1,
        status: "failed",
        summary: "status: completed\ncommand: npm run build\nexit_code: 1",
        type: "verification_result",
      },
      {
        attempt: 1,
        maxAttempts: 1,
        round: 1,
        summary: "status: completed\ncommand: npm run build\nexit_code: 1",
        type: "recovery_attempt",
      },
    ]);

    expect(failedState.candidateAnswer).toEqual({
      answer: "first answer",
      round: 1,
    });
    expect(failedState.lastVerificationResult).toEqual({
      command: "npm run build",
      exitCode: 1,
      name: "command",
      round: 1,
      status: "failed",
      summary: "status: completed\ncommand: npm run build\nexit_code: 1",
    });
    expect(failedState.lastProblem).toEqual({
      kind: "verification_failed",
      round: 1,
      status: "failed",
      summary: "status: completed\ncommand: npm run build\nexit_code: 1",
    });
    expect(failedState.recoveryAttempts).toBe(1);

    const passedState = applyRuntimeStateEvent(failedState, {
      command: "npm run build",
      exitCode: 0,
      name: "command",
      round: 2,
      status: "passed",
      summary: "status: completed\ncommand: npm run build\nexit_code: 0",
      type: "verification_result",
    });

    expect(passedState.lastVerificationResult?.status).toBe("passed");
    expect(passedState.lastProblem).toBeUndefined();
  });

  it("projects task state updates into the current runtime state", () => {
    const taskState = {
      acceptance: ["npm run build exits with code 0"],
      items: [
        {
          id: "inspect",
          status: "completed" as const,
          title: "Inspect the current failure",
        },
        {
          id: "patch",
          status: "in_progress" as const,
          title: "Patch the source file",
        },
        {
          id: "verify",
          status: "pending" as const,
          title: "Run the build check",
        },
      ],
      summary: "Fix the build with a focused patch.",
    };
    const state = applyRuntimeStateEvent(createInitialRuntimeState(), {
      callId: "call_todo",
      round: 2,
      taskState,
      type: "task_state_updated",
    });

    expect(state.currentRound).toBe(2);
    expect(state.taskState).toEqual({
      ...taskState,
      updatedAtRound: 2,
      updatedByCallId: "call_todo",
    });
  });

  it("projects context compaction metadata without storing the summary body", () => {
    const state = applyEvents([
      {
        afterCharCount: 9_200,
        beforeCharCount: 25_200,
        compactedRoundCount: 2,
        keptRecentRoundCount: 2,
        missingHeadings: ["Evidence"],
        omittedSourceCharCount: 120,
        reason: "input chars 25200 exceeded soft budget 24000",
        round: 4,
        sourceItemCount: 6,
        sourceRoundCount: 2,
        summary: "# Compacted Context\n\n## Task\nKeep going.",
        summaryCharCount: 42,
        trigger: "auto",
        type: "context_compacted",
      },
      {
        afterCharCount: 18_000,
        beforeCharCount: 38_500,
        compactedRoundCount: 1,
        keptRecentRoundCount: 2,
        missingHeadings: [],
        omittedSourceCharCount: 0,
        reason: "input chars 38500 exceeded hard budget 36000 after appending tool output",
        round: 5,
        sourceItemCount: 4,
        sourceRoundCount: 1,
        summary: "# Compacted Context\n\n## Task\nContinue after reactive compact.",
        summaryCharCount: 64,
        trigger: "reactive",
        type: "context_compacted",
      },
    ]);

    expect(state.compactionCount).toBe(2);
    expect(state.lastCompaction).toEqual({
      afterCharCount: 18_000,
      beforeCharCount: 38_500,
      compactedRoundCount: 1,
      keptRecentRoundCount: 2,
      missingHeadings: [],
      reason: "input chars 38500 exceeded hard budget 36000 after appending tool output",
      round: 5,
      sourceItemCount: 4,
      sourceRoundCount: 1,
      summaryCharCount: 64,
      trigger: "reactive",
    });
    expect(JSON.stringify(state.lastCompaction)).not.toContain("Continue after reactive compact");
  });

  it("projects context compaction failures as the current runtime problem", () => {
    const state = applyEvents([
      {
        cwd: "/workspace/forge-harness",
        maxToolRounds: 8,
        model: "gpt-5.4-mini",
        task: "inspect docs",
        type: "session_started",
      },
      {
        afterCharCount: 37_500,
        beforeCharCount: 48_000,
        hardCharBudget: 36_000,
        reason: "reactive compaction still exceeded hard budget",
        round: 3,
        trigger: "reactive",
        type: "context_compaction_failed",
      },
    ]);

    expect(state.lastProblem).toEqual({
      afterCharCount: 37_500,
      beforeCharCount: 48_000,
      hardCharBudget: 36_000,
      kind: "context_compaction_failed",
      reason: "reactive compaction still exceeded hard budget",
      round: 3,
      trigger: "reactive",
    });
    expect(state.status).toBe("running");
  });

  it("ignores hook results in the current runtime state", () => {
    const baseState = applyEvents([
      {
        cwd: "/workspace/forge-harness",
        maxToolRounds: 8,
        model: "gpt-5.4-mini",
        task: "inspect docs",
        type: "session_started",
      },
      {
        answer: "done",
        round: 1,
        type: "final_answer",
      },
    ]);

    const state = applyRuntimeStateEvent(baseState, {
      error: "hook exploded",
      hookName: "event-log",
      round: 1,
      sourceEventType: "final_answer",
      status: "failed",
      type: "hook_result",
    });

    expect(state).toEqual(baseState);
  });

  it("projects only the latest child handoff and child counters", () => {
    const state = applyEvents([
      {
        childSessionId: "child-1",
        parentCallId: "call_1",
        profile: "research",
        round: 1,
        task: "Inspect docs.",
        tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        type: "child_session_started",
      },
      {
        childSessionId: "child-1",
        parentCallId: "call_1",
        profile: "research",
        round: 1,
        status: "completed",
        tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        type: "child_session_finished",
      },
      {
        childSessionId: "child-1",
        finalAnswer: "Research complete.",
        parentCallId: "call_1",
        profile: "research",
        round: 1,
        tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        type: "child_session_handoff",
      },
      {
        childSessionId: "child-2",
        parentCallId: "call_2",
        profile: "edit",
        round: 2,
        task: "Update docs.",
        tracePath: "/repo/.forge/sessions/child-2/trace.jsonl",
        type: "child_session_started",
      },
      {
        childSessionId: "child-2",
        parentCallId: "call_2",
        profile: "edit",
        reason: "worktree setup failed",
        round: 2,
        status: "failed",
        tracePath: "/repo/.forge/sessions/child-2/trace.jsonl",
        type: "child_session_finished",
      },
    ]);

    expect(state.childSessionCount).toBe(2);
    expect(state.childHandoffCount).toBe(1);
    expect(state.lastChildHandoff).toMatchObject({
      childSessionId: "child-1",
      finalAnswer: "Research complete.",
      parentCallId: "call_1",
      profile: "research",
    });
    expect(state.lastProblem).toEqual({
      childSessionId: "child-2",
      kind: "child_session_failed",
      message: "worktree setup failed",
      profile: "edit",
      round: 2,
    });
  });

  it("projects pending async child sessions without keeping a full child index", () => {
    const state = applyEvents([
      {
        childSessionId: "child-1",
        parentCallId: "call_1",
        profile: "research",
        round: 1,
        runInBackground: true,
        task: "Inspect docs.",
        tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        type: "child_session_started",
      },
      {
        childSessionId: "child-2",
        parentCallId: "call_2",
        profile: "edit",
        round: 1,
        runInBackground: true,
        task: "Draft docs.",
        tracePath: "/repo/.forge/sessions/child-2/trace.jsonl",
        type: "child_session_started",
      },
      {
        childSessionId: "child-1",
        parentCallId: "call_1",
        profile: "research",
        round: 2,
        runInBackground: true,
        status: "completed",
        tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        type: "child_session_finished",
      },
      {
        childSessionId: "child-1",
        finalAnswer: "Research complete.",
        parentCallId: "call_1",
        profile: "research",
        round: 2,
        tracePath: "/repo/.forge/sessions/child-1/trace.jsonl",
        type: "child_session_handoff",
      },
    ]);

    expect(state.childSessionCount).toBe(2);
    expect(state.asyncChildPendingCount).toBe(1);
    expect(state.childHandoffCount).toBe(1);
    expect(state.lastChildHandoff?.childSessionId).toBe("child-1");
    expect("childSessions" in state).toBe(false);
  });
});

describe("createRuntimeStateRecorder", () => {
  it("updates state before forwarding each event to the delegate recorder", async () => {
    const forwardedEvents: TraceEventPayload[] = [];
    let getState = () => createInitialRuntimeState();
    const snapshots: unknown[] = [];
    const delegate: TraceRecorder = {
      record: vi.fn(async (event) => {
        snapshots.push(getState());
        forwardedEvents.push(event);
      }),
    };
    const stateful = createRuntimeStateRecorder(delegate);
    getState = stateful.getState;

    await stateful.recorder.record({
      cwd: "/workspace/forge-harness",
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      task: "inspect docs",
      type: "session_started",
    });
    await stateful.recorder.record({
      answer: "done",
      round: 1,
      type: "final_answer",
    });

    expect(forwardedEvents.map((event) => event.type)).toEqual(["session_started", "final_answer"]);
    expect(snapshots).toEqual([
      expect.objectContaining({
        status: "running",
        task: "inspect docs",
      }),
      expect.objectContaining({
        finalAnswer: {
          answer: "done",
          round: 1,
        },
      }),
    ]);
    expect(stateful.getState()).toEqual(
      expect.objectContaining({
        finalAnswer: {
          answer: "done",
          round: 1,
        },
        status: "running",
      }),
    );
  });
});
