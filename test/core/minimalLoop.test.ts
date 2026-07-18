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
import type { PromptAssets } from "../../src/context/promptAssembly.js";
import type { ChildSessionRunner } from "../../src/extensions/childSessions.js";
import { createLifecycleEmitter } from "../../src/extensions/lifecycle.js";
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

describe("runMinimalLoop", () => {
  beforeEach(() => {
    createOpenAIResponseMock.mockReset();
    OpenAIMock.mockClear();
  });

  it("routes additional dynamic tools and closes them before session_ended", async () => {
    const order: string[] = [];
    const trace = createTraceRecorder();
    const recorder: TraceRecorder = {
      async record(event) {
        await trace.recorder.record(event);
        if (event.type === "session_ended") {
          order.push("session_ended");
        }
      },
    };
    const additionalRuntime: ToolRuntime = {
      close: vi.fn(async () => {
        order.push("runtime_close");
      }),
      execute: vi.fn(async (toolCall) => ({
        content: "issue_id: FH-16",
        status: "completed" as const,
        toolName: toolCall.name,
      })),
      toolDefinitions: () => [{
        description: "Look up a demo issue.",
        name: "mcp_demo_lookup_issue",
        parameters: { type: "object" },
        strict: false,
        type: "function",
      }],
    };
    const responseCreate = createResponseCreate(
      {
        output: [{
          arguments: '{"issueId":"FH-16"}',
          call_id: "call_mcp",
          name: "mcp_demo_lookup_issue",
          type: "function_call",
        }],
        output_text: "",
      },
      { output: [], output_text: "done" },
    );

    await runMinimalLoop({
      additionalToolRuntimes: [additionalRuntime],
      apiKey: "test-key",
      cwd: process.cwd(),
      lifecycleEmitter: createLifecycleEmitter({ recorder }),
      permissionPolicy: allowPolicy(),
      responseCreate,
      task: "look up FH-16",
      toolRuntime: {
        execute: vi.fn(async (toolCall) => ({
          content: "unused",
          status: "completed" as const,
          toolName: toolCall.name,
        })),
        toolDefinitions: () => [],
      },
    });

    expect(callsFor(responseCreate)[0]?.tools.map((tool) => tool.name)).toEqual(["mcp_demo_lookup_issue"]);
    expect(additionalRuntime.execute).toHaveBeenCalledWith(
      { arguments: '{"issueId":"FH-16"}', name: "mcp_demo_lookup_issue" },
      { callId: "call_mcp", round: 1 },
    );
    expect(additionalRuntime.close).toHaveBeenCalledOnce();
    expect(order).toEqual(["runtime_close", "session_ended"]);
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
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
    });

    expect(trace.events).toEqual([
      {
        cwd: "/workspace/forge-harness",
        maxToolRounds: 8,
        model: "test-model",
        task: "inspect",
        type: "session_started",
      },
      expect.objectContaining({
        catalogSkillIds: [],
        round: 1,
        sectionNames: ["base_instructions", "tool_rules"],
        selectedSkillIds: [],
        type: "prompt_assembled",
      }),
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
      expect.objectContaining({
        catalogSkillIds: [],
        round: 2,
        sectionNames: ["base_instructions", "tool_rules"],
        selectedSkillIds: [],
        type: "prompt_assembled",
      }),
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

  it("records workspace evidence before model work begins", async () => {
    const trace = createTraceRecorder();
    const responseCreate = createResponseCreate({
      output: [],
      output_text: "done",
    });

    await runMinimalLoop({
      apiKey: "test-key",
      baseCwd: "/workspace/forge-harness",
      cwd: "/workspace/forge-harness/.forge/worktrees/20260713-101500-a1b2c3d4",
      model: "test-model",
      responseCreate,
      task: "inspect",
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
      workspace: {
        baseBranch: "main",
        baseCommit: "9bd9d56d8c3fe94a72c1707a6f805fe87527ca23",
        branch: "forge/run/20260713-101500-a1b2c3d4",
        mode: "git_worktree",
        path: "/workspace/forge-harness/.forge/worktrees/20260713-101500-a1b2c3d4",
      },
    });

    expect(trace.events.slice(0, 2)).toEqual([
      {
        baseCwd: "/workspace/forge-harness",
        cwd: "/workspace/forge-harness/.forge/worktrees/20260713-101500-a1b2c3d4",
        maxToolRounds: 8,
        model: "test-model",
        task: "inspect",
        type: "session_started",
        workspace: {
          baseBranch: "main",
          baseCommit: "9bd9d56d8c3fe94a72c1707a6f805fe87527ca23",
          branch: "forge/run/20260713-101500-a1b2c3d4",
          mode: "git_worktree",
          path: "/workspace/forge-harness/.forge/worktrees/20260713-101500-a1b2c3d4",
        },
      },
      {
        baseBranch: "main",
        baseCommit: "9bd9d56d8c3fe94a72c1707a6f805fe87527ca23",
        baseCwd: "/workspace/forge-harness",
        branch: "forge/run/20260713-101500-a1b2c3d4",
        type: "workspace_created",
        workspacePath: "/workspace/forge-harness/.forge/worktrees/20260713-101500-a1b2c3d4",
      },
    ]);
  });

  it("emits task state updates from completed todo tool results and feeds the projected todo result back", async () => {
    const rawArguments = JSON.stringify({
      acceptance: ["npm run build exits with code 0"],
      items: [
        { id: "inspect", status: "completed", title: "Inspect the current failure" },
        { id: "patch", status: "in_progress", title: "Patch the source file" },
      ],
      summary: "Fix the build with a focused patch.",
    });
    const taskState = {
      acceptance: ["npm run build exits with code 0"],
      items: [
        { id: "inspect", status: "completed", title: "Inspect the current failure" },
        { id: "patch", status: "in_progress", title: "Patch the source file" },
      ],
      summary: "Fix the build with a focused patch.",
    };
    const trace = createTraceRecorder();
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async () => ({
        content: [
          "summary: Fix the build with a focused patch.",
          "todos:",
          "- completed inspect: Inspect the current failure",
          "- in_progress patch: Patch the source file",
          "acceptance:",
          "- npm run build exits with code 0",
        ].join("\n"),
        metadata: {
          observationSummary: "task plan updated: 2 items, 1 in_progress, 1 completed, 0 blocked",
          taskState,
        },
        status: "completed" as const,
        toolName: "todo",
      })),
      toolDefinitions: () => [
        {
          type: "function",
          name: "todo",
          description: "Update task state.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
      ],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: rawArguments,
            call_id: "call_todo",
            name: "todo",
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
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
      permissionPolicy: allowPolicy(),
      responseCreate,
      task: "fix the build",
      toolRuntime,
    });

    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_todo",
        output: expect.stringContaining("tool: todo\nstatus: completed\nobservation: task plan updated"),
        type: "function_call_output",
      }),
    );
    expect(trace.events).toContainEqual({
      callId: "call_todo",
      round: 1,
      taskState,
      type: "task_state_updated",
    });
    expect(trace.events.map((event) => event.type)).toEqual([
      "session_started",
      "prompt_assembled",
      "model_request",
      "model_response",
      "tool_call",
      "permission_decision",
      "tool_result",
      "task_state_updated",
      "prompt_assembled",
      "model_request",
      "model_response",
      "final_answer",
      "session_ended",
    ]);
  });

  it("emits prompt assembly evidence and sends a slash-stripped task to the model", async () => {
    const trace = createTraceRecorder();
    const promptAssets: PromptAssets = {
      projectMemory: "Memory marker.",
      skills: [
        {
          body: "Chapter handoff body.",
          description: "Use when planning chapter transitions.",
          id: "chapter-handoff",
        },
        {
          body: "Verification reporting body.",
          description: "Use when reporting verification.",
          id: "verification-reporting",
        },
      ],
    };
    const responseCreate = createResponseCreate({
      output: [],
      output_text: "done",
    });

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: "/workspace/forge-harness",
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
      promptAssets,
      responseCreate,
      task: "/chapter-handoff Discuss c11",
      toolRuntime: {
        execute: vi.fn(),
        toolDefinitions: () => [],
      },
    });

    expect(callsFor(responseCreate)[0]?.input).toEqual([
      {
        content: "Discuss c11",
        role: "user",
      },
    ]);
    expect(callsFor(responseCreate)[0]?.instructions).toContain("Memory marker.");
    expect(callsFor(responseCreate)[0]?.instructions).toContain("Chapter handoff body.");
    expect(callsFor(responseCreate)[0]?.instructions).not.toContain("Verification reporting body.");
    expect(trace.events.map((event) => event.type)).toEqual([
      "session_started",
      "prompt_assembled",
      "model_request",
      "model_response",
      "final_answer",
      "session_ended",
    ]);
    expect(trace.events).toContainEqual({
      catalogSkillIds: ["chapter-handoff", "verification-reporting"],
      instructionCharCount: callsFor(responseCreate)[0]?.instructions.length,
      round: 1,
      sectionNames: [
        "base_instructions",
        "tool_rules",
        "project_memory",
        "skill_catalog",
        "selected_skills",
      ],
      selectedSkillIds: ["chapter-handoff"],
      type: "prompt_assembled",
    });
  });

  it("auto-compacts older input history before the next model request", async () => {
    const trace = createTraceRecorder();
    const toolOutputs = ["round 1 output ".repeat(20), "round 2 output ".repeat(20), "round 3 output ".repeat(20)];
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async () => ({
        content: toolOutputs.shift() ?? "unexpected",
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
            properties: {},
            required: [],
          },
        },
      ],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({ path: "docs/tutorial/c09-hooks.md" }),
            call_id: "call_1",
            name: "read",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [
          {
            arguments: JSON.stringify({ path: "docs/tutorial/c10-task-todo.md" }),
            call_id: "call_2",
            name: "read",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [
          {
            arguments: JSON.stringify({ path: "docs/tutorial/c11-system-prompt-skills-memory.md" }),
            call_id: "call_3",
            name: "read",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: [
          "# Compacted Context",
          "",
          "## Task",
          "Read long chapters.",
          "",
          "## Progress",
          "Read c09.",
          "",
          "## Evidence",
          "round 1 output was summarized.",
          "",
          "## Open Questions",
          "None.",
          "",
          "## Next Step",
          "Continue with recent reads.",
        ].join("\n"),
      },
      {
        output: [],
        output_text: "done",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      contextCompaction: {
        hardCharBudget: 100_000,
        softCharBudget: 300,
      },
      cwd: "/workspace/forge-harness",
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
      permissionPolicy: allowPolicy(),
      responseCreate,
      task: "Read long chapters.",
      toolRuntime,
    });

    expect(callsFor(responseCreate)).toHaveLength(5);
    expect(callsFor(responseCreate)[3]).toEqual(
      expect.objectContaining({
        model: "gpt-5.4-mini",
        tools: [],
      }),
    );
    expect(callsFor(responseCreate)[3]?.instructions).toContain("You are compacting an agent session history.");
    expect(callsFor(responseCreate)[4]?.input).toContainEqual({
      content: expect.stringContaining("# Compacted Context"),
      role: "user",
    });
    expect(JSON.stringify(callsFor(responseCreate)[4]?.input)).not.toContain("call_1");
    expect(JSON.stringify(callsFor(responseCreate)[4]?.input)).not.toContain("docs/tutorial/c09-hooks.md");
    expect(JSON.stringify(callsFor(responseCreate)[4]?.input)).toContain("round 2 output");
    expect(JSON.stringify(callsFor(responseCreate)[4]?.input)).toContain("round 3 output");
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        missingHeadings: [],
        round: 4,
        summary: expect.stringContaining("# Compacted Context"),
        trigger: "auto",
        type: "context_compacted",
      }),
    );
    expect(trace.events.filter((event) => event.type === "model_request")).toHaveLength(4);
  });

  it("fails explicitly when reactive compaction still exceeds the hard budget", async () => {
    const trace = createTraceRecorder();
    const toolOutputs = ["round 1 small", "round 2 small", "round 3 huge ".repeat(200)];
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async () => ({
        content: toolOutputs.shift() ?? "unexpected",
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
            properties: {},
            required: [],
          },
        },
      ],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({ path: "docs/tutorial/c09-hooks.md" }),
            call_id: "call_1",
            name: "read",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [
          {
            arguments: JSON.stringify({ path: "docs/tutorial/c10-task-todo.md" }),
            call_id: "call_2",
            name: "read",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [
          {
            arguments: JSON.stringify({ path: "docs/tutorial/c11-system-prompt-skills-memory.md" }),
            call_id: "call_3",
            name: "read",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: [
          "# Compacted Context",
          "",
          "## Task",
          "Read long chapters.",
          "",
          "## Progress",
          "Recent output is still large.",
          "",
          "## Evidence",
          "The oldest round was summarized.",
          "",
          "## Open Questions",
          "None.",
          "",
          "## Next Step",
          "Stop because context is still too large.",
        ].join("\n"),
      },
    );

    await expect(
      runMinimalLoop({
        apiKey: "test-key",
        contextCompaction: {
          hardCharBudget: 700,
          softCharBudget: 10_000,
        },
        cwd: "/workspace/forge-harness",
        lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
        permissionPolicy: allowPolicy(),
        responseCreate,
        task: "Read long chapters.",
        toolRuntime,
      }),
    ).rejects.toThrow("Context compaction failed");

    expect(callsFor(responseCreate)).toHaveLength(4);
    expect(callsFor(responseCreate)[3]?.tools).toEqual([]);
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        trigger: "reactive",
        type: "context_compacted",
      }),
    );
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        hardCharBudget: 700,
        trigger: "reactive",
        type: "context_compaction_failed",
      }),
    );
    expect(trace.events.filter((event) => event.type === "model_request")).toHaveLength(3);
  });

  it("does not emit task state updates for failed todo tool results", async () => {
    const trace = createTraceRecorder();
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async () => ({
        content: "failed_reason: duplicate todo id \"inspect\"",
        metadata: {
          observationSummary: "todo failed",
        },
        status: "failed" as const,
        toolName: "todo",
      })),
      toolDefinitions: () => [],
    };
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({}),
            call_id: "call_todo",
            name: "todo",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "reported failure",
      },
    );

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: "/workspace/forge-harness",
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
      permissionPolicy: allowPolicy(),
      responseCreate,
      task: "fix the build",
      toolRuntime,
    });

    expect(trace.events.map((event) => event.type)).not.toContain("task_state_updated");
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_todo",
        output: expect.stringContaining("observation: todo failed"),
        type: "function_call_output",
      }),
    );
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
      lifecycleEmitter: createLifecycleEmitter({ recorder: statefulTrace.recorder }),
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
      lifecycleEmitter: createLifecycleEmitter({ recorder: statefulTrace.recorder }),
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
    }, {
      callId: "call_allow",
      round: 1,
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
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
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
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
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
    }, {
      callId: "call_read",
      round: 1,
    });
    expect(callsFor(responseCreate)[1]?.input).toContainEqual(
      expect.objectContaining({
        call_id: "call_read",
        output: "tool: read\nstatus: completed\nobservation: read completed\npath: package.json\n1 | {}",
        type: "function_call_output",
      }),
    );
  });

  it("injects completed background task notifications before the next model request", async () => {
    const trace = createTraceRecorder();
    const backgroundArguments = JSON.stringify({
      command: "sleep 0.05 && printf background-ok",
      runInBackground: true,
    });
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: backgroundArguments,
            call_id: "call_bg",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [
          {
            arguments: JSON.stringify({ command: "sleep 0.2 && printf foreground-wait" }),
            call_id: "call_wait",
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
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
      permissionPolicy: allowPolicy(),
      responseCreate,
      task: "run a background command",
    });

    const requestInputs = callsFor(responseCreate).map((call) => JSON.stringify(call.input));
    expect(requestInputs.slice(1).some((input) => input.includes("<task_notification>"))).toBe(true);
    expect(requestInputs.slice(1).some((input) => input.includes("background_task_id: bg_001"))).toBe(true);
    expect(requestInputs.slice(1).some((input) => input.includes("background-ok"))).toBe(true);
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        command: "sleep 0.05 && printf background-ok",
        kind: "bash",
        round: 1,
        taskId: "bg_001",
        type: "background_task_started",
      }),
    );
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        status: "completed",
        taskId: "bg_001",
        type: "background_task_notification",
      }),
    );
  });

  it("uses background notifications to gate candidate finals before verification", async () => {
    const trace = createTraceRecorder();
    const responseCreate = createResponseCreate(
      {
        output: [
          {
            arguments: JSON.stringify({
              command: "sleep 5 && printf late",
              runInBackground: true,
            }),
            call_id: "call_bg",
            name: "bash",
            type: "function_call",
          },
        ],
        output_text: "",
      },
      {
        output: [],
        output_text: "premature final",
      },
      {
        output: [],
        output_text: "final after warning",
      },
    );

    const result = await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
      maxToolRounds: 3,
      permissionPolicy: allowPolicy(),
      responseCreate,
      task: "run a background command",
    });

    expect(result).toEqual({ finalAnswer: "final after warning", rounds: 3 });
    expect(JSON.stringify(callsFor(responseCreate)[2]?.input)).toContain("<task_notification>");
    expect(JSON.stringify(callsFor(responseCreate)[2]?.input)).toContain("status: running");
    expect(trace.events).not.toContainEqual({
      answer: "premature final",
      round: 2,
      type: "candidate_answer",
    });

    const canceledIndex = trace.events.findIndex(
      (event) =>
        event.type === "background_task_finished" &&
        event.taskId === "bg_001" &&
        event.status === "canceled",
    );
    const sessionEndedIndex = trace.events.findIndex((event) => event.type === "session_ended");

    expect(canceledIndex).toBeGreaterThan(-1);
    expect(sessionEndedIndex).toBeGreaterThan(canceledIndex);
  });

  it("lets the parent continue after async delegation and gates final until child handoff returns", async () => {
    const trace = createTraceRecorder();
    const childResult = createDeferred<{
      childSessionId: string;
      finalAnswer: string;
      profile: "research";
      status: "completed";
      tracePath: string;
    }>();
    const childSessionRunner: ChildSessionRunner = {
      run: vi.fn(),
      start: vi.fn().mockResolvedValue({
        childSessionId: "child-async-1",
        profile: "research",
        promise: childResult.promise,
        status: "running",
        tracePath: "/repo/.forge/sessions/child-async-1/trace.jsonl",
      }),
    };
    const responseCreate: ResponseCreate = vi.fn(async (request) => {
      const callCount = (responseCreate as ReturnType<typeof vi.fn>).mock.calls.length;

      if (callCount === 1) {
        return {
          output: [
            {
              arguments: JSON.stringify({
                maxToolRounds: 3,
                profile: "research",
                runInBackground: true,
                task: "Inspect c15b async boundaries.",
              }),
              call_id: "call_delegate",
              name: "delegate",
              type: "function_call",
            },
          ],
          output_text: "",
        };
      }

      if (callCount === 2) {
        expect(JSON.stringify(request.input)).toContain("status: running");
        return {
          output: [
            {
              arguments: JSON.stringify({ path: "README.md" }),
              call_id: "call_read",
              name: "read",
              type: "function_call",
            },
          ],
          output_text: "",
        };
      }

      if (callCount === 3) {
        return {
          output: [],
          output_text: "premature final",
        };
      }

      if (callCount === 4) {
        expect(JSON.stringify(request.input)).toContain("<child_session_notification>");
        expect(JSON.stringify(request.input)).toContain("status: running");
        childResult.resolve({
          childSessionId: "child-async-1",
          finalAnswer: "Async research complete.",
          profile: "research",
          status: "completed",
          tracePath: "/repo/.forge/sessions/child-async-1/trace.jsonl",
        });
        await flushPromises();
        return {
          output: [],
          output_text: "second premature final",
        };
      }

      expect(JSON.stringify(request.input)).toContain("Async research complete.");
      return {
        output: [],
        output_text: "final after child handoff",
      };
    }) as unknown as ResponseCreate;

    const result = await runMinimalLoop({
      apiKey: "test-key",
      childSessionRunner,
      cwd: process.cwd(),
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
      maxToolRounds: 5,
      permissionPolicy: allowPolicy(),
      responseCreate,
      task: "use async delegation",
    });

    expect(result).toEqual({ finalAnswer: "final after child handoff", rounds: 5 });
    expect(childSessionRunner.start).toHaveBeenCalledWith({
      maxToolRounds: 3,
      parentCallId: "call_delegate",
      parentRound: 1,
      profile: "research",
      runInBackground: true,
      task: "Inspect c15b async boundaries.",
    });
    expect(trace.events).not.toContainEqual({
      answer: "premature final",
      round: 3,
      type: "final_answer",
    });
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        childSessionId: "child-async-1",
        profile: "research",
        status: "running",
        type: "child_session_notification",
      }),
    );
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        childSessionId: "child-async-1",
        profile: "research",
        status: "completed",
        type: "child_session_notification",
      }),
    );
  });

  it("does not add background support to an injected custom tool runtime", async () => {
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(),
      toolDefinitions: () => [
        {
          type: "function",
          name: "bash",
          description: "Custom bash without background support.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: {
                type: "string",
              },
            },
            required: ["command"],
          },
        },
      ],
    };
    const responseCreate = createResponseCreate({
      output: [],
      output_text: "done",
    });

    await runMinimalLoop({
      apiKey: "test-key",
      cwd: process.cwd(),
      responseCreate,
      task: "answer directly",
      toolRuntime,
    });

    expect(callsFor(responseCreate)[0]?.tools[0]?.parameters.properties).not.toHaveProperty("runInBackground");
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
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
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
      "prompt_assembled",
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
      lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
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
        lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
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
        lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
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
        lifecycleEmitter: createLifecycleEmitter({ recorder: trace.recorder }),
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
