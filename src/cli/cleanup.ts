import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

import {
  cleanupRunArtifacts,
  inspectRunArtifacts,
  type RunArtifactCleanupResult,
  type RunArtifactInventory,
} from "../runtime/runArtifactCleanup.js";

const CLEANUP_USAGE = "Usage: npm run clean:runs -- [--yes]";

export type CleanupCliArgs = { yes: boolean } | { error: string };

export function parseCleanupArgs(args: string[]): CleanupCliArgs {
  if (args.length === 0) {
    return { yes: false };
  }
  if (args.length === 1 && args[0] === "--yes") {
    return { yes: true };
  }
  return { error: CLEANUP_USAGE };
}

export function isConfirmedAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

export async function runCleanupCli(options: {
  args: string[];
  cwd: string;
  stdinIsTTY: boolean;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  inspect?: typeof inspectRunArtifacts;
  cleanup?: typeof cleanupRunArtifacts;
  confirm?: () => Promise<boolean>;
}): Promise<number> {
  const parsed = parseCleanupArgs(options.args);
  if ("error" in parsed) {
    options.stderr.write(`${parsed.error}\n`);
    return 1;
  }

  const inspect = options.inspect ?? inspectRunArtifacts;
  const cleanup = options.cleanup ?? cleanupRunArtifacts;
  const inventory = await inspect({ cwd: options.cwd });
  if (!inventory.hasArtifacts) {
    options.stdout.write("nothing to clean\n");
    return 0;
  }

  printInventory(options.stdout, inventory);
  if (!parsed.yes) {
    if (!options.stdinIsTTY) {
      options.stderr.write("cleanup requires an interactive terminal or --yes\n");
      return 1;
    }
    if (!(await options.confirm?.())) {
      options.stdout.write("cleanup canceled\n");
      return 0;
    }
  }

  const result = await cleanup({ cwd: options.cwd });
  if (result.failures.length > 0) {
    printFailures(options.stderr, result);
    return 1;
  }

  const removedRootCount =
    Number(result.sessionsRemoved) + Number(result.worktreesRootRemoved);
  options.stdout.write(`removed registered worktrees: ${result.removedWorktrees.length}\n`);
  options.stdout.write(`removed generated roots: ${removedRootCount}\n`);
  return 0;
}

function printInventory(
  output: { write(chunk: string): unknown },
  inventory: RunArtifactInventory,
): void {
  output.write(`sessions: ${inventory.sessionCount}\n`);
  output.write(`registered worktrees: ${inventory.registeredWorktrees.length}\n`);
  output.write(`worktree root entries: ${inventory.worktreeRootEntryCount}\n`);
}

function printFailures(
  output: { write(chunk: string): unknown },
  result: RunArtifactCleanupResult,
): void {
  for (const failure of result.failures) {
    output.write(
      `cleanup failed: ${failure.operation} ${failure.path}: ${failure.message}\n`,
    );
  }
}

async function confirmCleanup(): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return isConfirmedAnswer(await readline.question("Delete these run artifacts? [y/N] "));
  } finally {
    readline.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    process.exitCode = await runCleanupCli({
      args: process.argv.slice(2),
      cleanup: cleanupRunArtifacts,
      confirm: confirmCleanup,
      cwd: process.cwd(),
      inspect: inspectRunArtifacts,
      stderr: process.stderr,
      stdinIsTTY: Boolean(process.stdin.isTTY),
      stdout: process.stdout,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`cleanup failed: ${message}\n`);
    process.exitCode = 1;
  }
}
