import { spawn } from "node:child_process";

import { DEFAULT_TEXT_OUTPUT_CHAR_LIMIT, truncateText } from "./text.js";
import type { RegisteredTool, ToolDefinition } from "./types.js";
import type { BackgroundTaskManager } from "../runtime/backgroundTasks.js";

export const DEFAULT_BASH_TIMEOUT_MS = 20_000;
export const DEFAULT_BACKGROUND_BASH_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_CHAR_LIMIT = DEFAULT_TEXT_OUTPUT_CHAR_LIMIT;

export type BashExecutionStatus = "completed" | "blocked" | "timed_out" | "canceled";

export interface BashExecutionResult {
  command: string;
  durationMs: number;
  exitCode: number | null;
  status: BashExecutionStatus;
  stderr: string;
  stdout: string;
  blockedReason?: string;
}

export interface BashCommandHandle {
  cancel(): void;
  promise: Promise<BashExecutionResult>;
}

export interface BashExecutionOptions {
  cwd: string;
  outputCharLimit?: number;
  timeoutMs?: number;
}

interface BashToolArguments {
  command: string;
  runInBackground: boolean;
}

export interface BashToolOptions {
  backgroundTasks?: BackgroundTaskManager;
}

interface DangerousCommandPattern {
  pattern: RegExp;
  reason: string;
}

const BASH_TOOL_NAME = "bash";

const DANGEROUS_COMMAND_PATTERNS: DangerousCommandPattern[] = [
  {
    pattern: /\brm\b(?=[^\n;&|]*-[^\n;&|]*r)(?=[^\n;&|]*-[^\n;&|]*f)/i,
    reason: "rm -rf is blocked in the minimal loop",
  },
  {
    pattern: /\bsudo\b/i,
    reason: "sudo is blocked in the minimal loop",
  },
  {
    pattern: /\bmkfs(?:\.[\w-]+)?\b/i,
    reason: "mkfs is blocked in the minimal loop",
  },
  {
    pattern: /\bshutdown\b/i,
    reason: "shutdown is blocked in the minimal loop",
  },
  {
    pattern: /\breboot\b/i,
    reason: "reboot is blocked in the minimal loop",
  },
  {
    pattern: /\bpoweroff\b/i,
    reason: "poweroff is blocked in the minimal loop",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "git reset --hard is blocked in the minimal loop",
  },
  {
    pattern: /\bgit\s+clean\b(?=[^\n;&|]*-[^\n;&|]*f)/i,
    reason: "git clean with force is blocked in the minimal loop",
  },
];

const SECRET_ENV_NAME_PATTERN =
  /(?:^|_)(?:API_KEY|AUTH|CREDENTIAL|CREDENTIALS|PASSWORD|PRIVATE_KEY|SECRET|SESSION|TOKEN)(?:_|$)/i;

export const bashToolDefinition: ToolDefinition = createBashToolDefinition({ backgroundEnabled: false });

export function createBashTool(cwd: string, options: BashToolOptions = {}): RegisteredTool {
  return {
    definition: createBashToolDefinition({ backgroundEnabled: options.backgroundTasks !== undefined }),
    async handler({ rawArguments }) {
      const args = parseBashToolArguments(rawArguments);

      if (!args) {
        return {
          content: "failed_reason: bash arguments must be JSON with a non-empty string command field",
          status: "failed",
          toolName: BASH_TOOL_NAME,
        };
      }

      if (args.runInBackground) {
        if (!options.backgroundTasks) {
          return {
            content: "failed_reason: bash.runInBackground is not supported by this tool runtime",
            status: "failed",
            toolName: BASH_TOOL_NAME,
          };
        }

        const blockedReason = findDangerousCommandReason(args.command);

        if (blockedReason) {
          return {
            content: formatBashResultForModel({
              blockedReason,
              command: args.command,
              durationMs: 0,
              exitCode: null,
              status: "blocked",
              stderr: blockedReason,
              stdout: "",
            }),
            metadata: {
              command: args.command,
              observationSummary: "bash blocked",
            },
            status: "blocked",
            toolName: BASH_TOOL_NAME,
          };
        }

        const task = options.backgroundTasks.startBash({
          command: args.command,
          cwd,
          timeoutMs: DEFAULT_BACKGROUND_BASH_TIMEOUT_MS,
        });

        return {
          content: formatBackgroundStartResult(task),
          metadata: {
            backgroundTask: task,
            command: args.command,
            observationSummary: "bash background task started",
          },
          status: "completed",
          toolName: BASH_TOOL_NAME,
        };
      }

      const result = await runBashCommand(args.command, { cwd });

      return {
        content: formatBashResultForModel(result),
        metadata: {
          command: result.command,
          exitCode: result.exitCode,
        },
        status: result.status === "canceled" ? "failed" : result.status,
        toolName: BASH_TOOL_NAME,
      };
    },
  };
}

function createBashToolDefinition(options: { backgroundEnabled: boolean }): ToolDefinition {
  return {
    type: "function",
    name: BASH_TOOL_NAME,
    description: options.backgroundEnabled
      ? "Run one bash command in the current project directory. Use runInBackground only for explicitly requested long-running background work."
      : "Run one bash command in the current project directory and return stdout, stderr, and exit code.",
    strict: !options.backgroundEnabled,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "The bash command to run.",
        },
        ...(options.backgroundEnabled
          ? {
              runInBackground: {
                type: "boolean",
                description:
                  "Set to true only when the command should keep running while the foreground loop continues.",
              },
            }
          : {}),
      },
      required: ["command"],
    },
  };
}

export function createBashEnvironment(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined || SECRET_ENV_NAME_PATTERN.test(key)) {
      continue;
    }

    env[key] = value;
  }

  return env;
}

export function findDangerousCommandReason(command: string): string | undefined {
  const normalized = command.trim();
  const match = DANGEROUS_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  return match?.reason;
}

export function truncateOutput(output: string, limit: number): string {
  return truncateText(output, limit);
}

export function formatBashResultForModel(result: BashExecutionResult): string {
  const lines = [
    `status: ${result.status}`,
    `command: ${result.command}`,
    `exit_code: ${result.exitCode === null ? "null" : result.exitCode}`,
    `duration_ms: ${result.durationMs}`,
  ];

  if (result.blockedReason) {
    lines.push(`blocked_reason: ${result.blockedReason}`);
  }

  lines.push("stdout:", result.stdout || "(empty)", "stderr:", result.stderr || "(empty)");
  return lines.join("\n");
}

export async function runBashCommand(
  command: string,
  options: BashExecutionOptions,
): Promise<BashExecutionResult> {
  return startBashCommand(command, options).promise;
}

export function startBashCommand(command: string, options: BashExecutionOptions): BashCommandHandle {
  const startedAt = Date.now();
  const blockedReason = findDangerousCommandReason(command);

  if (blockedReason) {
    return {
      cancel() {
        return undefined;
      },
      promise: Promise.resolve({
        blockedReason,
        command,
        durationMs: Date.now() - startedAt,
        exitCode: null,
        status: "blocked",
        stderr: blockedReason,
        stdout: "",
      }),
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const outputCharLimit = options.outputCharLimit ?? DEFAULT_OUTPUT_CHAR_LIMIT;

  let cancel: () => void = () => undefined;
  const promise = new Promise<BashExecutionResult>((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      detached: true,
      env: createBashEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stdoutOmittedChars = 0;
    let stderr = "";
    let stderrOmittedChars = 0;
    let settled = false;
    let terminalStatus: Extract<BashExecutionStatus, "timed_out" | "canceled"> | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      requestTermination("timed_out");
    }, timeoutMs);
    timer.unref();

    const clearTimers = (): void => {
      clearTimeout(timer);

      if (killTimer) {
        clearTimeout(killTimer);
      }
    };

    const finish = (result: BashExecutionResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      resolve(result);
    };

    const requestTermination = (status: Extract<BashExecutionStatus, "timed_out" | "canceled">): void => {
      if (settled || terminalStatus) {
        return;
      }

      terminalStatus = status;
      killProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(child.pid, "SIGKILL");
      }, 1_000);
      killTimer.unref();
    };

    cancel = () => {
      requestTermination("canceled");
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendCapped(stdout, stdoutOmittedChars, chunk, outputCharLimit);
      stdout = next.value;
      stdoutOmittedChars = next.omittedChars;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendCapped(stderr, stderrOmittedChars, chunk, outputCharLimit);
      stderr = next.value;
      stderrOmittedChars = next.omittedChars;
    });

    child.on("error", (error) => {
      finish({
        command,
        durationMs: Date.now() - startedAt,
        exitCode: null,
        status: terminalStatus ?? "completed",
        stderr: finalizeTerminatedStderr(error.message, stderrOmittedChars, terminalStatus, timeoutMs),
        stdout: finalizeOutput(stdout, stdoutOmittedChars),
      });
    });

    child.on("close", (code) => {
      finish({
        command,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        status: terminalStatus ?? "completed",
        stderr: finalizeTerminatedStderr(stderr, stderrOmittedChars, terminalStatus, timeoutMs),
        stdout: finalizeOutput(stdout, stdoutOmittedChars),
      });
    });
  });

  return { cancel, promise };
}

function parseBashToolArguments(rawArguments: string): BashToolArguments | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "command" in parsed &&
      typeof parsed.command === "string" &&
      parsed.command.trim().length > 0
    ) {
      return {
        command: parsed.command,
        runInBackground: "runInBackground" in parsed && parsed.runInBackground === true,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function appendCapped(
  current: string,
  omittedChars: number,
  chunk: Buffer,
  limit: number,
): { value: string; omittedChars: number } {
  const text = chunk.toString("utf8");
  const remaining = Math.max(limit - current.length, 0);
  const visible = text.slice(0, remaining);
  const omitted = text.length - visible.length;

  return {
    value: current + visible,
    omittedChars: omittedChars + omitted,
  };
}

function finalizeOutput(output: string, omittedChars: number): string {
  if (omittedChars === 0) {
    return output;
  }

  return `${output}\n[truncated ${omittedChars} chars]`;
}

function finalizeTerminatedStderr(
  stderr: string,
  omittedChars: number,
  status: Extract<BashExecutionStatus, "timed_out" | "canceled"> | undefined,
  timeoutMs: number,
): string {
  const output = finalizeOutput(stderr, omittedChars);

  if (status === "timed_out") {
    return `${output}\n[timed out after ${timeoutMs}ms]`.trim();
  }

  if (status === "canceled") {
    return `${output}\n[canceled]`.trim();
  }

  return output;
}

function formatBackgroundStartResult(task: { command: string; id: string; kind: string }): string {
  return [
    "status: background_started",
    `background_task_id: ${task.id}`,
    `kind: ${task.kind}`,
    `command: ${task.command}`,
    "result: task is still running; a task notification will be injected when it completes",
  ].join("\n");
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process may have exited between timeout and cleanup.
    }
  }
}
