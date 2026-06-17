import { spawn } from "node:child_process";

export const DEFAULT_BASH_TIMEOUT_MS = 20_000;
export const DEFAULT_OUTPUT_CHAR_LIMIT = 20_000;

export type BashExecutionStatus = "completed" | "blocked" | "timed_out";

export interface BashExecutionResult {
  command: string;
  durationMs: number;
  exitCode: number | null;
  status: BashExecutionStatus;
  stderr: string;
  stdout: string;
  blockedReason?: string;
}

export interface BashExecutionOptions {
  cwd: string;
  outputCharLimit?: number;
  timeoutMs?: number;
}

interface DangerousCommandPattern {
  pattern: RegExp;
  reason: string;
}

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
  if (limit < 0) {
    throw new Error("output limit must be non-negative.");
  }

  if (output.length <= limit) {
    return output;
  }

  const omitted = output.length - limit;
  return `${output.slice(0, limit)}\n[truncated ${omitted} chars]`;
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
  const startedAt = Date.now();
  const blockedReason = findDangerousCommandReason(command);

  if (blockedReason) {
    return {
      command,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      status: "blocked",
      stderr: blockedReason,
      stdout: "",
      blockedReason,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const outputCharLimit = options.outputCharLimit ?? DEFAULT_OUTPUT_CHAR_LIMIT;

  return new Promise((resolve) => {
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
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(child.pid, "SIGKILL");
      }, 1_000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();

    const clearTimers = (): void => {
      clearTimeout(timer);

      if (killTimer) {
        clearTimeout(killTimer);
      }
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
      clearTimers();
      resolve({
        command,
        durationMs: Date.now() - startedAt,
        exitCode: null,
        status: timedOut ? "timed_out" : "completed",
        stderr: finalizeOutput(error.message, stderrOmittedChars),
        stdout: finalizeOutput(stdout, stdoutOmittedChars),
      });
    });

    child.on("close", (code) => {
      clearTimers();
      const finalStderr = timedOut
        ? `${finalizeOutput(stderr, stderrOmittedChars)}\n[timed out after ${timeoutMs}ms]`.trim()
        : finalizeOutput(stderr, stderrOmittedChars);

      resolve({
        command,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        status: timedOut ? "timed_out" : "completed",
        stderr: finalStderr,
        stdout: finalizeOutput(stdout, stdoutOmittedChars),
      });
    });
  });
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

