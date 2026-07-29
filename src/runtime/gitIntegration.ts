import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  TeamTask,
  TeamTaskIntegrationReceipt,
  TeamTaskOwner,
  TeamTaskResultSource,
} from "../domain/teamTask.js";
import { runBashCommand } from "../tools/bashTool.js";

const execFileAsync = promisify(execFile);

export type GitIntegrationFailureCode =
  | "cherry_pick_in_progress"
  | "dirty_target"
  | "git_failure"
  | "git_identity_missing"
  | "integration_conflict"
  | "source_drift"
  | "unsupported_source";

export class GitIntegrationError extends Error {
  readonly code: GitIntegrationFailureCode;
  readonly sourceCommit?: string;

  constructor(code: GitIntegrationFailureCode, message: string, sourceCommit?: string) {
    super(message);
    this.name = "GitIntegrationError";
    this.code = code;
    if (sourceCommit) {
      this.sourceCommit = sourceCommit;
    }
  }
}

export interface GitSourceSnapshot {
  changedFiles: string[];
  fingerprint: string;
  head: string;
  status: string[];
}

export interface GitReviewPreview extends GitSourceSnapshot {
  diff: string;
  fingerprintStatus: "current" | "drifted";
}

export interface GitVerificationOutcome {
  actualFingerprint: string;
  command: string;
  exitCode: number;
  output: string;
  sourceDrifted: boolean;
}

export interface GitIntegrationService {
  capture(source: TeamTaskResultSource): Promise<GitSourceSnapshot>;
  integrate(task: TeamTask): Promise<TeamTaskIntegrationReceipt>;
  review(task: TeamTask): Promise<GitReviewPreview>;
  verify(task: TeamTask, command: string): Promise<GitVerificationOutcome>;
}

export interface CreateGitIntegrationServiceOptions {
  now?: () => Date;
  targetCwd: string;
  verificationOutputLimit?: number;
  verificationTimeoutMs?: number;
}

export function createGitIntegrationService(
  options: CreateGitIntegrationServiceOptions,
): GitIntegrationService {
  const targetCwd = path.resolve(options.targetCwd);
  const now = options.now ?? (() => new Date());

  return {
    async capture(source) {
      return captureSource(source);
    },
    async integrate(task) {
      assertSubmittedVerifiedEdit(task);
      const source = task.submission?.source as TeamTaskResultSource;
      const expectedFingerprint = task.submission?.fingerprint as string;
      const before = await captureSource(source);
      if (before.fingerprint !== expectedFingerprint) {
        throw new GitIntegrationError(
          "source_drift",
          `task "${task.id}" source changed after verification`,
        );
      }

      await assertTargetReady(targetCwd);
      const targetBefore = await gitStdout(["rev-parse", "HEAD"], targetCwd);
      const owner = formatOwner(task.owner);
      const sourceLabel = formatSource(source);
      const message = [
        `forge(${task.id}): ${task.title}`,
        "",
        `Forge-Task: ${task.id}`,
        `Forge-Owner: ${owner}`,
        `Forge-Source: ${sourceLabel}`,
      ].join("\n");

      await git(["add", "-A"], source.workspace.path);
      await git(["commit", "--no-gpg-sign", "-m", message], source.workspace.path).catch(
        (error: unknown) => {
          throw new GitIntegrationError(
            "git_failure",
            `failed to create source commit: ${formatGitError(error)}`,
          );
        },
      );
      const sourceCommit = await gitStdout(["rev-parse", "HEAD"], source.workspace.path);
      await assertCommittedPaths(source.workspace.path, sourceCommit, before.changedFiles);

      try {
        await git(["cherry-pick", sourceCommit], targetCwd);
      } catch (error) {
        await git(["cherry-pick", "--abort"], targetCwd).catch(() => undefined);
        throw new GitIntegrationError(
          "integration_conflict",
          `cherry-pick conflicted and was aborted: ${formatGitError(error)}`,
          sourceCommit,
        );
      }

      const integratedCommit = await gitStdout(["rev-parse", "HEAD"], targetCwd);
      return {
        fingerprint: expectedFingerprint,
        integratedAt: now().toISOString(),
        integratedCommit,
        source,
        sourceCommit,
        targetBefore,
      };
    },
    async review(task) {
      assertSubmittedEdit(task);
      const source = task.submission?.source as TeamTaskResultSource;
      const snapshot = await captureSource(source);
      return {
        ...snapshot,
        diff: await createReviewDiff(source.workspace.path, snapshot.changedFiles),
        fingerprintStatus: snapshot.fingerprint === task.submission?.fingerprint
          ? "current"
          : "drifted",
      };
    },
    async verify(task, command) {
      assertSubmittedEdit(task);
      if (command !== task.verificationCommand) {
        throw new GitIntegrationError(
          "git_failure",
          "verification command does not match the task contract",
        );
      }
      const source = task.submission?.source as TeamTaskResultSource;
      const expectedFingerprint = task.submission?.fingerprint as string;
      const before = await captureSource(source);
      if (before.fingerprint !== expectedFingerprint) {
        return {
          actualFingerprint: before.fingerprint,
          command,
          exitCode: 1,
          output: "source drifted before verification",
          sourceDrifted: true,
        };
      }
      const result = await runBashCommand(command, {
        cwd: source.workspace.path,
        outputCharLimit: options.verificationOutputLimit ?? 20_000,
        timeoutMs: options.verificationTimeoutMs ?? 120_000,
      });
      const after = await captureSource(source);
      const exitCode = result.status === "completed" && result.exitCode === 0 ? 0 : 1;
      return {
        actualFingerprint: after.fingerprint,
        command,
        exitCode: after.fingerprint === expectedFingerprint ? exitCode : 1,
        output: [
          `status: ${result.status}`,
          `exit_code: ${String(result.exitCode)}`,
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : "",
        ].filter(Boolean).join("\n"),
        sourceDrifted: after.fingerprint !== expectedFingerprint,
      };
    },
  };
}

async function captureSource(source: TeamTaskResultSource): Promise<GitSourceSnapshot> {
  await assertSourceIdentity(source);
  const cwd = source.workspace.path;
  const head = await gitStdout(["rev-parse", "HEAD"], cwd);
  const statusRaw = await gitStdoutRaw(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
  );
  const status = statusRaw
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const changedFiles = await listChangedFiles(cwd);
  if (changedFiles.length === 0) {
    throw new GitIntegrationError("unsupported_source", "edit source has no changed files");
  }
  const paths = await Promise.all(changedFiles.map(async (relativePath) => {
    const pathname = path.join(cwd, relativePath);
    const stats = await fs.lstat(pathname).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (!stats) {
      const index = await gitStdout(["ls-files", "-s", "--", relativePath], cwd);
      const mode = index.split(/\s+/, 1)[0] || "deleted";
      return { contentHash: "deleted", mode, path: relativePath, type: "deleted" };
    }
    if (stats.isSymbolicLink()) {
      const target = await fs.readlink(pathname);
      return {
        contentHash: sha256(Buffer.from(target)),
        mode: (stats.mode & 0o7777).toString(8),
        path: relativePath,
        type: "symlink",
      };
    }
    if (!stats.isFile()) {
      throw new GitIntegrationError(
        "unsupported_source",
        `unsupported changed path type: ${relativePath}`,
      );
    }
    return {
      contentHash: sha256(await fs.readFile(pathname)),
      mode: (stats.mode & 0o7777).toString(8),
      path: relativePath,
      type: "file",
    };
  }));
  const canonical = JSON.stringify({ head, paths, status });
  return {
    changedFiles,
    fingerprint: sha256(Buffer.from(canonical)),
    head,
    status,
  };
}

async function assertSourceIdentity(source: TeamTaskResultSource): Promise<void> {
  const cwd = path.resolve(source.workspace.path);
  const root = await gitStdout(["rev-parse", "--show-toplevel"], cwd).catch((error: unknown) => {
    throw new GitIntegrationError(
      "unsupported_source",
      `source is not a git worktree: ${formatGitError(error)}`,
    );
  });
  if (path.resolve(root) !== cwd) {
    throw new GitIntegrationError("unsupported_source", "source workspace must be a git root");
  }
  const branch = await gitStdout(["branch", "--show-current"], cwd);
  if (branch !== source.workspace.branch) {
    throw new GitIntegrationError(
      "unsupported_source",
      `source branch mismatch: expected ${source.workspace.branch}, got ${branch || "(detached)"}`,
    );
  }
}

async function assertTargetReady(targetCwd: string): Promise<void> {
  const root = await gitStdout(["rev-parse", "--show-toplevel"], targetCwd).catch((error: unknown) => {
    throw new GitIntegrationError(
      "git_failure",
      `integration target is not a git repository: ${formatGitError(error)}`,
    );
  });
  if (path.resolve(root) !== targetCwd) {
    throw new GitIntegrationError("git_failure", "integration target must be the git root");
  }
  const status = await gitStdoutRaw(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    targetCwd,
  );
  if (status.length > 0) {
    throw new GitIntegrationError("dirty_target", "Leader integration target must be clean");
  }
  const cherryPickPath = await gitStdout(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"], targetCwd);
  const resolvedCherryPickPath = path.isAbsolute(cherryPickPath)
    ? cherryPickPath
    : path.join(targetCwd, cherryPickPath);
  if (await pathExists(resolvedCherryPickPath)) {
    throw new GitIntegrationError(
      "cherry_pick_in_progress",
      "Leader integration target has an in-progress cherry-pick",
    );
  }
  await git(["var", "GIT_AUTHOR_IDENT"], targetCwd).catch((error: unknown) => {
    throw new GitIntegrationError(
      "git_identity_missing",
      `Git author identity is unavailable: ${formatGitError(error)}`,
    );
  });
  await git(["var", "GIT_COMMITTER_IDENT"], targetCwd).catch((error: unknown) => {
    throw new GitIntegrationError(
      "git_identity_missing",
      `Git committer identity is unavailable: ${formatGitError(error)}`,
    );
  });
}

async function listChangedFiles(cwd: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    gitStdoutRaw(["diff", "--name-only", "-z", "HEAD", "--"], cwd),
    gitStdoutRaw(["ls-files", "--others", "--exclude-standard", "-z"], cwd),
  ]);
  return [...new Set(
    `${tracked}${untracked}`
      .split("\0")
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

async function createReviewDiff(cwd: string, changedFiles: string[]): Promise<string> {
  const trackedDiff = await gitStdoutRaw(
    ["diff", "--no-ext-diff", "--binary", "HEAD", "--"],
    cwd,
  );
  const untracked = (await gitStdoutRaw(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    cwd,
  )).split("\0").filter(Boolean);
  const additions: string[] = [];
  for (const relativePath of untracked) {
    const pathname = path.join(cwd, relativePath);
    const content = await fs.readFile(pathname).catch(() => undefined);
    if (!content) {
      continue;
    }
    const rendered = isLikelyBinary(content)
      ? `Binary untracked file: ${relativePath} (${content.length} bytes)`
      : [
          `diff --git a/${relativePath} b/${relativePath}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${relativePath}`,
          ...content.toString("utf8").split("\n").map((line) => `+${line}`),
        ].join("\n");
    additions.push(rendered);
  }
  const header = `changed_files:\n${changedFiles.map((file) => `- ${file}`).join("\n")}`;
  return [header, trackedDiff.trim(), ...additions].filter(Boolean).join("\n\n").slice(0, 80_000);
}

async function assertCommittedPaths(
  cwd: string,
  sourceCommit: string,
  expectedPaths: string[],
): Promise<void> {
  const parent = `${sourceCommit}^`;
  const actual = (await gitStdoutRaw(
    ["diff", "--name-only", "-z", parent, sourceCommit, "--"],
    cwd,
  )).split("\0").filter(Boolean).sort();
  const expected = [...expectedPaths].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new GitIntegrationError(
      "git_failure",
      `source commit paths changed unexpectedly: expected ${expected.join(", ")}, got ${actual.join(", ")}`,
      sourceCommit,
    );
  }
}

function assertSubmittedEdit(task: TeamTask): void {
  if (
    task.kind !== "edit"
    || task.status !== "submitted"
    || !task.submission?.source
    || !task.submission.fingerprint
  ) {
    throw new GitIntegrationError("git_failure", `task "${task.id}" has no submitted edit source`);
  }
}

function assertSubmittedVerifiedEdit(task: TeamTask): void {
  assertSubmittedEdit(task);
  if (
    task.verdict?.status !== "passed"
    || task.verdict.fingerprint !== task.submission?.fingerprint
  ) {
    throw new GitIntegrationError("git_failure", `task "${task.id}" has no current passed verification`);
  }
}

function formatOwner(owner: TeamTaskOwner | undefined): string {
  if (!owner) {
    return "(unowned)";
  }
  return owner.role === "leader" ? "leader" : `teammate:${owner.name}`;
}

function formatSource(source: TeamTaskResultSource): string {
  return source.kind === "child"
    ? `child:${source.childSessionId}`
    : `teammate:${source.name}:${source.sessionId}`;
}

function isLikelyBinary(content: Buffer): boolean {
  return content.subarray(0, 8_000).includes(0);
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ stderr: string; stdout: string }> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function gitStdout(args: string[], cwd: string): Promise<string> {
  return (await git(args, cwd)).stdout.trim();
}

async function gitStdoutRaw(args: string[], cwd: string): Promise<string> {
  return (await git(args, cwd)).stdout;
}

async function pathExists(pathname: string): Promise<boolean> {
  return fs.access(pathname).then(
    () => true,
    () => false,
  );
}

function formatGitError(error: unknown): string {
  if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
    return error.stderr.trim() || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
