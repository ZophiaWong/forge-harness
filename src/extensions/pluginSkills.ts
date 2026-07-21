import type { PromptAssets } from "../context/promptAssembly.js";
import type { PluginDescriptor } from "./pluginPreflight.js";

export function mergePluginPromptAssets(
  projectAssets: PromptAssets,
  approvedPlugins: Array<Pick<PluginDescriptor, "index" | "skills">>,
): PromptAssets {
  const plugins = [...approvedPlugins].sort((left, right) => left.index - right.index);

  return {
    ...(projectAssets.projectMemory ? { projectMemory: projectAssets.projectMemory } : {}),
    skills: [
      ...projectAssets.skills,
      ...plugins.flatMap((plugin) => [...plugin.skills].sort(
        (left, right) => compareStrings(left.localId, right.localId),
      )),
    ],
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
