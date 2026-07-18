import { createInterface } from "node:readline/promises";

import type { McpProjectConfig } from "../extensions/mcpConfig.js";

export interface McpServerTrustRequest {
  baseCwd: string;
  config: McpProjectConfig;
}

export interface McpServerTrustResult {
  approved: boolean;
  reason?: string;
}

export interface McpServerTrustApprover {
  approve(request: McpServerTrustRequest): Promise<McpServerTrustResult>;
}

export interface CliMcpServerTrustApproverOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export function createCliMcpServerTrustApprover(
  options: CliMcpServerTrustApproverOptions = {},
): McpServerTrustApprover {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  return {
    async approve(request) {
      if (!input.isTTY || !output.isTTY) {
        return {
          approved: false,
          reason: "MCP server startup requires an interactive terminal",
        };
      }

      const readline = createInterface({ input, output });

      try {
        writeTrustPrompt(output, request);
        const answer = await readline.question("[y/N]: ");

        if (/^(?:y|yes)$/i.test(answer.trim())) {
          return { approved: true };
        }

        return {
          approved: false,
          reason: "MCP server startup rejected by user",
        };
      } finally {
        readline.close();
      }
    },
  };
}

function writeTrustPrompt(output: NodeJS.WriteStream, request: McpServerTrustRequest): void {
  const { config } = request;
  const server = config.server;
  output.write("Start project MCP server for this session?\n");
  output.write(`config: ${config.configPath}\n`);
  output.write(`server: ${server.id}\n`);
  output.write(`command: ${[server.command, ...server.args].map((part) => JSON.stringify(part)).join(" ")}\n`);
  output.write(`cwd: ${request.baseCwd}\n`);
  output.write(`connect_timeout_ms: ${server.connectTimeoutMs}\n`);
  output.write(`tool_call_timeout_ms: ${server.toolCallTimeoutMs}\n`);
  output.write("tools:\n");

  for (const [toolName, policy] of Object.entries(server.tools).sort(([left], [right]) => left.localeCompare(right))) {
    output.write(`  ${toolName}: ${policy.action} risk=${policy.risk} reason=${policy.reason}\n`);
  }
}
