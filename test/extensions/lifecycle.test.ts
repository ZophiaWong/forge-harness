import { describe, expect, it, vi } from "vitest";

import { createLifecycleEmitter, type LifecycleHook } from "../../src/extensions/lifecycle.js";
import type { TraceEventPayload, TraceRecorder } from "../../src/runtime/trace.js";

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

describe("createLifecycleEmitter", () => {
  it("records the original event before running matching hooks, then records hook results", async () => {
    const trace = createTraceRecorder();
    const observations: string[] = [];
    const hook: LifecycleHook = {
      name: "event-log",
      events: ["verification_result"],
      async handle(event) {
        observations.push(`${event.type}:recorded=${trace.events.length}`);
      },
    };
    const emitter = createLifecycleEmitter({
      hooks: [hook],
      recorder: trace.recorder,
    });

    await emitter.emit({
      command: "npm run build",
      exitCode: 0,
      name: "command",
      round: 1,
      status: "passed",
      summary: "status: completed\ncommand: npm run build\nexit_code: 0",
      type: "verification_result",
    });

    expect(observations).toEqual(["verification_result:recorded=1"]);
    expect(trace.events).toEqual([
      expect.objectContaining({
        status: "passed",
        type: "verification_result",
      }),
      {
        hookName: "event-log",
        round: 1,
        sourceEventType: "verification_result",
        status: "completed",
        type: "hook_result",
      },
    ]);
  });

  it("treats omitted hook events as all hookable lifecycle events and does not recurse on hook_result", async () => {
    const trace = createTraceRecorder();
    const handled: string[] = [];
    const emitter = createLifecycleEmitter({
      hooks: [
        {
          name: "all-events",
          async handle(event) {
            handled.push(event.type);
          },
        },
      ],
      recorder: trace.recorder,
    });

    await emitter.emit({
      cwd: "/workspace/forge-harness",
      maxToolRounds: 8,
      model: "gpt-5.4-mini",
      task: "inspect docs",
      type: "session_started",
    });

    expect(handled).toEqual(["session_started"]);
    expect(trace.events.map((event) => event.type)).toEqual(["session_started", "hook_result"]);
  });

  it("filters hooks by event type", async () => {
    const trace = createTraceRecorder();
    const handled: string[] = [];
    const emitter = createLifecycleEmitter({
      hooks: [
        {
          name: "verify-only",
          events: ["verification_result"],
          async handle(event) {
            handled.push(event.type);
          },
        },
      ],
      recorder: trace.recorder,
    });

    await emitter.emit({
      inputItemCount: 1,
      model: "gpt-5.4-mini",
      round: 1,
      toolNames: ["read"],
      type: "model_request",
    });
    await emitter.emit({
      command: "npm run build",
      exitCode: 0,
      name: "command",
      round: 1,
      status: "passed",
      summary: "status: completed\ncommand: npm run build\nexit_code: 0",
      type: "verification_result",
    });

    expect(handled).toEqual(["verification_result"]);
    expect(trace.events.map((event) => event.type)).toEqual([
      "model_request",
      "verification_result",
      "hook_result",
    ]);
  });

  it("makes MCP lifecycle events visible to hooks", async () => {
    const trace = createTraceRecorder();
    const handled: string[] = [];
    const emitter = createLifecycleEmitter({
      hooks: [{
        events: ["mcp_server_connected", "mcp_server_stopped"],
        handle(event) {
          handled.push(event.type);
        },
        name: "mcp-health-log",
      }],
      recorder: trace.recorder,
    });

    await emitter.emit({
      discoveredToolNames: ["lookup_issue"],
      exposedToolNames: ["mcp_demo_lookup_issue"],
      extraToolNames: [],
      incompatibleTools: [],
      missingToolNames: [],
      serverId: "demo",
      type: "mcp_server_connected",
    });
    await emitter.emit({
      reason: "session_end",
      serverId: "demo",
      type: "mcp_server_stopped",
    });

    expect(handled).toEqual(["mcp_server_connected", "mcp_server_stopped"]);
  });

  it("records failed hook results and continues with later hooks", async () => {
    const trace = createTraceRecorder();
    const handled: string[] = [];
    const emitter = createLifecycleEmitter({
      hooks: [
        {
          name: "broken",
          async handle() {
            throw new Error("hook exploded");
          },
        },
        {
          name: "later",
          async handle(event) {
            handled.push(event.type);
          },
        },
      ],
      recorder: trace.recorder,
    });

    await expect(
      emitter.emit({
        answer: "done",
        round: 2,
        type: "final_answer",
      }),
    ).resolves.toBeUndefined();

    expect(handled).toEqual(["final_answer"]);
    expect(trace.events).toEqual([
      {
        answer: "done",
        round: 2,
        type: "final_answer",
      },
      {
        error: "hook exploded",
        hookName: "broken",
        round: 2,
        sourceEventType: "final_answer",
        status: "failed",
        type: "hook_result",
      },
      {
        hookName: "later",
        round: 2,
        sourceEventType: "final_answer",
        status: "completed",
        type: "hook_result",
      },
    ]);
  });
});
