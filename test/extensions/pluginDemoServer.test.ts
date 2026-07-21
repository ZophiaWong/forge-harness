import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

describe("issue-workflow demo MCP server", () => {
  it("discovers both tools and writes notes under the supplied project root", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-demo-"));
    const serverPath = demoServerPath();
    const module = await import(pathToFileURL(serverPath).href) as {
      createIssueWorkflowDemoServer(options: { projectRoot: string }): {
        close(): Promise<void>;
        connect(transport: ReturnType<typeof InMemoryTransport.createLinkedPair>[1]): Promise<void>;
      };
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = module.createIssueWorkflowDemoServer({ projectRoot });
    const client = new Client({ name: "forge-plugin-demo-test", version: "0.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport, { timeout: 2_000 });

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["create_note", "lookup_issue"]);

      const lookup = await client.callTool({
        arguments: { issueId: "FH-16" },
        name: "lookup_issue",
      });
      const note = await client.callTool({
        arguments: { body: "c16b fixture test", issueId: "FH-16" },
        name: "create_note",
      });

      expect(lookup.content).toContainEqual(expect.objectContaining({
        text: expect.stringContaining("issue_id: FH-16"),
        type: "text",
      }));
      expect(note.content).toContainEqual(expect.objectContaining({
        text: "note_created: note-1\nissue_id: FH-16",
        type: "text",
      }));
      expect(JSON.parse(await readFile(path.join(projectRoot, ".forge", "plugin-demo-notes.json"), "utf8")))
        .toMatchObject([{
          body: "c16b fixture test",
          id: "note-1",
          issueId: "FH-16",
        }]);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it.skipIf(isNestedNodeSpawnRestricted())("serves the same catalog over a real stdio child process", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-stdio-"));
    const transport = new StdioClientTransport({
      args: [demoServerPath(), "--project-root", projectRoot],
      command: process.execPath,
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "forge-plugin-stdio-test", version: "0.0.0" });

    try {
      await client.connect(transport, { timeout: 2_000 });
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "create_note",
        "lookup_issue",
      ]);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

function demoServerPath(): string {
  return path.join(process.cwd(), "examples", "plugins", "issue-workflow", "mcp", "server.mjs");
}

function isNestedNodeSpawnRestricted(): boolean {
  return process.env.CODEX_PERMISSION_PROFILE === ":workspace";
}
