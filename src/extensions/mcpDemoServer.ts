import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEMO_ISSUE_ID = "FH-16";
const DEMO_NOTES_PATH = path.join(".forge", "mcp-demo-notes.json");

export interface DemoIssueLookupResult {
  found: boolean;
  text: string;
}

export interface DemoNote {
  body: string;
  createdAt: string;
  id: string;
  issueId: string;
}

export interface CreateDemoNoteOptions {
  body: string;
  cwd: string;
  issueId: string;
  now?: Date;
}

export interface CreateDemoNoteResult {
  note: DemoNote;
  text: string;
}

export function lookupDemoIssue(issueId: string): DemoIssueLookupResult {
  if (issueId !== DEMO_ISSUE_ID) {
    return {
      found: false,
      text: `issue_not_found: ${issueId}\nknown_issues: ${DEMO_ISSUE_ID}`,
    };
  }

  return {
    found: true,
    text: [
      "issue_id: FH-16",
      "title: External tools must use Forge governance",
      "status: open",
      "summary: MCP and plugin tools must enter the same Tool Runtime, permission, result, and trace path as built-in tools.",
    ].join("\n"),
  };
}

export async function createDemoNote(options: CreateDemoNoteOptions): Promise<CreateDemoNoteResult> {
  const notesPath = path.join(options.cwd, DEMO_NOTES_PATH);
  const notes = await readDemoNotes(notesPath);
  const note: DemoNote = {
    body: options.body,
    createdAt: (options.now ?? new Date()).toISOString(),
    id: `note-${notes.length + 1}`,
    issueId: options.issueId,
  };

  const nextNotes = [...notes, note];
  await mkdir(path.dirname(notesPath), { recursive: true });
  await writeFile(notesPath, `${JSON.stringify(nextNotes, null, 2)}\n`, "utf8");

  return {
    note,
    text: [`note_created: ${note.id}`, `issue_id: ${note.issueId}`].join("\n"),
  };
}

export function createMcpDemoServer(options: { cwd?: string } = {}): McpServer {
  const cwd = options.cwd ?? process.cwd();
  const server = new McpServer({
    name: "forge-mcp-demo",
    version: "0.1.0",
  });

  server.registerTool(
    "lookup_issue",
    {
      description: "Look up a deterministic demo issue from the local Forge MCP fixture.",
      inputSchema: {
        issueId: z.string().min(1).describe('Demo issue id, for example "FH-16".'),
      },
      title: "Lookup demo issue",
    },
    async ({ issueId }) => {
      const result = lookupDemoIssue(issueId);
      return {
        content: [{ text: result.text, type: "text" }],
        isError: !result.found,
      };
    },
  );

  server.registerTool(
    "create_note",
    {
      description: "Append a note to the local Forge MCP demo notes file.",
      inputSchema: {
        body: z.string().min(1).describe("Note body to append."),
        issueId: z.string().min(1).describe('Demo issue id, for example "FH-16".'),
      },
      title: "Create demo note",
    },
    async ({ body, issueId }) => {
      const result = await createDemoNote({ body, cwd, issueId });
      return {
        content: [{ text: result.text, type: "text" }],
      };
    },
  );

  return server;
}

export async function runMcpDemoServer(options: { cwd?: string } = {}): Promise<void> {
  const server = createMcpDemoServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function readDemoNotes(notesPath: string): Promise<DemoNote[]> {
  try {
    const text = await readFile(notesPath, "utf8");
    const parsed: unknown = JSON.parse(text);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isDemoNote);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function isDemoNote(value: unknown): value is DemoNote {
  return (
    typeof value === "object" &&
    value !== null &&
    "body" in value &&
    typeof value.body === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "id" in value &&
    typeof value.id === "string" &&
    "issueId" in value &&
    typeof value.issueId === "string"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  runMcpDemoServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`forge MCP demo server failed: ${message}`);
    process.exitCode = 1;
  });
}
