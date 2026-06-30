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
