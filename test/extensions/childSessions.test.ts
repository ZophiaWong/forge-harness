import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createChildProfileToolRuntime,
  formatChildProfileTask,
  listChangedFiles,
} from "../../src/extensions/childSessions.js";

describe("child session profiles", () => {
  it("uses fresh profile tool surfaces without bash, delegate, or cron tools", () => {
    expect(createChildProfileToolRuntime({ cwd: process.cwd(), profile: "research" }).toolDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "todo",
    ]);
    expect(createChildProfileToolRuntime({ cwd: process.cwd(), profile: "edit" }).toolDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "edit",
      "write",
      "todo",
    ]);
  });

  it("prepends profile-specific prompt prose while preserving child skill invocations", () => {
    const task = formatChildProfileTask({
      profile: "research",
      task: "/chapter-handoff Inspect the previous chapter gap.",
    });

    expect(task).toContain("You are a fresh research child session.");
    expect(task).toContain("Report findings, evidence, open questions, and the next step");
    expect(task).toContain("/chapter-handoff Inspect the previous chapter gap.");
  });

  it("lists changed files from git porcelain status without inline diff", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-child-status-"));
    await fs.writeFile(path.join(cwd, "unchanged.txt"), "base\n", "utf8");
    await execGit(cwd, ["init"]);
    await execGit(cwd, ["config", "user.email", "test@example.com"]);
    await execGit(cwd, ["config", "user.name", "Test User"]);
    await execGit(cwd, ["add", "unchanged.txt"]);
    await execGit(cwd, ["commit", "-m", "base"]);
    await fs.writeFile(path.join(cwd, "unchanged.txt"), "changed\n", "utf8");
    await fs.writeFile(path.join(cwd, "new.txt"), "new\n", "utf8");

    await expect(listChangedFiles(cwd)).resolves.toEqual(["new.txt", "unchanged.txt"]);
  });
});

async function execGit(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", args, { cwd });
}
