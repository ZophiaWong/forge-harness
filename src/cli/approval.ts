import { createInterface } from "node:readline/promises";

import type { ApprovalRequest, PermissionApprover } from "../governance/types.js";

export interface CliApproverOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export function createCliApprover(options: CliApproverOptions = {}): PermissionApprover {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  return {
    async approve(request) {
      if (!input.isTTY || !output.isTTY) {
        return {
          approved: false,
          reason: "approval requires an interactive terminal",
        };
      }

      const readline = createInterface({ input, output });

      try {
        writeApprovalPrompt(output, request);
        const answer = await readline.question("[y/N]: ");
        const approved = /^(?:y|yes)$/i.test(answer.trim());

        if (approved) {
          return { approved: true };
        }

        return {
          approved: false,
          reason: "approval rejected by user",
        };
      } finally {
        readline.close();
      }
    },
  };
}

function writeApprovalPrompt(output: NodeJS.WriteStream, request: ApprovalRequest): void {
  output.write(`Approve ${request.toolCall.name} command?\n`);

  const command = parseCommand(request.toolCall.arguments);

  if (command) {
    output.write(`command: ${command}\n`);
  } else {
    output.write(`arguments: ${request.toolCall.arguments}\n`);
  }
}

function parseCommand(rawArguments: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "command" in parsed &&
      typeof parsed.command === "string" &&
      parsed.command.trim().length > 0
    ) {
      return parsed.command;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
