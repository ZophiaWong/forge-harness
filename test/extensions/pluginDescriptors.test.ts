import { describe, expect, it } from "vitest";

import { resolvePluginDescriptors } from "../../src/extensions/pluginDescriptors.js";
import type { PluginDescriptor } from "../../src/extensions/pluginPreflight.js";

describe("resolvePluginDescriptors", () => {
  it("binds pluginRoot to the original plugin and projectRoot/cwd to the execution workspace", () => {
    const source = plugin();
    const [resolved] = resolvePluginDescriptors([source], "/worktrees/session-1");
    const server = resolved?.mcpServers[0];

    expect(resolved?.root).toBe("/original/examples/plugin");
    expect(server).toMatchObject({
      cwd: "/worktrees/session-1",
      server: {
        args: [
          "/original/examples/plugin/server.mjs",
          "--project=/worktrees/session-1",
          "/original/examples/plugin:/worktrees/session-1",
        ],
        command: "/original/examples/plugin/bin/node",
        id: "demo-plugin-local",
        tools: {
          lookup: { action: "ask", risk: "unknown" },
        },
      },
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(server?.server.args)).toBe(true);
    expect(Object.isFrozen(server?.server.tools.lookup)).toBe(true);
  });
});

function plugin(): PluginDescriptor {
  return {
    configuredPath: "./examples/plugin",
    description: "Demo plugin",
    hooks: [],
    index: 0,
    manifestPath: "/original/examples/plugin/.forge-plugin/plugin.json",
    mcpServers: [{
      args: [
        "${pluginRoot}/server.mjs",
        "--project=${projectRoot}",
        "${pluginRoot}:${projectRoot}",
      ],
      command: "${pluginRoot}/bin/node",
      connectTimeoutMs: 5_000,
      effectiveId: "demo-plugin-local",
      localId: "local",
      toolCallTimeoutMs: 30_000,
      tools: [{
        effectiveName: "mcp_demo-plugin-local_lookup",
        policy: {
          action: "ask",
          reason: "No host policy configured.",
          risk: "unknown",
        },
        rawName: "lookup",
      }],
    }],
    name: "demo-plugin",
    root: "/original/examples/plugin",
    skills: [],
    version: "0.1.0",
  };
}
