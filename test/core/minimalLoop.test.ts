import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAIResponseMock, OpenAIMock } = vi.hoisted(() => {
  const createOpenAIResponseMock = vi.fn();
  const OpenAIMock = vi.fn().mockImplementation(function OpenAIMockConstructor() {
    return {
      responses: {
        create: createOpenAIResponseMock,
      },
    };
  });

  return { createOpenAIResponseMock, OpenAIMock };
});

vi.mock("openai", () => ({
  default: OpenAIMock,
}));

import { runMinimalLoop, type ResponseCreate } from "../../src/core/minimalLoop.js";
import type { PermissionApprover, PermissionDecision, PermissionPolicy } from "../../src/governance/types.js";
import { createRuntimeStateRecorder } from "../../src/runtime/state.js";
import type { TraceEventPayload, TraceRecorder } from "../../src/runtime/trace.js";
import type { VerificationResult, Verifier } from "../../src/runtime/verification.js";
import type { ToolRuntime } from "../../src/tools/types.js";

function createResponseCreate(...responses: Awaited<ReturnType<ResponseCreate>>[]): ResponseCreate {
  const calls: Parameters<ResponseCreate>[0][] = [];

  const responseCreate: ResponseCreate = async (request) => {
    calls.push(request);
    const response = responses.shift();

    if (!response) {
      throw new Error("unexpected model request");
    }

    return response;
  };

  Object.defineProperty(responseCreate, "calls", {
    value: calls,
  });

  return responseCreate;
}

function callsFor(responseCreate: ResponseCreate): Parameters<ResponseCreate>[0][] {
  return (responseCreate as ResponseCreate & { calls: Parameters<ResponseCreate>[0][] }).calls;
}

function allowPolicy(reason = "test allows action"): PermissionPolicy {
  return {
    decide: vi.fn((): PermissionDecision => ({ action: "allow", reason, risk: "inspect" })),
  };
}

function askPolicy(reason = "test asks before action"): PermissionPolicy {
  return {
    decide: vi.fn((): PermissionDecision => ({ action: "ask", reason, risk: "mutating" })),
  };
}

function denyPolicy(reason = "test denies action"): PermissionPolicy {
  return {
    decide: vi.fn((): PermissionDecision => ({ action: "deny", reason, risk: "destructive" })),
  };
}

function approver(approved: boolean, reason?: string): PermissionApprover {
  return {
    approve: vi.fn(async () => (reason ? { approved, reason } : { approved })),
  };
}

function createTraceRecorder(): { events: TraceEventPayload[]; recorder: TraceRecorder } {
  const events: TraceEventPayload[] = [];

  return {
    events,
    recorder: {
      record: vi.fn(async (event) => {
        events.push(event);
      }),
    },
  };
}

function verificationResult(overrides: Partial<VerificationResult>): VerificationResult {
  return {
    command: "npm run build",
    exitCode: 0,
    name: "command",
    recoverable: false,
    status: "passed",
    summary: "status: completed\ncommand: npm run build\nexit_code: 0",
    ...overrides,
  };
}

function verifierWithResults(...results: VerificationResult[]): Verifier {
  return {
    verify: vi.fn(async () => {
      const result = results.shift();

      if (!result) {
        throw new Error("unexpected verifier call");
      }

      return result;
    }),
  };
}

describe("runMinimalLoop", () => {
  beforeEach(() => {
    createOpenAIResponseMock.mockReset();
    OpenAIMock.mockClear();
  });

  it("appends function call output and continues until the model returns a final answer", async () => {
    const rawArguments = JSON.stringify({ command: "printf loop-ok" });
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: rawArguments,
            call_id: "call_1",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "done",
      },
    );

    const transcript = {
      finalAnswer: vi.fn(),
      roundStart: vi.fn(),
      toolCall: vi.fn(),
      toolResult: vi.fn(),
    };

    const result = await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      permissionPolicy: allowPolicy(),
      responseCreate,
      task: "inspect",
      transcript,
    });

    expect(result).toEqual({ finalAnswer: "done", rounds: 2 });
    expect(callsFor(responseCreate)).toHaveLength(2);
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_1",
        output: expect.stringContaining("observation: bash completed"),
        type: "function_call_output",
      }),
    );
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        output: expect.stringContaining("stdout:\nloop-ok"),
        type: "function_call_output",
      }),
    );
    expect(transcript.toolCall).toHaveBeenCalledWith(1, "bash", rawArguments);
    expect(transcript.finalAnswer).toHaveBeenCalledWith("done");
  });

  it("records hybrid trace events for a completed tool run", async () => {
    const rawArguments = JSON.stringify({ path: "package.json" });
    const trace = createTraceRecorder();
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async () => ({
        content: "path: package.json\n1 | {}",
        status: "completed" as const,
        toolName: "read",
      })),
      toolDefinitions: () => [
        {
          type: "function",
          name: "read",
          description: "Read a file.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: {
                type: "string",
              },
            },
            required: ["path"],
          },
        },
      ],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: rawArguments,
            call_id: "call_read",
            name: "read",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "done",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: "/workspace/forge-harness",
      model: "test-model",
      permissionPolicy: allowPolicy(),
      responseCreate,
      task: "inspect",
      toolRuntime,
      traceRecorder: trace.recorder,
    });

    expect(trace.events).toEqual([
      {
        cwd: "/workspace/forge-harness",
        maxToolRounds: 8,
        model: "test-model",
        task: "inspect",
        type: "session_started",
      },
      {
        inputItemCount: 1,
        model: "test-model",
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
        argumentsText: rawArguments,
        callId: "call_read",
        round: 1,
        toolName: "read",
        type: "tool_call",
      },
      {
        action: "allow",
        callId: "call_read",
        reason: "test allows action",
        risk: "inspect",
        round: 1,
        toolName: "read",
        type: "permission_decision",
      },
      {
        callId: "call_read",
        projectedOutput: "tool: read\nstatus: completed\nobservation: read completed\npath: package.json\n1 | {}",
        round: 1,
        status: "completed",
        toolName: "read",
        type: "tool_result",
      },
      {
        inputItemCount: 3,
        model: "test-model",
        round: 2,
        toolNames: ["read"],
        type: "model_request",
      },
      {
        functionCallCount: 0,
        outputText: "done",
        round: 2,
        type: "model_response",
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
  });

  it("reports runtime state after tool rounds and after final answer", async () => {
    const trace = createTraceRecorder();
    const statefulTrace = createRuntimeStateRecorder(trace.recorder);
    const transcript = {
      finalAnswer: vi.fn(),
      finalState: vi.fn(),
      roundStart: vi.fn(),
      roundState: vi.fn(),
      toolCall: vi.fn(),
      toolResult: vi.fn(),
    };
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async () => ({
        content: "path: package.json\n1 | {}",
        status: "completed" as const,
        toolName: "read",
      })),
      toolDefinitions: () => [],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({ path: "package.json" }),
            call_id: "call_read",
            name: "read",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "done",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: "/workspace/forge-harness",
      permissionPolicy: allowPolicy(),
      responseCreate,
      runtimeState: statefulTrace.getState,
      task: "inspect",
      toolRuntime,
      traceRecorder: statefulTrace.recorder,
      transcript,
    });

    expect(transcript.roundState).toHaveBeenCalledTimes(1);
    expect(transcript.roundState).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        lastToolResult: expect.objectContaining({
          status: "completed",
          toolName: "read",
        }),
        status: "running",
      }),
    );
    expect(transcript.finalState).toHaveBeenCalledWith(
      expect.objectContaining({
        finalAnswer: {
          answer: "done",
          round: 2,
        },
        rounds: 2,
        status: "completed",
      }),
    );
  });

  it("does not report a round state when the model answers without tool calls", async () => {
    const trace = createTraceRecorder();
    const statefulTrace = createRuntimeStateRecorder(trace.recorder);
    const transcript = {
      finalAnswer: vi.fn(),
      finalState: vi.fn(),
      roundStart: vi.fn(),
      roundState: vi.fn(),
      toolCall: vi.fn(),
      toolResult: vi.fn(),
    };
    const responseCreate = createResponseCreate({
      output: [],
      output_text: "done",
    });

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: "/workspace/forge-harness",
      responseCreate,
      runtimeState: statefulTrace.getState,
      task: "answer directly",
      traceRecorder: statefulTrace.recorder,
      transcript,
    });

    expect(transcript.roundState).not.toHaveBeenCalled();
    expect(transcript.finalState).toHaveBeenCalledWith(
      expect.objectContaining({
        rounds: 1,
        status: "completed",
      }),
    );
  });

  it("checks permission before executing an allowed tool call", async () => {
    const rawArguments = JSON.stringify({ command: "pwd" });
    const permissionPolicy = allowPolicy();
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async () => ({
        content: "stdout:\n/project",
        status: "completed" as const,
        toolName: "bash",
      })),
      toolDefinitions: () => [],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: rawArguments,
            call_id: "call_allow",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "done",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      permissionPolicy,
      responseCreate,
      task: "inspect",
      toolRuntime,
    });

    expect(permissionPolicy.decide).toHaveBeenCalledWith({
      arguments: rawArguments,
      name: "bash",
    });
    expect(toolRuntime.execute).toHaveBeenCalledWith({
      arguments: rawArguments,
      name: "bash",
    });
  });

  it("feeds denied permission decisions back without executing the tool", async () => {
    const trace = createTraceRecorder();
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(),
      toolDefinitions: () => [],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({ command: "rm -rf dist" }),
            call_id: "call_deny",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "reported denial",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      permissionPolicy: denyPolicy("destructive command is blocked"),
      responseCreate,
      task: "remove dist",
      toolRuntime,
      traceRecorder: trace.recorder,
    });

    expect(toolRuntime.execute).not.toHaveBeenCalled();
    expect(trace.events).toContainEqual({
      action: "deny",
      callId: "call_deny",
      reason: "destructive command is blocked",
      risk: "destructive",
      round: 1,
      toolName: "bash",
      type: "permission_decision",
    });
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        callId: "call_deny",
        projectedOutput: expect.stringContaining("permission_denied: true"),
        round: 1,
        status: "blocked",
        toolName: "bash",
        type: "tool_result",
      }),
    );
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_deny",
        output: expect.stringContaining("permission_denied: true"),
        type: "function_call_output",
      }),
    );
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        output: expect.stringContaining("decision: deny"),
      }),
    );
  });

  it("executes an ask decision when the approver accepts", async () => {
    const permissionApprover = approver(true);
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async () => ({
        content: "stdout:\ncreated",
        status: "completed" as const,
        toolName: "bash",
      })),
      toolDefinitions: () => [],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({ command: "touch approved.txt" }),
            call_id: "call_ask_yes",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "done",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      approver: permissionApprover,
      cwd: process.cwd(),
      permissionPolicy: askPolicy(),
      responseCreate,
      task: "create file",
      toolRuntime,
    });

    expect(permissionApprover.approve).toHaveBeenCalled();
    expect(toolRuntime.execute).toHaveBeenCalled();
  });

  it("feeds rejected ask decisions back without executing the tool", async () => {
    const permissionApprover = approver(false, "approval rejected by user");
    const trace = createTraceRecorder();
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(),
      toolDefinitions: () => [],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({ command: "touch rejected.txt" }),
            call_id: "call_ask_no",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "reported rejection",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      approver: permissionApprover,
      cwd: process.cwd(),
      permissionPolicy: askPolicy(),
      responseCreate,
      task: "create file",
      toolRuntime,
      traceRecorder: trace.recorder,
    });

    expect(toolRuntime.execute).not.toHaveBeenCalled();
    expect(trace.events).toContainEqual({
      approved: false,
      callId: "call_ask_no",
      reason: "approval rejected by user",
      round: 1,
      toolName: "bash",
      type: "approval_result",
    });
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_ask_no",
        output: expect.stringContaining("decision: ask"),
        type: "function_call_output",
      }),
    );
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        output: expect.stringContaining("reason: approval rejected by user"),
      }),
    );
  });

  it("routes function calls through the injected tool runtime", async () => {
    const toolRuntime: ToolRuntime = {
      toolDefinitions: () => [
        {
          type: "function",
          name: "read",
          description: "Read a file.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: {
                type: "string",
                description: "Path to read.",
              },
            },
            required: ["path"],
          },
        },
      ],
      execute: vi.fn(async () => ({
        content: "path: package.json\n1 | {}",
        status: "completed" as const,
        toolName: "read",
      })),
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({ path: "package.json" }),
            call_id: "call_read",
            name: "read",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "done",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      responseCreate,
      task: "inspect",
      toolRuntime,
    });

    expect(callsFor(responseCreate)[0]?.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(toolRuntime.execute).toHaveBeenCalledWith({
      arguments: JSON.stringify({ path: "package.json" }),
      name: "read",
    });
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_read",
        output: "tool: read\nstatus: completed\nobservation: read completed\npath: package.json\n1 | {}",
        type: "function_call_output",
      }),
    );
  });

  it("creates the OpenAI client with a configured baseURL", async () => {
    createOpenAIResponseMock.mockResolvedValueOnce({
      output: [],
      output_text: "done",
    });

    const result = await runMinimalLoop({
      apiKey: "test-key",
      baseURL: "https://gateway.example/v1",
      cwd: process.cwd(),
      task: "answer directly",
    });

    expect(result).toEqual({ finalAnswer: "done", rounds: 1 });
    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: "test-key",
      baseURL: "https://gateway.example/v1",
    });
  });

  it("treats an empty baseURL as the default OpenAI endpoint", async () => {
    createOpenAIResponseMock.mockResolvedValueOnce({
      output: [],
      output_text: "done",
    });

    await runMinimalLoop({
      apiKey: "test-key",
      baseURL: "",
      cwd: process.cwd(),
      task: "answer directly",
    });

    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: "test-key",
    });
  });

  it("reads OPENAI_BASE_URL from the environment", async () => {
    const previousBaseURL = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "https://env-gateway.example/v1";
    createOpenAIResponseMock.mockResolvedValueOnce({
      output: [],
      output_text: "done",
    });

    try {
      await runMinimalLoop({
        apiKey: "test-key",
        cwd: process.cwd(),
        task: "answer directly",
      });
    } finally {
      if (previousBaseURL === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = previousBaseURL;
      }
    }

    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: "test-key",
      baseURL: "https://env-gateway.example/v1",
    });
  });

  it("stops immediately when the model returns no tool calls", async () => {
    const responseCreate = createResponseCreate({
      output: [],
      output_text: "final response\n",
    });

    const result = await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      responseCreate,
      task: "answer directly",
    });

    expect(result).toEqual({ finalAnswer: "final response", rounds: 1 });
    expect(callsFor(responseCreate)).toHaveLength(1);
  });

  it("verifies a candidate answer before recording the final answer", async () => {
    const trace = createTraceRecorder();
    const verifier = verifierWithResults(verificationResult({}));
    const transcript = {
      finalAnswer: vi.fn(),
      roundStart: vi.fn(),
      toolCall: vi.fn(),
      toolResult: vi.fn(),
      verificationResult: vi.fn(),
    };
    const responseCreate = createResponseCreate({
      output: [],
      output_text: "done",
    });

    const result = await runMinimalLoop({
      apiKey: "test-key",
      cwd: "/workspace/forge-harness",
      responseCreate,
      task: "answer directly",
      traceRecorder: trace.recorder,
      transcript,
      verifier,
    });

    expect(result).toEqual({ finalAnswer: "done", rounds: 1 });
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateAnswer: "done",
        cwd: "/workspace/forge-harness",
        round: 1,
        task: "answer directly",
      }),
    );
    expect(transcript.verificationResult).toHaveBeenCalledWith(1, verificationResult({}));
    expect(transcript.finalAnswer).toHaveBeenCalledWith("done");
    expect(trace.events.map((event) => event.type)).toEqual([
      "session_started",
      "model_request",
      "model_response",
      "candidate_answer",
      "verification_result",
      "final_answer",
      "session_ended",
    ]);
  });

  it("feeds a recoverable verification failure back into the next model round", async () => {
    const trace = createTraceRecorder();
    const failed = verificationResult({
      exitCode: 1,
      recoverable: true,
      status: "failed",
      summary: "status: completed\ncommand: npm run build\nexit_code: 1\nstderr:\ncompile failed",
    });
    const passed = verificationResult({});
    const verifier = verifierWithResults(failed, passed);
    const transcript = {
      finalAnswer: vi.fn(),
      recoveryAttempt: vi.fn(),
      roundStart: vi.fn(),
      toolCall: vi.fn(),
      toolResult: vi.fn(),
      verificationResult: vi.fn(),
    };
    const responseCreate = createResponseCreate(
      {
        output: [],
        output_text: "first answer",
      },
      {
        output: [],
        output_text: "fixed answer",
      },
    );

    const result = await runMinimalLoop({
      apiKey: "test-key",
      cwd: "/workspace/forge-harness",
      responseCreate,
      task: "fix the build",
      traceRecorder: trace.recorder,
      transcript,
      verifier,
    });

    expect(result).toEqual({ finalAnswer: "fixed answer", rounds: 2 });
    expect(callsFor(responseCreate)).toHaveLength(2);
    expect(callsFor(responseCreate)[1]?.input).toContainEqual({
      role: "user",
      content: expect.stringContaining("Verification failed for the previous candidate answer."),
    });
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        content: expect.stringContaining("stderr:\ncompile failed"),
      }),
    );
    expect(transcript.recoveryAttempt).toHaveBeenCalledWith(1, 1, 1, failed.summary);
    expect(transcript.finalAnswer).toHaveBeenCalledWith("fixed answer");
    expect(trace.events).toContainEqual({
      attempt: 1,
      maxAttempts: 1,
      round: 1,
      summary: failed.summary,
      type: "recovery_attempt",
    });
  });

  it("fails after the recovery retry limit is exhausted", async () => {
    const trace = createTraceRecorder();
    const failed = verificationResult({
      exitCode: 1,
      recoverable: true,
      status: "failed",
      summary: "status: completed\ncommand: npm run build\nexit_code: 1",
    });
    const verifier = verifierWithResults(failed, failed);
    const responseCreate = createResponseCreate(
      {
        output: [],
        output_text: "first answer",
      },
      {
        output: [],
        output_text: "second answer",
      },
    );

    await expect(
      runMinimalLoop({
        apiKey: "test-key",
        cwd: "/workspace/forge-harness",
        responseCreate,
        task: "fix the build",
        traceRecorder: trace.recorder,
        verifier,
      }),
    ).rejects.toThrow("Verification failed after 1 recovery attempt.");

    expect(trace.events).toContainEqual({
      message: "Verification failed after 1 recovery attempt.",
      type: "session_failed",
    });
    expect(trace.events).toContainEqual({
      rounds: 2,
      status: "failed",
      type: "session_ended",
    });
  });

  it("fails immediately when verification is blocked", async () => {
    const trace = createTraceRecorder();
    const blocked = verificationResult({
      exitCode: null,
      recoverable: false,
      status: "blocked",
      summary: "status: blocked\ncommand: sudo whoami\nblocked_reason: sudo is blocked",
    });
    const verifier = verifierWithResults(blocked);
    const responseCreate = createResponseCreate({
      output: [],
      output_text: "done",
    });

    await expect(
      runMinimalLoop({
        apiKey: "test-key",
        cwd: "/workspace/forge-harness",
        responseCreate,
        task: "run blocked verification",
        traceRecorder: trace.recorder,
        verifier,
      }),
    ).rejects.toThrow("Verification blocked.");

    expect(trace.events).not.toContainEqual(expect.objectContaining({ type: "recovery_attempt" }));
    expect(trace.events).toContainEqual({
      message: "Verification blocked.",
      type: "session_failed",
    });
  });

  it("fails when tool calls exceed the configured round limit", async () => {
    const trace = createTraceRecorder();
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async () => ({
        content: "stdout:\nstill-running",
        status: "completed" as const,
        toolName: "bash",
      })),
      toolDefinitions: () => [],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({ command: "printf still-running" }),
            call_id: "call_again",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [
          {
            arguments: JSON.stringify({ command: "printf still-running" }),
            call_id: "call_again_2",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
    );

    await expect(
      runMinimalLoop({
        apiKey: "test-key",
        cwd: process.cwd(),
        maxToolRounds: 1,
        permissionPolicy: allowPolicy(),
        responseCreate,
        task: "keep going",
        toolRuntime,
        traceRecorder: trace.recorder,
      }),
    ).rejects.toThrow("Minimal loop stopped after 1 tool rounds without a final answer.");

    expect(trace.events).toContainEqual({
      message: "Minimal loop stopped after 1 tool rounds without a final answer.",
      type: "session_failed",
    });
    expect(trace.events).toContainEqual({
      rounds: 1,
      status: "failed",
      type: "session_ended",
    });
  });

  it("feeds blocked results back to the model for malformed tool arguments", async () => {
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: "{bad json",
            call_id: "call_bad",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "reported bad args",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      responseCreate,
      task: "inspect",
    });

    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_bad",
        output: expect.stringContaining("permission_denied: true"),
        type: "function_call_output",
      }),
    );
  });
});
