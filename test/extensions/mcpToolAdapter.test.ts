import { describe, expect, it } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  adaptMcpCallError,
  createMcpToolCatalog,
  projectMcpCallResult,
} from "../../src/extensions/mcpToolAdapter.js";
import type { McpServerConfig } from "../../src/extensions/mcpConfig.js";

function serverConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    args: [],
    command: "node",
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
    ...overrides,
  };
}

describe("createMcpToolCatalog", () => {
  it("registers only discovered and configured tools with explicit reverse mappings", () => {
    const lookupSchema = {
      properties: { issueId: { type: "string" } },
      required: ["issueId"],
      type: "object" as const,
    };
    const catalog = createMcpToolCatalog(serverConfig(), [
      {
        description: "Look up an issue.",
        inputSchema: lookupSchema,
        name: "lookup_issue",
      },
      {
        description: "Create a note.",
        inputSchema: { properties: {}, type: "object" },
        name: "create_note",
      },
      {
        inputSchema: { properties: {}, type: "object" },
        name: "server_extra",
      },
    ]);

    expect(catalog.definitions.map((tool) => tool.name)).toEqual([
      "mcp_demo_create_note",
      "mcp_demo_lookup_issue",
    ]);
    expect(catalog.definitions.every((tool) => tool.strict === false)).toBe(true);
    expect(catalog.definitions[1]?.parameters).toBe(lookupSchema);
    expect(catalog.exposedToRaw.get("mcp_demo_lookup_issue")).toBe("lookup_issue");
    expect(catalog.permissions.get("mcp_demo_create_note")).toEqual({
      action: "ask",
      reason: "write a note",
      risk: "mutating",
    });
    expect(catalog.diagnostics).toEqual({
      deniedToolNames: [],
      discoveredToolNames: ["create_note", "lookup_issue", "server_extra"],
      exposedToolNames: ["mcp_demo_create_note", "mcp_demo_lookup_issue"],
      extraToolNames: ["server_extra"],
      incompatibleTools: [],
      missingToolNames: [],
    });
  });

  it("warns about configured tools missing from discovery", () => {
    const catalog = createMcpToolCatalog(serverConfig(), [
      {
        inputSchema: { type: "object" },
        name: "lookup_issue",
      },
    ]);

    expect(catalog.definitions.map((tool) => tool.name)).toEqual(["mcp_demo_lookup_issue"]);
    expect(catalog.diagnostics.missingToolNames).toEqual(["create_note"]);
  });

  it("keeps deny as an exact policy while hiding the tool without missing or incompatible diagnostics", () => {
    const catalog = createMcpToolCatalog(serverConfig({
      tools: {
        blocked_missing: {
          action: "deny",
          reason: "never expose it",
          risk: "destructive",
        },
        blocked_present: {
          action: "deny",
          reason: "never expose it",
          risk: "destructive",
        },
        lookup_issue: {
          action: "allow",
          reason: "read an issue",
          risk: "inspect",
        },
      },
    }), [
      { inputSchema: { type: "string" }, name: "blocked_present" },
      { inputSchema: { type: "object" }, name: "lookup_issue" },
    ]);

    expect(catalog.definitions.map((tool) => tool.name)).toEqual(["mcp_demo_lookup_issue"]);
    expect(catalog.permissions.get("mcp_demo_blocked_missing")).toMatchObject({ action: "deny" });
    expect(catalog.permissions.get("mcp_demo_blocked_present")).toMatchObject({ action: "deny" });
    expect(catalog.diagnostics).toMatchObject({
      deniedToolNames: ["mcp_demo_blocked_missing", "mcp_demo_blocked_present"],
      incompatibleTools: [],
      missingToolNames: [],
    });
  });

  it("hides a duplicated discovered raw name as a tool-local conflict", () => {
    const catalog = createMcpToolCatalog(serverConfig(), [
      { inputSchema: { type: "object" }, name: "lookup_issue" },
      { inputSchema: { type: "object" }, name: "lookup_issue" },
      { inputSchema: { type: "object" }, name: "create_note" },
    ]);

    expect(catalog.definitions.map((tool) => tool.name)).toEqual(["mcp_demo_create_note"]);
    expect(catalog.diagnostics.incompatibleTools).toEqual([{
      rawToolName: "lookup_issue",
      reason: 'discovery returned duplicate tool name "lookup_issue"',
    }]);
  });

  it("hides incompatible names and schemas without dropping valid tools", () => {
    const config = serverConfig({
      id: "demo-server-with-a-name-that-makes-the-exposed-tool-name-far-too-long-for-openai",
      tools: {
        bad_schema: {
          action: "allow",
          reason: "bad schema fixture",
          risk: "inspect",
        },
        "bad/name": {
          action: "allow",
          reason: "bad name fixture",
          risk: "inspect",
        },
        ok: {
          action: "allow",
          reason: "valid fixture",
          risk: "inspect",
        },
      },
    });
    const catalog = createMcpToolCatalog(config, [
      { inputSchema: { type: "string" }, name: "bad_schema" },
      { inputSchema: { type: "object" }, name: "bad/name" },
      { inputSchema: { type: "object" }, name: "ok" },
    ]);

    expect(catalog.definitions).toEqual([]);
    expect(catalog.diagnostics.incompatibleTools).toEqual([
      {
        rawToolName: "bad/name",
        reason: expect.stringContaining("OpenAI function name"),
      },
      {
        rawToolName: "bad_schema",
        reason: "inputSchema must have an object root",
      },
      {
        rawToolName: "ok",
        reason: expect.stringContaining("64 characters"),
      },
    ]);
  });
});

describe("MCP result projection", () => {
  it("joins text blocks in order and appends stable structured JSON", () => {
    const result = projectMcpCallResult(
      "demo",
      "lookup_issue",
      "mcp_demo_lookup_issue",
      {
        content: [
          { text: "first", type: "text" },
          { text: "second", type: "text" },
        ],
        structuredContent: {
          z: 1,
          nested: { b: 2, a: 1 },
          a: ["keep", { z: true, a: false }],
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(result.content).toBe(
      [
        "first",
        "second",
        "structured_content:",
        '{"a":["keep",{"a":false,"z":true}],"nested":{"a":1,"b":2},"z":1}',
      ].join("\n"),
    );
  });

  it("keeps supported content and reports omitted rich content", () => {
    const result = projectMcpCallResult("demo", "lookup_issue", "mcp_demo_lookup_issue", {
      content: [
        { data: "not-projected", mimeType: "image/png", type: "image" },
        { text: "kept", type: "text" },
        { data: "not-projected", mimeType: "audio/wav", type: "audio" },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.content).toBe("kept\n[omitted MCP content types: audio, image]");
    expect(result.metadata).toMatchObject({
      mcp: {
        omittedContentTypes: ["audio", "image"],
      },
    });
    expect(result.content).not.toContain("not-projected");
  });

  it("fails unsupported-only and server-declared error results", () => {
    expect(
      projectMcpCallResult("demo", "lookup_issue", "mcp_demo_lookup_issue", {
        content: [{ data: "ignored", mimeType: "image/png", type: "image" }],
      }),
    ).toMatchObject({
      content: "failed_reason: MCP result contained only unsupported content types: image",
      status: "failed",
    });

    expect(
      projectMcpCallResult("demo", "lookup_issue", "mcp_demo_lookup_issue", {
        content: [{ text: "issue lookup failed", type: "text" }],
        isError: true,
      }),
    ).toMatchObject({
      content: "issue lookup failed",
      status: "failed",
    });
  });

  it("maps SDK timeout separately from transport and protocol failures", () => {
    expect(
      adaptMcpCallError(
        "demo",
        "lookup_issue",
        "mcp_demo_lookup_issue",
        new McpError(ErrorCode.RequestTimeout, "request timed out"),
      ),
    ).toMatchObject({
      status: "timed_out",
    });
    expect(
      adaptMcpCallError("demo", "lookup_issue", "mcp_demo_lookup_issue", new Error("connection closed")),
    ).toMatchObject({
      content: "failed_reason: connection closed",
      status: "failed",
    });
  });

  it("uses the existing 20,000 character truncation boundary", () => {
    const result = projectMcpCallResult("demo", "lookup_issue", "mcp_demo_lookup_issue", {
      content: [{ text: "x".repeat(20_100), type: "text" }],
    });

    expect(result.content).toContain("[truncated 100 chars]");
    expect(result.content).not.toContain("x".repeat(20_001));
  });
});
