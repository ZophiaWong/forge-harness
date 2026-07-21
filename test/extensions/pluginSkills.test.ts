import { describe, expect, it } from "vitest";

import { mergePluginPromptAssets } from "../../src/extensions/pluginSkills.js";
import type { PluginDescriptor } from "../../src/extensions/pluginPreflight.js";

describe("mergePluginPromptAssets", () => {
  it("keeps sorted project skills first, then approved plugins in config and local-skill order", () => {
    const projectAssets = {
      projectMemory: "memory",
      skills: [
        { body: "a", description: "a", id: "alpha" },
        { body: "t", description: "t", id: "triage" },
      ],
    };
    const result = mergePluginPromptAssets(projectAssets, [
      plugin("second-plugin", 3, ["alpha", "zeta"]),
      plugin("first-plugin", 1, ["review"]),
    ]);

    expect(result.projectMemory).toBe("memory");
    expect(result.skills.map((skill) => skill.id)).toEqual([
      "alpha",
      "triage",
      "first-plugin:review",
      "second-plugin:alpha",
      "second-plugin:zeta",
    ]);
  });
});

function plugin(name: string, index: number, localIds: string[]): PluginDescriptor {
  return {
    configuredPath: `./${name}`,
    description: name,
    hooks: [],
    index,
    manifestPath: `/${name}/.forge-plugin/plugin.json`,
    mcpServers: [],
    name,
    root: `/${name}`,
    skills: localIds.map((localId) => ({
      body: localId,
      description: localId,
      id: `${name}:${localId}`,
      localId,
      sourcePath: `/${name}/skills/${localId}/SKILL.md`,
    })),
    version: "0.1.0",
  };
}
