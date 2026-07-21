import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  activateApprovedPluginHooks,
  buildPluginActivationEvents,
  collectPluginTrustDecisions,
  mergeMcpPermissionPolicies,
  startApprovedPluginMcpServers,
  type PluginMcpSessionLike,
} from "../../src/extensions/pluginActivation.js";
import { resolvePluginDescriptors, type ResolvedPluginDescriptor } from "../../src/extensions/pluginDescriptors.js";
import type { LifecycleEmitter } from "../../src/extensions/lifecycle.js";
import type { PluginDescriptor } from "../../src/extensions/pluginPreflight.js";
import type { PermissionDecision } from "../../src/governance/types.js";
import type { TraceEventPayload } from "../../src/runtime/trace.js";

describe("plugin activation phases", () => {
  it("finishes every trust decision before importing any approved hook and leaves rejected plugins inert", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-activation-"));
    const approvedHook = path.join(directory, "approved.mjs");
    const rejectedHook = path.join(directory, "rejected.mjs");
    await writeFile(approvedHook, "globalThis.__pluginActivationOrder.push('import:approved'); export default () => {};\n");
    await writeFile(rejectedHook, "globalThis.__pluginActivationOrder.push('import:rejected'); export default () => {};\n");
    const order: string[] = [];
    (globalThis as { __pluginActivationOrder?: string[] }).__pluginActivationOrder = order;
    const events: TraceEventPayload[] = [];
    const descriptors = resolvePluginDescriptors([
      plugin("approved", 0, { hookPath: approvedHook }),
      plugin("rejected", 1, { hookPath: rejectedHook }),
    ], "/project");

    const decisions = await collectPluginTrustDecisions({
      approver: {
        async approve({ descriptor }) {
          order.push(`trust:${descriptor.name}`);
          return descriptor.name === "approved"
            ? { approved: true }
            : { approved: false, reason: "not trusted" };
        },
      },
      descriptors,
      lifecycleEmitter: emitter(events),
    });

    expect(order).toEqual(["trust:approved", "trust:rejected"]);
    expect(events.map((event) => event.type)).toEqual(["plugin_trust_decided", "plugin_trust_decided"]);

    const hooks = await activateApprovedPluginHooks(decisions);

    expect(order).toEqual(["trust:approved", "trust:rejected", "import:approved"]);
    expect(hooks.hooks.map((hook) => hook.name)).toEqual(["approved:audit"]);
    expect(hooks.failures).toEqual([]);
    delete (globalThis as { __pluginActivationOrder?: string[] }).__pluginActivationOrder;
  });

  it("starts servers sequentially in plugin/server order, continues after failure, and closes sessions in reverse once", async () => {
    const descriptors = resolvePluginDescriptors([
      plugin("later", 4, { servers: ["zeta", "alpha"] }),
      plugin("earlier", 1, { servers: ["only"] }),
    ], "/execution");
    const trustedServers = new Map<string, unknown>();
    const phaseOrder: string[] = [];
    const approved = await collectPluginTrustDecisions({
      approver: {
        async approve({ descriptor }) {
          phaseOrder.push(`trust:${descriptor.name}`);
          for (const server of descriptor.mcpServers) {
            trustedServers.set(server.server.id, server.server);
          }
          return { approved: true };
        },
      },
      descriptors,
      lifecycleEmitter: emitter([]),
    });
    const started: string[] = [];
    const closed: string[] = [];

    const result = await startApprovedPluginMcpServers({
      decisions: approved,
      lifecycleEmitter: emitter([]),
      async startSession(options) {
        phaseOrder.push(`start:${options.server.id}`);
        started.push(options.server.id);
        expect(options.server).toBe(trustedServers.get(options.server.id));
        expect(options.baseCwd).toBe("/execution");

        if (options.server.id === "later-alpha") {
          throw new Error("alpha failed");
        }

        return fakeSession(options.server.id, closed);
      },
    });

    expect(phaseOrder).toEqual([
      "trust:earlier",
      "trust:later",
      "start:earlier-only",
      "start:later-alpha",
      "start:later-zeta",
    ]);
    expect(started).toEqual(["earlier-only", "later-alpha", "later-zeta"]);
    expect(result.servers.map((server) => ({ id: server.descriptor.server.id, status: server.status }))).toEqual([
      { id: "earlier-only", status: "active" },
      { id: "later-alpha", status: "failed" },
      { id: "later-zeta", status: "active" },
    ]);

    await result.close();
    await result.close();
    expect(closed).toEqual(["later-zeta", "earlier-only"]);
  });

  it("builds complete active, degraded, and failed startup snapshots without treating deny or extra as degradation", () => {
    const active = resolvePluginDescriptors([plugin("active", 0, { servers: ["demo"], skill: true })], "/project")[0]!;
    const degraded = resolvePluginDescriptors([plugin("degraded", 1, { hookPath: "/missing.mjs", skill: true })], "/project")[0]!;
    const failed = resolvePluginDescriptors([plugin("failed", 2, { skill: true })], "/project")[0]!;
    const decisions = [
      { descriptor: active, result: { approved: true as const } },
      { descriptor: degraded, result: { approved: true as const } },
      { descriptor: failed, result: { approved: false as const, reason: "rejected" } },
    ];
    const events = buildPluginActivationEvents({
      decisions,
      hookFailures: [{ hookName: "degraded:audit", reason: "import failed" }],
      servers: [{
        descriptor: active.mcpServers[0]!,
        diagnostics: {
          deniedToolNames: ["mcp_active-demo_lookup"],
          discoveredToolNames: ["lookup", "server_extra"],
          exposedToolNames: [],
          extraToolNames: ["server_extra"],
          incompatibleTools: [],
          missingToolNames: [],
        },
        pluginName: "active",
        session: fakeSession("active-demo", []),
        status: "active",
      }],
    });

    expect(events.map((event) => ({ name: event.pluginName, status: event.status }))).toEqual([
      { name: "active", status: "active" },
      { name: "degraded", status: "degraded" },
      { name: "failed", status: "failed" },
    ]);
    expect(events[0]?.tools).toMatchObject({
      denied: ["mcp_active-demo_lookup"],
      extra: ["active-demo.server_extra"],
      incompatible: [],
      missing: [],
    });
    expect(events[1]?.components.hooks.failed).toEqual([{
      id: "degraded:audit",
      reason: "import failed",
    }]);
    expect(events[2]?.components.skills.failed).toEqual([{
      id: "failed:sample",
      reason: "rejected",
    }]);
  });

  it("merges permissions by exact final name and rejects duplicate ownership", () => {
    const allow: PermissionDecision = { action: "allow", reason: "read", risk: "inspect" };
    const deny: PermissionDecision = { action: "deny", reason: "blocked", risk: "destructive" };
    const merged = mergeMcpPermissionPolicies([
      new Map([["mcp_standalone_lookup", allow]]),
      new Map([["mcp_plugin-demo_delete", deny]]),
    ]);

    expect([...merged.entries()]).toEqual([
      ["mcp_standalone_lookup", allow],
      ["mcp_plugin-demo_delete", deny],
    ]);
    expect(() => mergeMcpPermissionPolicies([
      new Map([["mcp_duplicate_lookup", allow]]),
      new Map([["mcp_duplicate_lookup", deny]]),
    ])).toThrow('Duplicate MCP permission policy "mcp_duplicate_lookup"');
  });

  it("marks discovered missing and incompatible declared tools as degraded", () => {
    const descriptor = resolvePluginDescriptors([
      plugin("tool-problem", 0, { servers: ["demo"], toolAction: "allow" }),
    ], "/project")[0]!;
    const [event] = buildPluginActivationEvents({
      decisions: [{ descriptor, result: { approved: true } }],
      hookFailures: [],
      servers: [{
        descriptor: descriptor.mcpServers[0]!,
        diagnostics: {
          deniedToolNames: [],
          discoveredToolNames: ["lookup"],
          exposedToolNames: [],
          extraToolNames: [],
          incompatibleTools: [{ rawToolName: "lookup", reason: "schema root is not object" }],
          missingToolNames: ["lookup"],
        },
        pluginName: descriptor.name,
        session: fakeSession("tool-problem-demo", []),
        status: "active",
      }],
    });

    expect(event?.status).toBe("degraded");
    expect(event?.tools.missing).toEqual(["mcp_tool-problem-demo_lookup"]);
    expect(event?.tools.incompatible).toEqual([{
      reason: "schema root is not object",
      toolName: "mcp_tool-problem-demo_lookup",
    }]);
  });
});

function plugin(
  name: string,
  index: number,
  options: {
    hookPath?: string;
    servers?: string[];
    skill?: boolean;
    toolAction?: "allow" | "ask" | "deny";
  } = {},
): PluginDescriptor {
  return {
    configuredPath: `./${name}`,
    description: name,
    hooks: options.hookPath ? [{
      effectiveName: `${name}:audit`,
      entryPath: options.hookPath,
      events: ["permission_decision"],
      localName: "audit",
    }] : [],
    index,
    manifestPath: `/${name}/.forge-plugin/plugin.json`,
    mcpServers: (options.servers ?? []).map((localId) => ({
      args: [],
      command: "node",
      connectTimeoutMs: 5_000,
      effectiveId: `${name}-${localId}`,
      localId,
      toolCallTimeoutMs: 30_000,
      tools: [{
        effectiveName: `mcp_${name}-${localId}_lookup`,
        policy: { action: options.toolAction ?? "deny", reason: "fixture policy", risk: "inspect" },
        rawName: "lookup",
      }],
    })),
    name,
    root: `/${name}`,
    skills: options.skill ? [{
      body: "sample",
      description: "sample",
      id: `${name}:sample`,
      localId: "sample",
      sourcePath: `/${name}/skills/sample/SKILL.md`,
    }] : [],
    version: "0.1.0",
  };
}

function emitter(events: TraceEventPayload[]): LifecycleEmitter {
  return {
    async emit(event) {
      events.push(event);
    },
  };
}

function fakeSession(id: string, closed: string[]): PluginMcpSessionLike {
  return {
    async close() {
      closed.push(id);
    },
    diagnostics: {
      deniedToolNames: [`mcp_${id}_lookup`],
      discoveredToolNames: ["lookup"],
      exposedToolNames: [],
      extraToolNames: [],
      incompatibleTools: [],
      missingToolNames: [],
    },
    async execute(toolCall) {
      return {
        content: "unused fake session",
        status: "blocked",
        toolName: toolCall.name,
      };
    },
    permissionPolicies: new Map(),
    toolDefinitions: () => [],
  };
}
