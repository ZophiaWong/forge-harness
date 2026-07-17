import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDemoNote, lookupDemoIssue } from "../../src/extensions/mcpDemoServer.js";

describe("MCP demo server helpers", () => {
  it("returns the deterministic FH-16 issue", () => {
    const result = lookupDemoIssue("FH-16");

    expect(result).toEqual({
      found: true,
      text: [
        "issue_id: FH-16",
        "title: External tools must use Forge governance",
        "status: open",
        "summary: MCP and plugin tools must enter the same Tool Runtime, permission, result, and trace path as built-in tools.",
      ].join("\n"),
    });
  });

  it("returns a useful not-found result for an unknown issue id", () => {
    const result = lookupDemoIssue("FH-404");

    expect(result).toEqual({
      found: false,
      text: 'issue_not_found: FH-404\nknown_issues: FH-16',
    });
  });

  it("creates and appends demo notes under .forge", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-demo-"));

    const first = await createDemoNote({
      body: "Route lookup_issue through Tool Runtime.",
      cwd,
      issueId: "FH-16",
      now: new Date("2026-07-17T08:00:00.000Z"),
    });
    const second = await createDemoNote({
      body: "Require approval for create_note.",
      cwd,
      issueId: "FH-16",
      now: new Date("2026-07-17T08:01:00.000Z"),
    });

    expect(first.text).toBe("note_created: note-1\nissue_id: FH-16");
    expect(second.text).toBe("note_created: note-2\nissue_id: FH-16");

    const notesPath = path.join(cwd, ".forge", "mcp-demo-notes.json");
    const notes = JSON.parse(await readFile(notesPath, "utf8"));

    expect(notes).toEqual([
      {
        body: "Route lookup_issue through Tool Runtime.",
        createdAt: "2026-07-17T08:00:00.000Z",
        id: "note-1",
        issueId: "FH-16",
      },
      {
        body: "Require approval for create_note.",
        createdAt: "2026-07-17T08:01:00.000Z",
        id: "note-2",
        issueId: "FH-16",
      },
    ]);
  });
});
