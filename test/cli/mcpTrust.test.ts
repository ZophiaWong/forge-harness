import { PassThrough, Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createCliMcpServerTrustApprover } from "../../src/cli/mcpTrust.js";
import { createCliTerminalCoordinator } from "../../src/cli/terminal.js";
import type { McpProjectConfig } from "../../src/extensions/mcpConfig.js";

const config: McpProjectConfig = {
  configPath: "/workspace/.forge/mcp.json",
  server: {
    args: ["dist/extensions/mcpDemoServer.js"],
    command: "node",
    connectTimeoutMs: 5_000,
    id: "demo",
    toolCallTimeoutMs: 30_000,
    tools: {
      lookup_issue: {
        action: "allow",
        reason: "reads demo issues",
        risk: "inspect",
      },
      create_note: {
        action: "ask",
        reason: "writes demo notes",
        risk: "mutating",
      },
    },
  },
};

describe("createCliMcpServerTrustApprover", () => {
  it("shows the exact server command and sorted tool policies before approving", async () => {
    const { output, text } = writableOutput();
    const approver = createCliMcpServerTrustApprover({
      input: readableInput("yes\n"),
      output,
    });

    await expect(approver.approve({ baseCwd: "/workspace", config })).resolves.toEqual({ approved: true });
    expect(text()).toContain("Start project MCP server for this session?");
    expect(text()).toContain("config: /workspace/.forge/mcp.json");
    expect(text()).toContain('command: "node" "dist/extensions/mcpDemoServer.js"');
    expect(text()).toContain("cwd: /workspace");
    expect(text()).toContain("connect_timeout_ms: 5000");
    expect(text()).toContain("tool_call_timeout_ms: 30000");
    expect(text().indexOf("create_note: ask")).toBeLessThan(text().indexOf("lookup_issue: allow"));
    expect(text()).toContain("risk=mutating reason=writes demo notes");
    expect(text()).toContain("[y/N]:");
  });

  it("rejects by default", async () => {
    const { output } = writableOutput();
    const approver = createCliMcpServerTrustApprover({
      input: readableInput("\n"),
      output,
    });

    await expect(approver.approve({ baseCwd: "/workspace", config })).resolves.toEqual({
      approved: false,
      reason: "MCP server startup rejected by user",
    });
  });

  it("rejects without prompting in a non-interactive terminal", async () => {
    const { output, text } = writableOutput(false);
    const approver = createCliMcpServerTrustApprover({
      input: readableInput("", false),
      output,
    });

    await expect(approver.approve({ baseCwd: "/workspace", config })).resolves.toEqual({
      approved: false,
      reason: "MCP server startup requires an interactive terminal",
    });
    expect(text()).toBe("");
  });

  it("uses the shared terminal coordinator while awaiting trust input", async () => {
    const input = controlledInput();
    const { output, text } = writableOutput();
    const terminal = createCliTerminalCoordinator({
      stderr: output,
      stdout: output,
    });
    const approver = createCliMcpServerTrustApprover({ input, output, terminal });
    const approval = approver.approve({ baseCwd: "/workspace", config });
    await waitUntil(() => text().includes("[y/N]:"));

    terminal.log("[mailbox] queued while MCP trust is active");
    const outputBeforeAnswer = text();
    input.write("yes\n");

    await expect(approval).resolves.toEqual({ approved: true });
    expect(outputBeforeAnswer).not.toContain("[mailbox]");
    expect(text()).toContain("[mailbox] queued while MCP trust is active");
  });
});

function controlledInput(): NodeJS.ReadStream {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(input, "isTTY", { value: true });
  return input;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

function readableInput(text: string, isTTY = true): NodeJS.ReadStream {
  const input = Readable.from([text]) as NodeJS.ReadStream;
  Object.defineProperty(input, "isTTY", { value: isTTY });
  return input;
}

function writableOutput(isTTY = true): { output: NodeJS.WriteStream; text: () => string } {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written += chunk.toString("utf8");
      callback();
    },
  }) as NodeJS.WriteStream;
  Object.defineProperty(output, "isTTY", { value: isTTY });
  return { output, text: () => written };
}
