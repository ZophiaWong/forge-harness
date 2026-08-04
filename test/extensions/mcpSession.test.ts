import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";

import { createLifecycleEmitter } from "../../src/extensions/lifecycle.js";
import type { McpServerConfig } from "../../src/extensions/mcpConfig.js";
import { createMcpDemoServer } from "../../src/extensions/mcpDemoServer.js";
import {
  McpSessionStartError,
  startMcpSession,
} from "../../src/extensions/mcpSession.js";
import { startApprovedPluginMcpServers } from "../../src/extensions/pluginActivation.js";
import { resolvePluginDescriptors } from "../../src/extensions/pluginDescriptors.js";
import type { PluginDescriptor } from "../../src/extensions/pluginPreflight.js";
import { runWithWorkflowDeadline } from "../../src/eval/runner.js";
import type { TraceEventPayload } from "../../src/runtime/trace.js";

function config(): McpServerConfig {
  return {
    args: [],
    command: "in-memory",
    connectTimeoutMs: 5_000,
    id: "demo",
    toolCallTimeoutMs: 30_000,
    tools: {
      create_note: {
        action: "ask",
        reason: "write a note",
        risk: "mutating",
      },
      lookup_issue: {
        action: "allow",
        reason: "read an issue",
        risk: "inspect",
      },
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("McpSession", () => {
  it("discovers and calls the real demo server through linked in-memory transports", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-session-"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpDemoServer({ cwd });
    await server.connect(serverTransport);

    const session = await startMcpSession({
      baseCwd: cwd,
      server: config(),
      transport: clientTransport,
    });

    expect(session.toolDefinitions().map((tool) => tool.name)).toEqual([
      "mcp_demo_create_note",
      "mcp_demo_lookup_issue",
    ]);
    expect(session.permissionPolicies.get("mcp_demo_lookup_issue")).toMatchObject({
      action: "allow",
      risk: "inspect",
    });

    const lookup = await session.execute({
      arguments: JSON.stringify({ issueId: "FH-16" }),
      name: "mcp_demo_lookup_issue",
    });
    const note = await session.execute({
      arguments: JSON.stringify({ body: "Approve each mutating call.", issueId: "FH-16" }),
      name: "mcp_demo_create_note",
    });

    expect(lookup).toMatchObject({
      content: expect.stringContaining("issue_id: FH-16"),
      status: "completed",
    });
    expect(note).toMatchObject({
      content: "note_created: note-1\nissue_id: FH-16",
      status: "completed",
    });
    expect(JSON.parse(await readFile(path.join(cwd, ".forge", "mcp-demo-notes.json"), "utf8"))).toMatchObject([
      {
        body: "Approve each mutating call.",
        id: "note-1",
        issueId: "FH-16",
      },
    ]);

    await session.close();
    await server.close();
  });

  it("removes definitions after an unexpected close and fails a stale call", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpDemoServer();
    const events: TraceEventPayload[] = [];
    await server.connect(serverTransport);
    const session = await startMcpSession({
      baseCwd: process.cwd(),
      lifecycleEmitter: createLifecycleEmitter({
        recorder: {
          async record(event) {
            events.push(event);
          },
        },
      }),
      server: config(),
      transport: clientTransport,
    });

    await server.close();
    await flushPromises();

    expect(session.toolDefinitions()).toEqual([]);
    await expect(
      session.execute({ arguments: '{"issueId":"FH-16"}', name: "mcp_demo_lookup_issue" }),
    ).resolves.toMatchObject({
      status: "failed",
    });
    expect(events).toContainEqual(expect.objectContaining({
      phase: "transport",
      serverId: "demo",
      type: "mcp_server_failed",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      reason: "unexpected_close",
      serverId: "demo",
      type: "mcp_server_stopped",
    }));

    await session.close();
  });

  it("attempts every startup failure stage and preserves exact primary and secondary errors", async () => {
    const startupError = new Error("transport start failed");
    const failedEvidenceError = new Error("failed evidence rejected");
    const closeError = new Error("startup client close failed");
    const stoppedEvidenceError = new Error("stopped evidence rejected");
    const transport = new FailingStartupTransport(startupError, closeError);
    const events: TraceEventPayload["type"][] = [];

    const error = await startMcpSession({
      baseCwd: process.cwd(),
      lifecycleEmitter: {
        async emit(event) {
          events.push(event.type);
          if (event.type === "mcp_server_failed") {
            throw failedEvidenceError;
          }
          if (event.type === "mcp_server_stopped") {
            throw stoppedEvidenceError;
          }
        },
      },
      server: config(),
      transport,
    }).catch((caught: unknown) => caught);

    expect(transport.close).toHaveBeenCalledOnce();
    expect(events).toEqual(["mcp_server_failed", "mcp_server_stopped"]);
    expect(error).toBeInstanceOf(AggregateError);
    const failures = (error as AggregateError).errors;
    expect(failures).toHaveLength(4);
    expect(failures[0]).toBeInstanceOf(McpSessionStartError);
    expect((error as AggregateError).cause).toBe(failures[0]);
    expect((failures[0] as Error).cause).toBe(startupError);
    expect(failures.slice(1)).toEqual([
      failedEvidenceError,
      closeError,
      stoppedEvidenceError,
    ]);
  });

  it("shares close while attempting failed and stopped evidence without hiding client-close failure", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpDemoServer();
    await server.connect(serverTransport);
    const clientCloseError = new Error("client close failed");
    const failedEvidenceError = new Error("close failure evidence rejected");
    const stoppedEvidenceError = new Error("close stopped evidence rejected");
    const events: TraceEventPayload["type"][] = [];
    const originalClose = clientTransport.close.bind(clientTransport);
    clientTransport.close = vi.fn()
      .mockRejectedValueOnce(clientCloseError)
      .mockImplementation(originalClose);
    const session = await startMcpSession({
      baseCwd: process.cwd(),
      lifecycleEmitter: {
        async emit(event) {
          events.push(event.type);
          if (event.type === "mcp_server_failed") {
            throw failedEvidenceError;
          }
          if (event.type === "mcp_server_stopped") {
            throw stoppedEvidenceError;
          }
        },
      },
      server: config(),
      transport: clientTransport,
    });
    events.length = 0;

    const first = session.close();
    const overlapping = session.close();

    expect(overlapping).toBe(first);
    await expect(first).rejects.toSatisfy((error: unknown) => {
      return error instanceof AggregateError
        && error.cause === clientCloseError
        && error.errors[0] === clientCloseError
        && error.errors[1] === failedEvidenceError
        && error.errors[2] === stoppedEvidenceError;
    });
    expect(events).toEqual(["mcp_server_failed", "mcp_server_stopped"]);
    expect(clientTransport.close).toHaveBeenCalledOnce();

    await expect(session.close()).rejects.toBeInstanceOf(AggregateError);
    expect(clientTransport.close).toHaveBeenCalledOnce();
    await server.close();
  });

  it("surfaces stopped evidence failure after a successful idempotent client close", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpDemoServer();
    await server.connect(serverTransport);
    const stoppedEvidenceError = new Error("stopped evidence failed");
    const session = await startMcpSession({
      baseCwd: process.cwd(),
      lifecycleEmitter: {
        async emit(event) {
          if (event.type === "mcp_server_stopped") {
            throw stoppedEvidenceError;
          }
        },
      },
      server: config(),
      transport: clientTransport,
    });

    const first = session.close();
    expect(session.close()).toBe(first);
    await expect(first).rejects.toBe(stoppedEvidenceError);
    await expect(session.close()).rejects.toBe(stoppedEvidenceError);
  });

  it("retains a production client-close error through plugin cleanup and workflow timeout", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpDemoServer();
    await server.connect(serverTransport);
    const clientCloseError = new Error("nested production client close failed");
    const originalClose = clientTransport.close.bind(clientTransport);
    clientTransport.close = vi.fn()
      .mockRejectedValueOnce(clientCloseError)
      .mockImplementation(originalClose);
    const session = await startMcpSession({
      baseCwd: process.cwd(),
      server: config(),
      transport: clientTransport,
    });
    const [descriptor] = resolvePluginDescriptors([pluginFixture()], process.cwd());
    const activation = await startApprovedPluginMcpServers({
      decisions: [{ descriptor: descriptor!, result: { approved: true } }],
      lifecycleEmitter: { async emit() {} },
      async startSession() {
        return session;
      },
    });
    const timeoutError = await runWithWorkflowDeadline(
      (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          void activation.close().then(
            () => reject(new Error("plugin cleanup unexpectedly succeeded")),
            reject,
          );
        }, { once: true });
      }),
      100,
    ).catch((caught: unknown) => caught);

    const pluginFailure = (timeoutError as Error & { cause: AggregateError }).cause;
    expect(timeoutError).toMatchObject({ reasonCode: "workflow_timeout" });
    expect(pluginFailure).toBeInstanceOf(AggregateError);
    expect(pluginFailure.errors).toEqual([clientCloseError]);
    await server.close();
  });
});

class FailingStartupTransport implements Transport {
  readonly close;

  constructor(
    private readonly startupError: Error,
    closeError: Error,
  ) {
    this.close = vi.fn(async () => {
      throw closeError;
    });
  }

  async send(): Promise<void> {}

  async start(): Promise<void> {
    throw this.startupError;
  }
}

function pluginFixture(): PluginDescriptor {
  return {
    configuredPath: "./cleanup",
    description: "cleanup",
    hooks: [],
    index: 0,
    manifestPath: "/cleanup/.forge-plugin/plugin.json",
    mcpServers: [{
      args: [],
      command: "node",
      connectTimeoutMs: 5_000,
      effectiveId: "cleanup-demo",
      localId: "demo",
      toolCallTimeoutMs: 30_000,
      tools: [{
        effectiveName: "mcp_cleanup-demo_lookup",
        policy: { action: "allow", reason: "fixture", risk: "inspect" },
        rawName: "lookup",
      }],
    }],
    name: "cleanup",
    root: "/cleanup",
    skills: [],
    version: "0.1.0",
  };
}
