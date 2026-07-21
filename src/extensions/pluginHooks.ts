import { pathToFileURL } from "node:url";

import type { LifecycleHook } from "./lifecycle.js";
import type { PluginDescriptor } from "./pluginPreflight.js";

export interface PluginHookActivationFailure {
  hookName: string;
  reason: string;
}

export interface PluginHookActivationResult {
  failures: PluginHookActivationFailure[];
  hooks: LifecycleHook[];
}

export async function activatePluginHooks(
  approvedPlugins: Array<Pick<PluginDescriptor, "hooks" | "index">>,
): Promise<PluginHookActivationResult> {
  const hooks: LifecycleHook[] = [];
  const failures: PluginHookActivationFailure[] = [];
  const plugins = [...approvedPlugins].sort((left, right) => left.index - right.index);

  for (const plugin of plugins) {
    for (const descriptor of plugin.hooks) {
      try {
        const module: { default?: unknown } = await import(pathToFileURL(descriptor.entryPath).href);

        if (typeof module.default !== "function") {
          throw new Error("hook module default export must be a function");
        }

        hooks.push({
          eventMode: "frozen-clone",
          events: [...descriptor.events],
          handle: module.default as LifecycleHook["handle"],
          name: descriptor.effectiveName,
        });
      } catch (error) {
        failures.push({
          hookName: descriptor.effectiveName,
          reason: formatError(error),
        });
      }
    }
  }

  return { failures, hooks };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
