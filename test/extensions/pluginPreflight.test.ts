import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadPluginProjectConfig } from "../../src/extensions/pluginConfig.js";
import {
  PluginPreflightError,
  preflightPlugins,
} from "../../src/extensions/pluginPreflight.js";

describe("preflightPlugins", () => {
  it("loads the tracked full and skill-only demo plugins without executing code", async () => {
    const baseCwd = process.cwd();
    const config = await loadPluginProjectConfig(baseCwd);

    const result = await preflightPlugins({ baseCwd, config });

    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["issue-workflow", "review-helper"]);
    expect(result.plugins[0]).toMatchObject({
      description: "Small issue workflow plugin used by the c16b tutorial.",
      hooks: [{
        effectiveName: "issue-workflow:audit",
        events: ["permission_decision"],
      }],
      mcpServers: [{
        effectiveId: "issue-workflow-demo",
        localId: "demo",
        tools: [
          { policy: { action: "allow", risk: "inspect" }, rawName: "lookup_issue" },
          { policy: { action: "ask", risk: "mutating" }, rawName: "create_note" },
        ],
      }],
      skills: [{ id: "issue-workflow:triage", localId: "triage" }],
      version: "0.1.0",
    });
    expect(result.plugins[1]).toMatchObject({
      hooks: [],
      mcpServers: [],
      skills: [{ id: "review-helper:review", localId: "review" }],
      version: "0.1.0",
    });
  });

  it("reads hook registries without importing hook code", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-no-exec-"));
    const pluginRoot = path.join(baseCwd, "plugin");
    await mkdir(path.join(pluginRoot, ".forge-plugin"), { recursive: true });
    await mkdir(path.join(pluginRoot, "hooks"), { recursive: true });
    await writeJson(path.join(pluginRoot, ".forge-plugin", "plugin.json"), {
      description: "No execution before trust",
      hooks: "./hooks/hooks.json",
      name: "no-exec",
      version: "0.1.0",
    });
    await writeJson(path.join(pluginRoot, "hooks", "hooks.json"), {
      hooks: [{ entry: "./hooks/audit.mjs", events: ["permission_decision"], name: "audit" }],
    });
    await writeFile(
      path.join(pluginRoot, "hooks", "audit.mjs"),
      "globalThis.__forgePreflightExecuted = true; export default () => {};\n",
      "utf8",
    );
    delete (globalThis as { __forgePreflightExecuted?: boolean }).__forgePreflightExecuted;

    await preflightPlugins({
      baseCwd,
      config: { plugins: [{ enabled: true, path: "./plugin" }] },
    });

    expect((globalThis as { __forgePreflightExecuted?: boolean }).__forgePreflightExecuted).toBeUndefined();
  });

  it("resolves hook entries from the plugin root rather than the registry directory", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-hook-root-"));
    const pluginRoot = path.join(baseCwd, "plugin");
    await mkdir(path.join(pluginRoot, ".forge-plugin"), { recursive: true });
    await mkdir(path.join(pluginRoot, "config"), { recursive: true });
    await writeJson(path.join(pluginRoot, ".forge-plugin", "plugin.json"), {
      description: "Root-relative hook entry",
      hooks: "./config/hooks.json",
      name: "root-hook",
      version: "0.1.0",
    });
    await writeJson(path.join(pluginRoot, "config", "hooks.json"), {
      hooks: [{ entry: "./audit.mjs", events: ["permission_decision"], name: "audit" }],
    });
    await writeFile(path.join(pluginRoot, "audit.mjs"), "export default () => {};\n", "utf8");

    const result = await preflightPlugins({
      baseCwd,
      config: { plugins: [{ enabled: true, path: "./plugin" }] },
    });

    expect(result.plugins[0]?.hooks[0]?.entryPath).toBe(path.join(pluginRoot, "audit.mjs"));
  });

  it("does not read disabled plugin targets", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-disabled-"));

    await expect(preflightPlugins({
      baseCwd,
      config: {
        plugins: [{ enabled: false, path: "./does-not-exist" }],
      },
    })).resolves.toEqual({ plugins: [] });
  });

  it("accepts both project-relative and absolute plugin roots", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-roots-"));
    const relativeRoot = await createSkillPlugin(baseCwd, "relative-plugin", "relative-plugin");
    const absoluteContainer = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-absolute-"));
    const absoluteRoot = await createSkillPlugin(absoluteContainer, "absolute-plugin", "absolute-plugin");

    const result = await preflightPlugins({
      baseCwd,
      config: {
        plugins: [
          { enabled: true, path: `./${path.relative(baseCwd, relativeRoot)}` },
          { enabled: true, path: absoluteRoot },
        ],
      },
    });

    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["relative-plugin", "absolute-plugin"]);
    expect(result.plugins.map((plugin) => plugin.root)).toEqual([relativeRoot, absoluteRoot]);
  });

  it("rejects a component symlink that resolves outside the plugin root", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-symlink-"));
    const pluginRoot = path.join(baseCwd, "plugin");
    const outsideSkills = path.join(baseCwd, "outside-skills");
    await mkdir(path.join(pluginRoot, ".forge-plugin"), { recursive: true });
    await mkdir(outsideSkills, { recursive: true });
    await symlink(outsideSkills, path.join(pluginRoot, "skills"), "dir");
    await writeJson(path.join(pluginRoot, ".forge-plugin", "plugin.json"), {
      description: "Escaping plugin",
      name: "escaping-plugin",
      skills: "./skills",
      version: "0.1.0",
    });

    const error = await capturePreflightError(baseCwd, [
      { enabled: true, path: "./plugin" },
    ]);

    expect(error.issues).toEqual([
      expect.objectContaining({
        field: "manifest.skills",
        message: expect.stringContaining("escapes plugin root"),
        pluginIndex: 0,
      }),
    ]);
  });

  it("aggregates enabled-plugin failures in deterministic config order", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-issues-"));

    const error = await capturePreflightError(baseCwd, [
      { enabled: true, path: "./missing-z" },
      { enabled: false, path: "./ignored" },
      { enabled: true, path: "./missing-a" },
    ]);

    expect(error.issues.map((issue) => ({
      field: issue.field,
      pluginIndex: issue.pluginIndex,
      pluginPath: issue.pluginPath,
    }))).toEqual([
      { field: "plugin", pluginIndex: 0, pluginPath: "./missing-z" },
      { field: "plugin", pluginIndex: 2, pluginPath: "./missing-a" },
    ]);
  });

  it("aggregates independent skill, hook, and MCP issues from one manifest", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-component-issues-"));
    const pluginRoot = path.join(baseCwd, "plugin");
    await mkdir(path.join(pluginRoot, ".forge-plugin"), { recursive: true });
    await mkdir(path.join(pluginRoot, "hooks"), { recursive: true });
    await mkdir(path.join(pluginRoot, "mcp"), { recursive: true });
    await writeJson(path.join(pluginRoot, ".forge-plugin", "plugin.json"), {
      description: "Broken components",
      hooks: "./hooks/hooks.json",
      mcpServers: "./mcp/mcp.json",
      name: "broken-components",
      skills: "./missing-skills",
      version: "0.1.0",
    });
    await writeJson(path.join(pluginRoot, "hooks", "hooks.json"), {
      hooks: [{ entry: "./missing.mjs", events: ["plugin_trust_decided"], name: "bad" }],
    });
    await writeJson(path.join(pluginRoot, "mcp", "mcp.json"), {
      servers: { demo: { command: "${env:COMMAND}", tools: ["lookup"] } },
    });

    const error = await capturePreflightError(baseCwd, [{ enabled: true, path: "./plugin" }]);

    expect(error.issues.map((issue) => issue.field)).toEqual([
      "hooks.0.entry",
      "hooks.0.events",
      "manifest.skills",
      "mcpServers",
    ]);
  });

  it("rejects declared skill and hook components that contain no registrations", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-empty-components-"));
    const pluginRoot = path.join(baseCwd, "plugin");
    await mkdir(path.join(pluginRoot, ".forge-plugin"), { recursive: true });
    await mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await mkdir(path.join(pluginRoot, "hooks"), { recursive: true });
    await writeJson(path.join(pluginRoot, ".forge-plugin", "plugin.json"), {
      description: "Empty components",
      hooks: "./hooks/hooks.json",
      name: "empty-components",
      skills: "./skills",
      version: "0.1.0",
    });
    await writeJson(path.join(pluginRoot, "hooks", "hooks.json"), { hooks: [] });

    const error = await capturePreflightError(baseCwd, [{ enabled: true, path: "./plugin" }]);

    expect(error.issues.map((issue) => issue.field)).toEqual(["hooks", "manifest.skills"]);
  });

  it("reports every namespace collision instead of using last-wins registration", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-collision-"));
    await createMcpPlugin(baseCwd, "first", "same-name");
    await createMcpPlugin(baseCwd, "second", "same-name");

    const error = await capturePreflightError(baseCwd, [
      { enabled: true, path: "./first" },
      { enabled: true, path: "./second" },
    ]);

    expect(error.issues.map((issue) => issue.message)).toEqual([
      'plugin name "same-name" conflicts with plugin at index 0',
      'effective server ID "same-name-demo" conflicts with plugin at index 0',
      'final tool name "mcp_same-name-demo_lookup" conflicts with plugin at index 0',
    ]);
  });

  it("rejects MCP policies on a plugin that declares no MCP servers", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-policy-without-mcp-"));
    await createSkillPlugin(baseCwd, "plugin", "skill-only");

    const error = await capturePreflightError(baseCwd, [{
      enabled: true,
      mcpPolicies: {
        ghost: {
          lookup: { action: "allow", reason: "invalid owner", risk: "inspect" },
        },
      },
      path: "./plugin",
    }]);

    expect(error.issues).toEqual([
      expect.objectContaining({
        field: "mcpPolicies",
        message: 'policy references undeclared server "ghost"',
      }),
    ]);
  });

  it("retains valid MCP descriptors for collision checks when a sibling server has semantic errors", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-collision-and-error-"));
    await createMcpPlugin(baseCwd, "first", "same-name");
    const secondRoot = await createMcpPlugin(baseCwd, "second", "same-name");
    await writeJson(path.join(secondRoot, "mcp", "mcp.json"), {
      servers: {
        broken: { command: "${unknown}", tools: ["other"] },
        demo: { command: "node", tools: ["lookup"] },
      },
    });

    const error = await capturePreflightError(baseCwd, [
      { enabled: true, path: "./first" },
      { enabled: true, path: "./second" },
    ]);
    const messages = error.issues.map((issue) => issue.message);

    expect(messages).toContain('plugin name "same-name" conflicts with plugin at index 0');
    expect(messages).toContain('effective server ID "same-name-demo" conflicts with plugin at index 0');
    expect(messages).toContain('final tool name "mcp_same-name-demo_lookup" conflicts with plugin at index 0');
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('unsupported interpolation "${unknown}"'),
    ]));
  });

  it("detects effective server and tool collisions with the standalone c16a MCP config", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-standalone-collision-"));
    await createMcpPlugin(baseCwd, "plugin", "same-name");

    try {
      await preflightPlugins({
        baseCwd,
        config: { plugins: [{ enabled: true, path: "./plugin" }] },
        standaloneMcpConfig: {
          configPath: path.join(baseCwd, ".forge", "mcp.json"),
          server: {
            args: [],
            command: "node",
            connectTimeoutMs: 5_000,
            id: "same-name-demo",
            toolCallTimeoutMs: 30_000,
            tools: {
              lookup: { action: "allow", reason: "read", risk: "inspect" },
            },
          },
        },
      });
      throw new Error("expected plugin preflight to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginPreflightError);
      expect((error as PluginPreflightError).issues.map((issue) => issue.message)).toEqual([
        'effective server ID "same-name-demo" conflicts with standalone MCP server',
        'final tool name "mcp_same-name-demo_lookup" conflicts with standalone MCP server',
      ]);
    }
  });

  it("rejects unsupported interpolation during preflight", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-token-"));
    const pluginRoot = await createMcpPlugin(baseCwd, "plugin", "token-plugin", {
      args: ["${env:HOME}", "${unknown}"],
      command: "${pluginRoot}/server.mjs",
    });
    await writeFile(path.join(pluginRoot, "server.mjs"), "export default {};\n", "utf8");

    const error = await capturePreflightError(baseCwd, [
      { enabled: true, path: "./plugin" },
    ]);

    expect(error.issues).toEqual([
      expect.objectContaining({
        field: "mcpServers",
        message: expect.stringContaining('"${env:HOME}"'),
      }),
      expect.objectContaining({
        field: "mcpServers",
        message: expect.stringContaining('"${unknown}"'),
      }),
    ]);
  });

  it("rejects final MCP names that cannot be sent as OpenAI functions", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-tool-name-"));
    const pluginRoot = await createMcpPlugin(baseCwd, "plugin", "name-plugin");
    await writeJson(path.join(pluginRoot, "mcp", "mcp.json"), {
      servers: { demo: { command: "node", tools: ["bad/name"] } },
    });

    const error = await capturePreflightError(baseCwd, [{ enabled: true, path: "./plugin" }]);

    expect(error.issues).toEqual([
      expect.objectContaining({
        field: "mcpServers",
        message: expect.stringContaining("OpenAI function name pattern"),
      }),
    ]);
  });

  it("synthesizes ask/unknown when the host has no policy for a declared plugin tool", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-fallback-policy-"));
    await createMcpPlugin(baseCwd, "plugin", "fallback-plugin");

    const result = await preflightPlugins({
      baseCwd,
      config: { plugins: [{ enabled: true, path: "./plugin" }] },
    });

    expect(result.plugins[0]?.mcpServers[0]?.tools[0]?.policy).toEqual({
      action: "ask",
      reason: 'No host policy configured for plugin MCP tool "mcp_fallback-plugin-demo_lookup".',
      risk: "unknown",
    });
  });

  it("allows different servers to reuse a raw tool name and routes by unique final names", async () => {
    const baseCwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-multi-server-"));
    const pluginRoot = await createMcpPlugin(baseCwd, "plugin", "multi-plugin");
    await writeJson(path.join(pluginRoot, "mcp", "mcp.json"), {
      servers: {
        alpha: { command: "node", tools: ["lookup"] },
        beta: { command: "node", tools: ["lookup"] },
      },
    });

    const result = await preflightPlugins({
      baseCwd,
      config: { plugins: [{ enabled: true, path: "./plugin" }] },
    });

    expect(result.plugins[0]?.mcpServers.map((server) => ({
      id: server.effectiveId,
      tool: server.tools[0]?.effectiveName,
    }))).toEqual([
      { id: "multi-plugin-alpha", tool: "mcp_multi-plugin-alpha_lookup" },
      { id: "multi-plugin-beta", tool: "mcp_multi-plugin-beta_lookup" },
    ]);
  });
});

interface TestPluginEntry {
  enabled: boolean;
  mcpPolicies?: Record<string, Record<string, {
    action: "allow" | "ask" | "deny";
    reason: string;
    risk: "inspect" | "mutating" | "destructive" | "unknown";
  }>>;
  path: string;
}

async function createSkillPlugin(baseCwd: string, directory: string, name: string): Promise<string> {
  const root = path.join(baseCwd, directory);
  await mkdir(path.join(root, ".forge-plugin"), { recursive: true });
  await mkdir(path.join(root, "skills", "sample"), { recursive: true });
  await writeJson(path.join(root, ".forge-plugin", "plugin.json"), {
    description: `${name} fixture`,
    name,
    skills: "./skills",
    version: "0.1.0",
  });
  await writeFile(
    path.join(root, "skills", "sample", "SKILL.md"),
    "---\ndescription: Sample skill.\n---\n\nUse the sample workflow.\n",
    "utf8",
  );
  return root;
}

async function createMcpPlugin(
  baseCwd: string,
  directory: string,
  name: string,
  overrides: { args?: string[]; command?: string } = {},
): Promise<string> {
  const root = path.join(baseCwd, directory);
  await mkdir(path.join(root, ".forge-plugin"), { recursive: true });
  await mkdir(path.join(root, "mcp"), { recursive: true });
  await writeJson(path.join(root, ".forge-plugin", "plugin.json"), {
    description: `${name} fixture`,
    mcpServers: "./mcp/mcp.json",
    name,
    version: "0.1.0",
  });
  await writeJson(path.join(root, "mcp", "mcp.json"), {
    servers: {
      demo: {
        args: overrides.args ?? [],
        command: overrides.command ?? "node",
        tools: ["lookup"],
      },
    },
  });
  return root;
}

async function capturePreflightError(
  baseCwd: string,
  plugins: TestPluginEntry[],
): Promise<PluginPreflightError> {
  try {
    await preflightPlugins({ baseCwd, config: { plugins } });
  } catch (error) {
    expect(error).toBeInstanceOf(PluginPreflightError);
    return error as PluginPreflightError;
  }

  throw new Error("expected plugin preflight to fail");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
