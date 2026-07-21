import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { activatePluginHooks } from "../../src/extensions/pluginHooks.js";
import type { PluginDescriptor, PluginHookDescriptor } from "../../src/extensions/pluginPreflight.js";

describe("activatePluginHooks", () => {
  it("imports approved hooks in plugin and registry order as frozen-clone observers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-hooks-"));
    const firstPath = await hookModule(directory, "first", "first");
    const secondPath = await hookModule(directory, "second", "second");
    const thirdPath = await hookModule(directory, "third", "third");
    const result = await activatePluginHooks([
      plugin("later", 4, [hook("later:a", thirdPath)]),
      plugin("earlier", 1, [hook("earlier:a", firstPath), hook("earlier:b", secondPath)]),
    ]);
    const handled: string[] = [];
    (globalThis as { __forgePluginHookTest?: string[] }).__forgePluginHookTest = handled;

    for (const lifecycleHook of result.hooks) {
      await lifecycleHook.handle({
        answer: "done",
        round: 1,
        type: "final_answer",
      });
    }

    expect(result.failures).toEqual([]);
    expect(result.hooks.map((item) => item.name)).toEqual(["earlier:a", "earlier:b", "later:a"]);
    expect(result.hooks.every((item) => item.eventMode === "frozen-clone")).toBe(true);
    expect(handled).toEqual(["first", "second", "third"]);
    delete (globalThis as { __forgePluginHookTest?: string[] }).__forgePluginHookTest;
  });

  it("records import and export failures while continuing with later hooks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "forge-plugin-hooks-fail-"));
    const invalidPath = path.join(directory, "invalid.mjs");
    const validPath = await hookModule(directory, "valid", "valid");
    await writeFile(invalidPath, "export default { handle: true };\n", "utf8");

    const result = await activatePluginHooks([
      plugin("demo", 0, [
        hook("demo:missing", path.join(directory, "missing.mjs")),
        hook("demo:invalid", invalidPath),
        hook("demo:valid", validPath),
      ]),
    ]);

    expect(result.hooks.map((item) => item.name)).toEqual(["demo:valid"]);
    expect(result.failures).toEqual([
      expect.objectContaining({ hookName: "demo:missing", reason: expect.stringContaining("Cannot find module") }),
      { hookName: "demo:invalid", reason: "hook module default export must be a function" },
    ]);
  });
});

function plugin(name: string, index: number, hooks: PluginHookDescriptor[]): PluginDescriptor {
  return {
    configuredPath: `./${name}`,
    description: name,
    hooks,
    index,
    manifestPath: `/${name}/.forge-plugin/plugin.json`,
    mcpServers: [],
    name,
    root: `/${name}`,
    skills: [],
    version: "0.1.0",
  };
}

function hook(effectiveName: string, entryPath: string): PluginHookDescriptor {
  return {
    effectiveName,
    entryPath,
    events: ["final_answer"],
    localName: effectiveName.split(":")[1] ?? effectiveName,
  };
}

async function hookModule(directory: string, name: string, marker: string): Promise<string> {
  const filePath = path.join(directory, `${name}.mjs`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `export default function () { globalThis.__forgePluginHookTest?.push(${JSON.stringify(marker)}); }\n`,
    "utf8",
  );
  return filePath;
}
