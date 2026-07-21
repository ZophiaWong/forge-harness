import { createInterface } from "node:readline/promises";

import type { ResolvedPluginDescriptor } from "../extensions/pluginDescriptors.js";

export interface PluginTrustRequest {
  descriptor: ResolvedPluginDescriptor;
}

export interface PluginTrustResult {
  approved: boolean;
  reason?: string;
}

export interface PluginTrustApprover {
  approve(request: PluginTrustRequest): Promise<PluginTrustResult>;
}

export interface CliPluginTrustApproverOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export function createCliPluginTrustApprover(
  options: CliPluginTrustApproverOptions = {},
): PluginTrustApprover {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  return {
    async approve(request) {
      if (!input.isTTY || !output.isTTY) {
        return {
          approved: false,
          reason: "Plugin activation requires an interactive terminal",
        };
      }

      const readline = createInterface({ input, output });

      try {
        writePluginTrustPrompt(output, request.descriptor);
        const answer = await readline.question("[y/N]: ");

        if (/^(?:y|yes)$/i.test(answer.trim())) {
          return { approved: true };
        }

        return {
          approved: false,
          reason: "Plugin activation rejected by user",
        };
      } finally {
        readline.close();
      }
    },
  };
}

export function writePluginTrustPrompt(
  output: Pick<NodeJS.WriteStream, "write">,
  descriptor: ResolvedPluginDescriptor,
): void {
  output.write("Activate local plugin for this session?\n");
  output.write(`plugin: ${descriptor.name}@${descriptor.version}\n`);
  output.write(`description: ${formatPromptString(descriptor.description)}\n`);
  output.write(`canonical_root: ${formatPromptString(descriptor.root)}\n`);
  output.write("skills:\n");
  for (const skill of descriptor.skills) {
    output.write(`  skill ${skill.id}: ${formatPromptString(skill.sourcePath)}\n`);
  }
  output.write("hooks:\n");
  for (const hook of descriptor.hooks) {
    output.write(
      `  hook ${hook.effectiveName}: events=${hook.events.join(",")} entry=${formatPromptString(hook.entryPath)}\n`,
    );
  }
  output.write("mcp_servers:\n");

  for (const resolved of descriptor.mcpServers) {
    output.write(`  server ${resolved.server.id}:\n`);
    output.write(
      `    command: ${[resolved.server.command, ...resolved.server.args].map(formatPromptString).join(" ")}\n`,
    );
    output.write(`    cwd: ${formatPromptString(resolved.cwd)}\n`);
    output.write(`    connect_timeout_ms: ${resolved.server.connectTimeoutMs}\n`);
    output.write(`    tool_call_timeout_ms: ${resolved.server.toolCallTimeoutMs}\n`);
    output.write("    tools:\n");
    for (const tool of resolved.declared.tools) {
      output.write(
        `      ${tool.effectiveName}: ${tool.policy.action} risk=${tool.policy.risk} reason=${formatPromptString(tool.policy.reason)}\n`,
      );
    }
  }
}

function formatPromptString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
