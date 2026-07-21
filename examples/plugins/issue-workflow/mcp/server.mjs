import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function createIssueWorkflowDemoServer(options) {
  const notesPath = path.join(options.projectRoot, ".forge", "plugin-demo-notes.json");
  const server = new McpServer({ name: "forge-issue-workflow-demo", version: "0.1.0" });

  server.registerTool(
    "lookup_issue",
    {
      description: "Look up the deterministic issue used by the c16b plugin fixture.",
      inputSchema: {
        issueId: z.string().min(1).describe('Demo issue id, for example "FH-16".'),
      },
      title: "Lookup plugin demo issue",
    },
    async ({ issueId }) => {
      const found = issueId === "FH-16";
      return {
        content: [{
          text: found
            ? [
                "issue_id: FH-16",
                "title: Plugin components need one loading boundary",
                "status: open",
                "summary: Skills, hooks, and MCP servers should register through existing Forge subsystems.",
              ].join("\n")
            : `issue_not_found: ${issueId}\nknown_issues: FH-16`,
          type: "text",
        }],
        isError: !found,
      };
    },
  );

  server.registerTool(
    "create_note",
    {
      description: "Append a note beneath the active Forge project root.",
      inputSchema: {
        body: z.string().min(1).describe("Note body to append."),
        issueId: z.string().min(1).describe('Demo issue id, for example "FH-16".'),
      },
      title: "Create plugin demo note",
    },
    async ({ body, issueId }) => {
      const notes = await readNotes(notesPath);
      const note = {
        body,
        createdAt: new Date().toISOString(),
        id: `note-${notes.length + 1}`,
        issueId,
      };

      await mkdir(path.dirname(notesPath), { recursive: true });
      await writeFile(notesPath, `${JSON.stringify([...notes, note], null, 2)}\n`, "utf8");

      return {
        content: [{ text: `note_created: ${note.id}\nissue_id: ${issueId}`, type: "text" }],
      };
    },
  );

  return server;
}

export async function runIssueWorkflowDemoServer(args = process.argv.slice(2)) {
  const server = createIssueWorkflowDemoServer({ projectRoot: readProjectRoot(args) });
  await server.connect(new StdioServerTransport());
}

function readProjectRoot(args) {
  const index = args.indexOf("--project-root");
  const value = index >= 0 ? args[index + 1] : undefined;

  if (!value) {
    throw new Error("--project-root requires a path");
  }

  return path.resolve(value);
}

async function readNotes(notesPath) {
  try {
    const parsed = JSON.parse(await readFile(notesPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  runIssueWorkflowDemoServer().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`issue-workflow demo server failed: ${message}`);
    process.exitCode = 1;
  });
}
