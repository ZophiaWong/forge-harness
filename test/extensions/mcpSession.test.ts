import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createLifecycleEmitter } from "../../src/extensions/lifecycle.js";
import type { McpServerConfig } from "../../src/extensions/mcpConfig.js";
import { createMcpDemoServer } from "../../src/extensions/mcpDemoServer.js";
import { startMcpSession } from "../../src/extensions/mcpSession.js";
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
});
