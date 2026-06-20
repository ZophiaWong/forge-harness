import { describe, expect, it } from "vitest";

import { createDefaultToolRuntime } from "../../src/tools/defaultRuntime.js";
import { formatToolResultForModel } from "../../src/tools/result.js";
import { createToolRuntime } from "../../src/tools/runtime.js";
import type { ToolDefinition, ToolHandler, ToolResult } from "../../src/tools/types.js";

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
  it("exposes bash, read, and ls as built-in tool definitions", () => {
    const runtime = createDefaultToolRuntime({ cwd: process.cwd() });

    expect(runtime.toolDefinitions().map((tool) => tool.name)).toEqual(["bash", "read", "ls"]);
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

describe("formatToolResultForModel", () => {
  it("formats the unified result protocol for model feedback", () => {
    const result: ToolResult = {
      content: "hello",
      status: "completed",
      toolName: "read",
    };

    expect(formatToolResultForModel(result)).toBe("tool: read\nstatus: completed\nhello");
  });
});
