import { formatBashResultForModel, runBashCommand } from "../tools/bashTool.js";

export type VerificationStatus = "passed" | "failed" | "blocked";

export interface VerificationContext {
  candidateAnswer: string;
  cwd?: string;
  round: number;
  task: string;
}

export interface VerificationResult {
  command?: string;
  exitCode?: number | null;
  name: string;
  recoverable: boolean;
  status: VerificationStatus;
  summary: string;
}

export interface Verifier {
  verify(context: VerificationContext): Promise<VerificationResult>;
}

export interface CommandVerifierOptions {
  command: string;
  cwd: string;
  outputCharLimit?: number;
  timeoutMs?: number;
}

export function createCommandVerifier(options: CommandVerifierOptions): Verifier {
  return {
    async verify() {
      const result = await runBashCommand(options.command, {
        cwd: options.cwd,
        ...(options.outputCharLimit !== undefined ? { outputCharLimit: options.outputCharLimit } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      const passed = result.status === "completed" && result.exitCode === 0;
      const status: VerificationStatus = passed ? "passed" : result.status === "blocked" ? "blocked" : "failed";

      return {
        command: result.command,
        exitCode: result.exitCode,
        name: "command",
        recoverable: status === "failed",
        status,
        summary: formatBashResultForModel(result),
      };
    },
  };
}
