import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isConfirmedAnswer,
  parseCleanupArgs,
  runCleanupCli,
} from "../../src/cli/cleanup.js";
import type {
  RunArtifactCleanupResult,
  RunArtifactInventory,
} from "../../src/runtime/runArtifactCleanup.js";

describe("parseCleanupArgs", () => {
  it("accepts the interactive default and --yes", () => {
    expect(parseCleanupArgs([])).toEqual({ yes: false });
    expect(parseCleanupArgs(["--yes"])).toEqual({ yes: true });
  });

  it("rejects duplicate, unknown, and positional arguments", () => {
    expect(parseCleanupArgs(["--yes", "--yes"])).toEqual({
      error: "Usage: npm run clean:runs -- [--yes]",
    });
    expect(parseCleanupArgs(["--force"])).toEqual({
      error: "Usage: npm run clean:runs -- [--yes]",
    });
    expect(parseCleanupArgs(["old-session"])).toEqual({
      error: "Usage: npm run clean:runs -- [--yes]",
    });
  });
});

describe("isConfirmedAnswer", () => {
  it("accepts only y and yes without regard to case or surrounding whitespace", () => {
    expect(isConfirmedAnswer("y")).toBe(true);
    expect(isConfirmedAnswer(" YES ")).toBe(true);
    expect(isConfirmedAnswer("")).toBe(false);
    expect(isConfirmedAnswer("no")).toBe(false);
  });
});

describe("runCleanupCli", () => {
  it("prints a successful no-op without prompting", async () => {
    const harness = createHarness(emptyInventory());

    const exitCode = await runCleanupCli(harness.options);

    expect(exitCode).toBe(0);
    expect(harness.stdout()).toBe("nothing to clean\n");
    expect(harness.confirmCalls()).toBe(0);
    expect(harness.cleanupCalls()).toBe(0);
  });

  it("shows counts and cancels on the interactive default answer", async () => {
    const harness = createHarness(populatedInventory(), { confirmed: false });

    const exitCode = await runCleanupCli(harness.options);

    expect(exitCode).toBe(0);
    expect(harness.stdout()).toContain("sessions: 2\n");
    expect(harness.stdout()).toContain("registered worktrees: 1\n");
    expect(harness.stdout()).toContain("worktree root entries: 1\n");
    expect(harness.stdout()).toContain("cleanup canceled\n");
    expect(harness.confirmCalls()).toBe(1);
    expect(harness.cleanupCalls()).toBe(0);
  });

  it("refuses non-interactive input unless --yes is present", async () => {
    const harness = createHarness(populatedInventory(), { stdinIsTTY: false });

    const exitCode = await runCleanupCli(harness.options);

    expect(exitCode).toBe(1);
    expect(harness.stderr()).toBe("cleanup requires an interactive terminal or --yes\n");
    expect(harness.confirmCalls()).toBe(0);
    expect(harness.cleanupCalls()).toBe(0);
  });

  it("uses --yes to skip confirmation and report success", async () => {
    const inventory = populatedInventory();
    const harness = createHarness(inventory, {
      args: ["--yes"],
      result: successfulResult(inventory),
      stdinIsTTY: false,
    });

    const exitCode = await runCleanupCli(harness.options);

    expect(exitCode).toBe(0);
    expect(harness.confirmCalls()).toBe(0);
    expect(harness.cleanupCalls()).toBe(1);
    expect(harness.stdout()).toContain("removed registered worktrees: 1\n");
    expect(harness.stdout()).toContain("removed generated roots: 2\n");
  });

  it("prints runtime failures and returns a failing exit code", async () => {
    const inventory = populatedInventory();
    const failurePath = inventory.registeredWorktrees[0]!;
    const harness = createHarness(inventory, {
      args: ["--yes"],
      result: {
        ...successfulResult(inventory),
        failures: [
          {
            message: "worktree is locked",
            operation: "remove_worktree",
            path: failurePath,
          },
        ],
        sessionsRemoved: false,
        worktreesRootRemoved: false,
      },
    });

    const exitCode = await runCleanupCli(harness.options);

    expect(exitCode).toBe(1);
    expect(harness.stderr()).toBe(
      `cleanup failed: remove_worktree ${failurePath}: worktree is locked\n`,
    );
  });

  it("returns a usage error before inspecting artifacts", async () => {
    const harness = createHarness(populatedInventory(), { args: ["unexpected"] });

    const exitCode = await runCleanupCli(harness.options);

    expect(exitCode).toBe(1);
    expect(harness.stderr()).toBe("Usage: npm run clean:runs -- [--yes]\n");
    expect(harness.inspectCalls()).toBe(0);
  });
});

function createHarness(
  inventory: RunArtifactInventory,
  overrides: {
    args?: string[];
    confirmed?: boolean;
    result?: RunArtifactCleanupResult;
    stdinIsTTY?: boolean;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  let confirmCalls = 0;
  let cleanupCalls = 0;
  let inspectCalls = 0;
  const result = overrides.result ?? successfulResult(inventory);

  return {
    cleanupCalls: () => cleanupCalls,
    confirmCalls: () => confirmCalls,
    inspectCalls: () => inspectCalls,
    options: {
      args: overrides.args ?? [],
      cwd: "/project",
      stdinIsTTY: overrides.stdinIsTTY ?? true,
      stdout: {
        write(chunk: string) {
          stdout += chunk;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
        },
      },
      async inspect() {
        inspectCalls += 1;
        return inventory;
      },
      async cleanup() {
        cleanupCalls += 1;
        return result;
      },
      async confirm() {
        confirmCalls += 1;
        return overrides.confirmed ?? true;
      },
    },
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

function emptyInventory(): RunArtifactInventory {
  return {
    hasArtifacts: false,
    registeredWorktrees: [],
    sessionCount: 0,
    sessionsRoot: path.join("/project", ".forge", "sessions"),
    worktreeRootEntryCount: 0,
    worktreesRoot: path.join("/project", ".forge", "worktrees"),
  };
}

function populatedInventory(): RunArtifactInventory {
  return {
    hasArtifacts: true,
    registeredWorktrees: [path.join("/project", ".forge", "worktrees", "run-session")],
    sessionCount: 2,
    sessionsRoot: path.join("/project", ".forge", "sessions"),
    worktreeRootEntryCount: 1,
    worktreesRoot: path.join("/project", ".forge", "worktrees"),
  };
}

function successfulResult(inventory: RunArtifactInventory): RunArtifactCleanupResult {
  return {
    failures: [],
    inventory,
    pruned: true,
    removedWorktrees: [...inventory.registeredWorktrees],
    sessionsRemoved: true,
    worktreesRootRemoved: true,
  };
}
