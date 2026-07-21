import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadPluginProjectConfig } from "../../src/extensions/pluginConfig.js";

describe("loadPluginProjectConfig", () => {
  it("treats a missing .forge/plugins.json as an empty plugin list", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-config-"));

    await expect(loadPluginProjectConfig(cwd)).resolves.toEqual({ plugins: [] });
  });

  it("treats an empty plugins.json file as no plugins", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-config-"));
    await mkdir(path.join(cwd, ".forge"), { recursive: true });
    await writeFile(path.join(cwd, ".forge", "plugins.json"), "  \n", "utf8");

    await expect(loadPluginProjectConfig(cwd)).resolves.toEqual({ plugins: [] });
  });

  it("parses enabled entries and host-owned MCP policies", async () => {
    const cwd = await writeConfig({
      plugins: [{
        enabled: true,
        mcpPolicies: {
          demo: {
            create_note: {
              action: "ask",
              reason: "writes a project note",
              risk: "mutating",
            },
            lookup_issue: {
              action: "allow",
              reason: "reads deterministic issue data",
              risk: "inspect",
            },
          },
        },
        path: "./examples/plugins/issue-workflow",
      }],
    });

    await expect(loadPluginProjectConfig(cwd)).resolves.toEqual({
      plugins: [{
        enabled: true,
        mcpPolicies: {
          demo: {
            create_note: {
              action: "ask",
              reason: "writes a project note",
              risk: "mutating",
            },
            lookup_issue: {
              action: "allow",
              reason: "reads deterministic issue data",
              risk: "inspect",
            },
          },
        },
        path: "./examples/plugins/issue-workflow",
      }],
    });
  });

  it("rejects unknown project-entry and policy fields", async () => {
    const cwd = await writeConfig({
      plugins: [{
        enabled: true,
        env: { SECRET: "not allowed" },
        mcpPolicies: {
          demo: {
            lookup: {
              action: "allow",
              reason: "read",
              risk: "inspect",
              scope: "unexpected",
            },
          },
        },
        path: "./plugin",
      }],
    });

    await expect(loadPluginProjectConfig(cwd)).rejects.toThrow(/plugins\.0.*env|scope/s);
  });
});

async function writeConfig(config: unknown): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-config-"));
  const forgeDir = path.join(cwd, ".forge");
  await mkdir(forgeDir, { recursive: true });
  await writeFile(path.join(forgeDir, "plugins.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return cwd;
}
