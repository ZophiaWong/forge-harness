import type { McpServerConfig } from "./mcpConfig.js";
import type { PluginDescriptor, PluginMcpServerDescriptor } from "./pluginPreflight.js";

export interface ResolvedPluginMcpServerDescriptor {
  cwd: string;
  declared: PluginMcpServerDescriptor;
  server: McpServerConfig;
}

export interface ResolvedPluginDescriptor extends Omit<PluginDescriptor, "mcpServers"> {
  mcpServers: ResolvedPluginMcpServerDescriptor[];
}

export function resolvePluginDescriptors(
  plugins: PluginDescriptor[],
  projectRoot: string,
): ResolvedPluginDescriptor[] {
  return plugins.map((plugin) => deepFreeze({
    ...plugin,
    hooks: plugin.hooks.map((hook) => ({ ...hook, events: [...hook.events] })),
    mcpServers: plugin.mcpServers.map((descriptor) => ({
      cwd: projectRoot,
      declared: {
        ...descriptor,
        args: [...descriptor.args],
        tools: descriptor.tools.map((tool) => ({ ...tool, policy: { ...tool.policy } })),
      },
      server: {
        args: descriptor.args.map((argument) => resolveTokens(argument, plugin.root, projectRoot)),
        command: resolveTokens(descriptor.command, plugin.root, projectRoot),
        connectTimeoutMs: descriptor.connectTimeoutMs,
        id: descriptor.effectiveId,
        toolCallTimeoutMs: descriptor.toolCallTimeoutMs,
        tools: Object.fromEntries(descriptor.tools.map((tool) => [tool.rawName, { ...tool.policy }])),
      },
    })),
    skills: plugin.skills.map((skill) => ({ ...skill })),
  }));
}

function resolveTokens(value: string, pluginRoot: string, projectRoot: string): string {
  return value
    .replaceAll("${pluginRoot}", pluginRoot)
    .replaceAll("${projectRoot}", projectRoot);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}
