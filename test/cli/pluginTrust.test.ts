import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createCliPluginTrustApprover } from "../../src/cli/pluginTrust.js";
import { resolvePluginDescriptors } from "../../src/extensions/pluginDescriptors.js";
import type { PluginDescriptor } from "../../src/extensions/pluginPreflight.js";

describe("createCliPluginTrustApprover", () => {
  it("shows the canonical plugin identity, every component, and the exact resolved spawn descriptor", async () => {
    const { output, text } = writableOutput();
    const descriptor = resolvePluginDescriptors([plugin()], "/worktrees/session-1")[0]!;
    const approver = createCliPluginTrustApprover({
      input: readableInput("yes\n"),
      output,
    });

    await expect(approver.approve({ descriptor })).resolves.toEqual({ approved: true });
    expect(text()).toContain("Activate local plugin for this session?");
    expect(text()).toContain("plugin: issue-workflow@0.1.0");
    expect(text()).toContain('description: "Full fixture"');
    expect(text()).toContain('canonical_root: "/original/issue-workflow"');
    expect(text()).toContain('skill issue-workflow:triage: "/original/issue-workflow/skills/triage/SKILL.md"');
    expect(text()).toContain('hook issue-workflow:audit: events=permission_decision entry="/original/issue-workflow/hooks/audit.mjs"');
    expect(text()).toContain("server issue-workflow-demo:");
    expect(text()).toContain('command: "node" "/original/issue-workflow/mcp/server.mjs" "--project-root" "/worktrees/session-1"');
    expect(text()).toContain('cwd: "/worktrees/session-1"');
    expect(text()).toContain("connect_timeout_ms: 5000");
    expect(text()).toContain("tool_call_timeout_ms: 30000");
    expect(text()).toContain('mcp_issue-workflow-demo_lookup_issue: allow risk=inspect reason="read issue"');
    expect(text()).toContain("[y/N]:");
  });

  it("escapes plugin-controlled control characters on the trust decision surface", async () => {
    const { output, text } = writableOutput();
    const descriptor = resolvePluginDescriptors([{
      ...plugin(),
      description: "forged\n[y/N]: yes",
      root: "/original/\u001b[2Jforged",
      mcpServers: [{
        ...plugin().mcpServers[0]!,
        tools: [{
          ...plugin().mcpServers[0]!.tools[0]!,
          policy: { action: "allow", reason: "safe\nplugin: forged", risk: "inspect" },
        }],
      }],
    }], "/worktrees/session-1")[0]!;
    const approver = createCliPluginTrustApprover({
      input: readableInput("no\n"),
      output,
    });

    await approver.approve({ descriptor });

    expect(text()).toContain('description: "forged\\n[y/N]: yes"');
    expect(text()).toContain('canonical_root: "/original/\\u001b[2Jforged"');
    expect(text()).toContain('reason="safe\\nplugin: forged"');
    expect(text()).not.toContain("description: forged\n[y/N]: yes");
    expect(text()).not.toContain("\u001b[2J");
  });

  it("rejects skill-only plugins without prompting when the terminal is non-interactive", async () => {
    const { output, text } = writableOutput(false);
    const descriptor = resolvePluginDescriptors([{ ...plugin(), hooks: [], mcpServers: [] }], "/project")[0]!;
    const approver = createCliPluginTrustApprover({
      input: readableInput("", false),
      output,
    });

    await expect(approver.approve({ descriptor })).resolves.toEqual({
      approved: false,
      reason: "Plugin activation requires an interactive terminal",
    });
    expect(text()).toBe("");
  });
});

function plugin(): PluginDescriptor {
  return {
    configuredPath: "./examples/plugins/issue-workflow",
    description: "Full fixture",
    hooks: [{
      effectiveName: "issue-workflow:audit",
      entryPath: "/original/issue-workflow/hooks/audit.mjs",
      events: ["permission_decision"],
      localName: "audit",
    }],
    index: 0,
    manifestPath: "/original/issue-workflow/.forge-plugin/plugin.json",
    mcpServers: [{
      args: ["${pluginRoot}/mcp/server.mjs", "--project-root", "${projectRoot}"],
      command: "node",
      connectTimeoutMs: 5_000,
      effectiveId: "issue-workflow-demo",
      localId: "demo",
      toolCallTimeoutMs: 30_000,
      tools: [{
        effectiveName: "mcp_issue-workflow-demo_lookup_issue",
        policy: { action: "allow", reason: "read issue", risk: "inspect" },
        rawName: "lookup_issue",
      }],
    }],
    name: "issue-workflow",
    root: "/original/issue-workflow",
    skills: [{
      body: "triage",
      description: "triage",
      id: "issue-workflow:triage",
      localId: "triage",
      sourcePath: "/original/issue-workflow/skills/triage/SKILL.md",
    }],
    version: "0.1.0",
  };
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
