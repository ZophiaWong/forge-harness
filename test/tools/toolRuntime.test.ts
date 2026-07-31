import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";
import { createDefaultToolRuntime } from "../../src/tools/defaultRuntime.js";
import { createToolRuntime } from "../../src/tools/runtime.js";
import type { ToolDefinition, ToolHandler } from "../../src/tools/types.js";

const echoDefinition: ToolDefinition = {
  type: "function",
  name: "echo",
  description: "Echo text for tests.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        description: "Text to echo.",
      },
    },
    required: ["text"],
  },
};

describe("createToolRuntime", () => {
  it("dispatches a registered tool and returns its result", async () => {
    const handler: ToolHandler = async ({ rawArguments }) => ({
      content: `raw=${rawArguments}`,
      status: "completed",
      toolName: "echo",
    });

    const runtime = createToolRuntime([
      {
        definition: echoDefinition,
        handler,
      },
    ]);

    expect(runtime.toolDefinitions()).toEqual([echoDefinition]);
    await expect(runtime.execute({ arguments: '{"text":"hi"}', name: "echo" })).resolves.toEqual({
      content: 'raw={"text":"hi"}',
      status: "completed",
      toolName: "echo",
    });
  });

  it("returns a blocked result for unknown tools", async () => {
    const runtime = createToolRuntime([]);

    await expect(runtime.execute({ arguments: "{}", name: "missing" })).resolves.toEqual({
      content: 'blocked_reason: unknown tool "missing"',
      status: "blocked",
      toolName: "missing",
    });
  });
});

describe("createDefaultToolRuntime", () => {
  it("exposes bash, read, ls, grep, find, edit, write, and todo as built-in tool definitions", () => {
    const runtime = createDefaultToolRuntime({ cwd: process.cwd() });

    expect(runtime.toolDefinitions().map((tool) => tool.name)).toEqual([
      "bash",
      "read",
      "ls",
      "grep",
      "find",
      "edit",
      "write",
      "todo",
    ]);
  });

  it("exposes delegate only when a child session runner is provided", () => {
    const withoutRunner = createDefaultToolRuntime({ cwd: process.cwd() });
    const withRunner = createDefaultToolRuntime({
      childSessionRunner: {
        run: async () => ({
          childSessionId: "child",
          finalAnswer: "done",
          profile: "research",
          status: "completed",
          tracePath: "trace.jsonl",
        }),
        start: async () => ({
          childSessionId: "child",
          profile: "research",
          promise: Promise.resolve({
            childSessionId: "child",
            finalAnswer: "done",
            profile: "research",
            status: "completed",
            tracePath: "trace.jsonl",
          }),
          status: "running",
          tracePath: "trace.jsonl",
        }),
      },
      cwd: process.cwd(),
      maxToolRounds: 8,
      parentCallId: () => "call_delegate",
      parentRound: () => 1,
    });

    expect(withoutRunner.toolDefinitions().map((tool) => tool.name)).not.toContain("delegate");
    expect(withRunner.toolDefinitions().map((tool) => tool.name)).toContain("delegate");
  });

  it("adds the Leader task runtime and validates linked delegation through the same store", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-default-task-runtime-"));
    const store = createFileTeamTaskStore({
      graphPath: path.join(directory, "task-graph.json"),
    });
    const actor = { role: "leader", sessionId: "root-session" } as const;
    await store.initialize();
    await store.create(actor, {
      acceptance: ["The child handoff is reviewed"],
      description: "Coordinate one child investigation.",
      title: "Coordinate child",
    });
    const childRequests: unknown[] = [];
    const runtime = createDefaultToolRuntime({
      childSessionRunner: {
        async run(request) {
          childRequests.push(request);
          return {
            childSessionId: "child",
            finalAnswer: "done",
            profile: request.profile,
            status: "completed",
            tracePath: "trace.jsonl",
          };
        },
        async start(request) {
          childRequests.push(request);
          return {
            childSessionId: "child",
            profile: request.profile,
            promise: Promise.resolve({
              childSessionId: "child",
              finalAnswer: "done",
              profile: request.profile,
              status: "completed",
              tracePath: "trace.jsonl",
            }),
            status: "running",
            tracePath: "trace.jsonl",
          };
        },
      },
      cwd: process.cwd(),
      maxToolRounds: 8,
      teamTasks: { actor, store },
    });

    expect(runtime.toolDefinitions().map((tool) => tool.name)).toEqual([
      "bash",
      "read",
      "ls",
      "grep",
      "find",
      "edit",
      "write",
      "todo",
      "task_list",
      "task_get",
      "task_create",
      "task_update",
      "task_add_evidence",
      "delegate",
    ]);
    await expect(
      runtime.execute(
        {
          arguments: JSON.stringify({
            maxToolRounds: null,
            profile: "research",
            runInBackground: false,
            task: "Inspect the pending task.",
            taskId: "task_001",
          }),
          name: "delegate",
        },
        { callId: "call_delegate", round: 1 },
      ),
    ).resolves.toMatchObject({ status: "failed" });
    expect(childRequests).toEqual([]);
  });

  it("keeps ls non-strict because its path argument is optional", () => {
    const runtime = createDefaultToolRuntime({ cwd: process.cwd() });
    const lsDefinition = runtime.toolDefinitions().find((tool) => tool.name === "ls");

    expect(lsDefinition?.strict).toBe(false);
    expect(lsDefinition?.parameters.required).toEqual([]);
  });

  it("reads UTF-8 text files with line numbers", async () => {
    const runtime = createDefaultToolRuntime({ cwd: process.cwd() });

    const result = await runtime.execute({
      arguments: JSON.stringify({ path: "package.json" }),
      name: "read",
    });

    expect(result.status).toBe("completed");
    expect(result.toolName).toBe("read");
    expect(result.content).toContain("path: package.json");
    expect(result.content).toContain("1 | {");
  });

  it("blocks read paths outside cwd", async () => {
    const runtime = createDefaultToolRuntime({ cwd: process.cwd() });

    const result = await runtime.execute({
      arguments: JSON.stringify({ path: "../package.json" }),
      name: "read",
    });

    expect(result).toEqual({
      content: 'blocked_reason: path "../package.json" is outside the current working directory',
      status: "blocked",
      toolName: "read",
    });
  });

  it("lists one directory level with stable entries", async () => {
    const runtime = createDefaultToolRuntime({ cwd: process.cwd() });

    const result = await runtime.execute({
      arguments: JSON.stringify({ path: "src" }),
      name: "ls",
    });

    expect(result.status).toBe("completed");
    expect(result.toolName).toBe("ls");
    expect(result.content).toContain("path: src");
    expect(result.content).toContain("[dir] cli");
    expect(result.content).toContain("[dir] core");
  });

  it("reports bad JSON arguments without throwing", async () => {
    const runtime = createDefaultToolRuntime({ cwd: process.cwd() });

    const result = await runtime.execute({
      arguments: "{bad json",
      name: "read",
    });

    expect(result).toEqual({
      content: "failed_reason: read arguments must be JSON with a non-empty string path field",
      status: "failed",
      toolName: "read",
    });
  });
});
