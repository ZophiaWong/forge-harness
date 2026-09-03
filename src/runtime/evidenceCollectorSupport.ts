import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CapturedCommandEvidence {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

export async function captureBuild(
  buildSubject: (subjectRoot: string) => Promise<CapturedCommandEvidence>,
  subjectRoot: string,
): Promise<CapturedCommandEvidence> {
  try {
    return await buildSubject(subjectRoot);
  } catch {
    return {
      command: "npm run --silent build",
      exitCode: 1,
      signal: null,
      stderr: "collector could not start or complete the subject build",
      stdout: "",
    };
  }
}

export async function runCapturedCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<CapturedCommandEvidence> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      command: [command, ...args].join(" "),
      exitCode: 0,
      signal: null,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    if (isExecError(error)) {
      return {
        command: [command, ...args].join(" "),
        exitCode: typeof error.code === "number" ? error.code : null,
        signal: error.signal ?? null,
        stderr: typeof error.stderr === "string" ? error.stderr : "",
        stdout: typeof error.stdout === "string" ? error.stdout : "",
      };
    }
    throw error;
  }
}

export async function writeEvidenceJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function formatEvidenceTimestamp(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    "-",
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}

export function serializePrivateError(error: unknown): { message: string; name: string } {
  return error instanceof Error
    ? { message: error.message, name: error.name }
    : { message: String(error), name: "UnknownError" };
}

function isExecError(error: unknown): error is Error & {
  code?: number | string;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
} {
  return error instanceof Error;
}
