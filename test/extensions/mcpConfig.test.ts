import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadMcpProjectConfig } from "../../src/extensions/mcpConfig.js";

describe("loadMcpProjectConfig", () => {
  it("returns undefined when the project has no MCP config", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-config-"));

    await expect(loadMcpProjectConfig(cwd)).resolves.toBeUndefined();
  });

  it("loads a strict single-server config and applies timeout defaults", async () => {
    const cwd = await writeConfig({
      server: {
        command: "node",
        id: "demo",
        tools: {
          create_note: {
            action: "ask",
            reason: "writes demo notes",
            risk: "mutating",
          },
          lookup_issue: {
            action: "allow",
            reason: "reads demo issues",
            risk: "inspect",
          },
        },
      },
    });

    await expect(loadMcpProjectConfig(cwd)).resolves.toEqual({
      configPath: path.join(cwd, ".forge", "mcp.json"),
      server: {
        args: [],
        command: "node",
        connectTimeoutMs: 5_000,
        id: "demo",
        toolCallTimeoutMs: 30_000,
        tools: {
          create_note: {
            action: "ask",
            reason: "writes demo notes",
            risk: "mutating",
          },
          lookup_issue: {
            action: "allow",
            reason: "reads demo issues",
            risk: "inspect",
          },
        },
      },
    });
  });

  it("rejects unknown fields and invalid timeout values before startup", async () => {
    const cwd = await writeConfig({
      server: {
        command: "node",
        connectTimeoutMs: 0,
        env: { SECRET: "tracked-value" },
        id: "demo",
        tools: {
          lookup_issue: {
            action: "allow",
            reason: "reads demo issues",
            risk: "inspect",
          },
        },
      },
    });

    await expect(loadMcpProjectConfig(cwd)).rejects.toThrow(/Invalid MCP config.*connectTimeoutMs.*env/s);
  });

  it("rejects an empty tool allowlist", async () => {
    const cwd = await writeConfig({
      server: {
        command: "node",
        id: "demo",
        tools: {},
      },
    });

    await expect(loadMcpProjectConfig(cwd)).rejects.toThrow(/at least one configured tool/);
  });

  it("accepts an explicit deny policy without exposing authority by default", async () => {
    const cwd = await writeConfig({
      server: {
        command: "node",
        id: "demo",
        tools: {
          delete_issue: {
            action: "deny",
            reason: "the tutorial host never grants deletion",
            risk: "destructive",
          },
        },
      },
    });

    await expect(loadMcpProjectConfig(cwd)).resolves.toMatchObject({
      server: {
        tools: {
          delete_issue: { action: "deny" },
        },
      },
    });
  });
});

async function writeConfig(config: unknown): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-config-"));
  const forgeDir = path.join(cwd, ".forge");
  await mkdir(forgeDir, { recursive: true });
  await writeFile(path.join(forgeDir, "mcp.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return cwd;
}
