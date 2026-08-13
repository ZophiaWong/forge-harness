import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { config as loadDotEnv } from "dotenv";

import { parseTeamTaskGraphFile } from "../domain/teamTask.js";
import type { RecordedTraceEvent } from "../runtime/trace.js";
import { parseRecordedTraceEvent } from "../runtime/traceSchema.js";

const execFileAsync = promisify(execFile);

export const LIVE_PORTFOLIO_PROMPT = [
  "Fix the failing retry-policy tests without modifying tests, package.json, or the public API.",
  "Keep implementation changes within src/** and keep the solution focused.",
  "Track the work as one edit task with npm test as its verification command.",
  "Use one synchronous isolated edit child for the implementation, then verify and integrate the result before finishing.",
].join(" ");

export interface LivePortfolioProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface LivePortfolioProcess {
  completion: Promise<LivePortfolioProcessResult>;
  kill(signal: NodeJS.Signals): void;
}

export interface LivePortfolioSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export interface LivePortfolioDependencies {
  commandAvailable(command: "bash" | "git"): Promise<boolean>;
  createFixture(): Promise<string>;
  environment: NodeJS.ProcessEnv;
  forgeRoot: string;
  installSignalHandlers(handler: (signal: NodeJS.Signals) => void): () => void;
  isInteractiveTerminal(): boolean;
  loadEnvironment(forgeRoot: string, environment: NodeJS.ProcessEnv): Promise<void>;
  removeFixture(fixture: string): Promise<void>;
  runFixtureTests(fixture: string): Promise<number>;
  scheduleForceKill(handler: () => void): () => void;
  scheduleRunTimeout(handler: () => void): () => void;
  spawnCli(
    command: string,
    args: string[],
    options: LivePortfolioSpawnOptions,
  ): LivePortfolioProcess;
  writeLine(line: string): void;
}

export interface LivePortfolioResult {
  cleaned: boolean;
  reason:
    | "bash_required"
    | "child_failed"
    | "cleanup_failed"
    | "fixture_not_failing"
    | "git_required"
    | "interactive_terminal_required"
    | "interrupted"
    | "invalid_session_evidence"
    | "missing_environment"
    | "setup_failed"
    | "timed_out"
    | "verified_session_evidence";
  status: "FAIL" | "PASS" | "UNAVAILABLE";
}

/**
 * Run one operator-started live observation against a disposable repository.
 * The provider child is variable; the final verdict comes from persisted Runtime evidence.
 */
export async function runLivePortfolioDemo(
  dependencies: LivePortfolioDependencies = defaultLivePortfolioDependencies(),
): Promise<LivePortfolioResult> {
  try {
    await dependencies.loadEnvironment(dependencies.forgeRoot, dependencies.environment);
  } catch {
    return reportLivePortfolioResult(dependencies, unavailable("missing_environment"));
  }

  if (!hasNonEmptyEnvironment(dependencies.environment, "OPENAI_API_KEY")
    || !hasNonEmptyEnvironment(dependencies.environment, "OPENAI_MODEL")) {
    return reportLivePortfolioResult(dependencies, unavailable("missing_environment"));
  }
  if (!dependencies.isInteractiveTerminal()) {
    return reportLivePortfolioResult(
      dependencies,
      unavailable("interactive_terminal_required"),
    );
  }
  if (!await dependencies.commandAvailable("git")) {
    return reportLivePortfolioResult(dependencies, unavailable("git_required"));
  }
  if (!await dependencies.commandAvailable("bash")) {
    return reportLivePortfolioResult(dependencies, unavailable("bash_required"));
  }

  let fixture: string | undefined;
  let child: LivePortfolioProcess | undefined;
  let creatingFixture = true;
  let stopReason: "interrupted" | "timed_out" | undefined;
  let cancelForceKill: () => void = () => undefined;
  let cancelRunTimeout: () => void = () => undefined;
  let result: LivePortfolioResult = { cleaned: false, reason: "setup_failed", status: "FAIL" };
  const stopChild = (
    reason: "interrupted" | "timed_out",
    signal: NodeJS.Signals,
  ) => {
    if (stopReason) {
      return;
    }
    stopReason = reason;
    if (child) {
      child.kill(signal);
      cancelForceKill();
      cancelForceKill = dependencies.scheduleForceKill(() => child?.kill("SIGKILL"));
    }
  };
  const removeSignalHandlers = dependencies.installSignalHandlers((signal) => {
    stopChild("interrupted", signal);
  });

  try {
    fixture = await dependencies.createFixture();
    creatingFixture = false;
    dependencies.writeLine("[demo] Created a disposable retry fixture.");
    if (stopReason) {
      result = { cleaned: false, reason: stopReason, status: "FAIL" };
    } else {
      const initialTestExit = await dependencies.runFixtureTests(fixture);
      if (initialTestExit === 0) {
        result = { cleaned: false, reason: "fixture_not_failing", status: "FAIL" };
      } else if (stopReason) {
        result = { cleaned: false, reason: stopReason, status: "FAIL" };
      } else {
        dependencies.writeLine("[demo] Initial tests fail as expected.");
        dependencies.writeLine("[demo] ----- Forge Runtime transcript begins -----");
        let childResult: LivePortfolioProcessResult;
        try {
          cancelRunTimeout = dependencies.scheduleRunTimeout(() => {
            stopChild("timed_out", "SIGTERM");
          });
          child = dependencies.spawnCli(
            process.execPath,
            [
              path.resolve(dependencies.forgeRoot, "dist", "cli", "index.js"),
              "--worktree",
              "--verify",
              "npm test",
              LIVE_PORTFOLIO_PROMPT,
            ],
            {
              cwd: fixture,
              env: dependencies.environment,
              shell: false,
            },
          );
          childResult = await child.completion;
        } finally {
          dependencies.writeLine("[demo] ----- Forge Runtime transcript ends -----");
        }
        if (stopReason) {
          result = { cleaned: false, reason: stopReason, status: "FAIL" };
        } else if (childResult.signal) {
          result = { cleaned: false, reason: "interrupted", status: "FAIL" };
        } else if (childResult.exitCode !== 0) {
          result = { cleaned: false, reason: "child_failed", status: "FAIL" };
        } else {
          try {
            await validateLivePortfolioEvidence(fixture);
            result = stopReason
              ? { cleaned: false, reason: stopReason, status: "FAIL" }
              : {
                  cleaned: false,
                  reason: "verified_session_evidence",
                  status: "PASS",
                };
          } catch {
            result = { cleaned: false, reason: "invalid_session_evidence", status: "FAIL" };
          }
        }
      }
    }
  } catch {
    result = stopReason
      ? { cleaned: false, reason: stopReason, status: "FAIL" }
      : creatingFixture
        ? { cleaned: false, reason: "setup_failed", status: "FAIL" }
        : { cleaned: false, reason: "child_failed", status: "FAIL" };
  } finally {
    if (fixture) {
      try {
        await dependencies.removeFixture(fixture);
        result.cleaned = true;
      } catch {
        result = { cleaned: false, reason: "cleanup_failed", status: "FAIL" };
      }
    } else {
      result.cleaned = true;
    }
    if (stopReason && result.reason !== "cleanup_failed") {
      result = { cleaned: result.cleaned, reason: stopReason, status: "FAIL" };
    }
    cancelRunTimeout();
    cancelForceKill();
    removeSignalHandlers();
  }

  return reportLivePortfolioResult(dependencies, result);
}

export async function createLivePortfolioFixture(): Promise<string> {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "forge-portfolio-live-"));
  try {
    await fs.mkdir(path.join(fixture, "src"), { recursive: true });
    await fs.mkdir(path.join(fixture, "test"), { recursive: true });
    await fs.writeFile(path.join(fixture, ".gitignore"), ".forge/\n", "utf8");
    await fs.writeFile(
      path.join(fixture, "package.json"),
      `${JSON.stringify({
        name: "forge-portfolio-retry-fixture",
        private: true,
        scripts: { test: "node --test" },
        type: "module",
      }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(fixture, "src", "errors.mjs"),
      [
        "export class TransientError extends Error {",
        "  name = \"TransientError\";",
        "}",
        "",
        "export class PermanentError extends Error {",
        "  name = \"PermanentError\";",
        "}",
        "",
        "export function isTransientError(error) {",
        "  return error instanceof TransientError;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixture, "src", "retry.mjs"),
      [
        "export async function runWithRetry(operation, { maxAttempts, isRetryable }) {",
        "  let attempt = 0;",
        "  while (attempt <= maxAttempts) {",
        "    attempt += 1;",
        "    try {",
        "      return await operation();",
        "    } catch (error) {",
        "      if (attempt > maxAttempts) {",
        "        throw error;",
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixture, "test", "retry.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        "",
        'import { PermanentError, TransientError, isTransientError } from "../src/errors.mjs";',
        'import { runWithRetry } from "../src/retry.mjs";',
        "",
        'test("returns a first-attempt success without another call", async () => {',
        "  let attempts = 0;",
        "  const result = await runWithRetry(async () => {",
        "    attempts += 1;",
        '    return "ok";',
        "  }, { maxAttempts: 3, isRetryable: isTransientError });",
        '  assert.equal(result, "ok");',
        "  assert.equal(attempts, 1);",
        "});",
        "",
        'test("retries transient failures until the operation succeeds", async () => {',
        "  let attempts = 0;",
        "  const result = await runWithRetry(async () => {",
        "    attempts += 1;",
        "    if (attempts < 3) {",
        '      throw new TransientError("try again");',
        "    }",
        '    return "recovered";',
        "  }, { maxAttempts: 3, isRetryable: isTransientError });",
        '  assert.equal(result, "recovered");',
        "  assert.equal(attempts, 3);",
        "});",
        "",
        'test("maxAttempts is the total operation limit", async () => {',
        "  let attempts = 0;",
        '  const failure = new TransientError("still unavailable");',
        "  await assert.rejects(",
        "    runWithRetry(async () => {",
        "      attempts += 1;",
        "      throw failure;",
        "    }, { maxAttempts: 3, isRetryable: isTransientError }),",
        "    (error) => error === failure,",
        "  );",
        "  assert.equal(attempts, 3);",
        "});",
        "",
        'test("stops immediately for a permanent failure", async () => {',
        "  let attempts = 0;",
        '  const failure = new PermanentError("do not retry");',
        "  await assert.rejects(",
        "    runWithRetry(async () => {",
        "      attempts += 1;",
        "      throw failure;",
        "    }, { maxAttempts: 3, isRetryable: isTransientError }),",
        "    (error) => error === failure,",
        "  );",
        "  assert.equal(attempts, 1);",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await runGit(fixture, ["init", "-q"]);
    await runGit(fixture, ["config", "user.name", "Forge Portfolio Live"]);
    await runGit(fixture, ["config", "user.email", "portfolio-live@example.invalid"]);
    await runGit(fixture, [
      "add",
      ".gitignore",
      "package.json",
      "src/errors.mjs",
      "src/retry.mjs",
      "test/retry.test.mjs",
    ]);
    await runGit(fixture, ["commit", "--no-gpg-sign", "-qm", "initial failing fixture"]);
    return fixture;
  } catch (error) {
    await fs.rm(fixture, { force: true, recursive: true });
    throw error;
  }
}

export async function validateLivePortfolioEvidence(fixture: string): Promise<void> {
  const sessionsRoot = path.join(fixture, ".forge", "sessions");
  const sessionEntries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  const sessions: Array<{
    id: string;
    metadata: Record<string, unknown>;
    sessionDir: string;
  }> = [];

  for (const entry of sessionEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sessionDir = path.join(sessionsRoot, entry.name);
    const value: unknown = JSON.parse(await fs.readFile(path.join(sessionDir, "session.json"), "utf8"));
    if (!isRecord(value) || typeof value.id !== "string") {
      throw new Error("invalid session metadata");
    }
    sessions.push({ id: value.id, metadata: value, sessionDir });
  }

  const roots = sessions.filter((session) => session.metadata.child === undefined);
  for (const root of roots) {
    const value = root.metadata;
    if (
      !isRecord(value.taskGraph)
      || value.taskGraph.rootSessionId !== root.id
    ) {
      throw new Error("invalid root session metadata");
    }
  }

  if (roots.length !== 1) {
    throw new Error("expected exactly one root session");
  }
  const root = roots[0] as typeof sessions[number];
  const expectedRootTracePath = path.join(root.sessionDir, "trace.jsonl");
  const expectedRootTaskGraphPath = path.join(root.sessionDir, "task-graph.json");
  const expectedRootWorkspacePath = path.join(fixture, ".forge", "worktrees", root.id);
  const expectedRootBranch = `forge/run/${root.id}`;
  const rootTaskGraph = root.metadata.taskGraph;
  const rootWorkspace = root.metadata.workspace;
  if (
    root.id !== path.basename(root.sessionDir)
    || root.metadata.baseCwd !== fixture
    || root.metadata.cwd !== expectedRootWorkspacePath
    || root.metadata.task !== LIVE_PORTFOLIO_PROMPT
    || root.metadata.tracePath !== expectedRootTracePath
    || !isRecord(rootTaskGraph)
    || rootTaskGraph.taskGraphPath !== expectedRootTaskGraphPath
    || !isRecord(rootWorkspace)
    || rootWorkspace.mode !== "git_worktree"
    || rootWorkspace.branch !== expectedRootBranch
    || rootWorkspace.path !== expectedRootWorkspacePath
  ) {
    throw new Error("root session is missing worktree metadata");
  }

  const traceText = await fs.readFile(expectedRootTracePath, "utf8");
  const traceLines = traceText.split("\n").filter((line) => line.length > 0);
  const events = traceLines.map((line, index) => {
    const event = parseRecordedTraceEvent(JSON.parse(line));
    if (event.sessionId !== root.id || event.sequence !== index + 1) {
      throw new Error("root trace envelope mismatch");
    }
    return event;
  });
  const workspaceEvents = events.filter((event) => event.type === "workspace_created");
  const sessionStartEvents = events.filter((event) => event.type === "session_started");
  const workspaceIndex = events.findIndex((event) => event === workspaceEvents[0]);
  const sessionStartIndex = events.findIndex((event) => event === sessionStartEvents[0]);
  if (
    workspaceEvents.length !== 1
    || sessionStartEvents.length !== 1
    || workspaceEvents[0]?.baseCwd !== fixture
    || workspaceEvents[0].branch !== expectedRootBranch
    || workspaceEvents[0].workspacePath !== expectedRootWorkspacePath
    || sessionStartEvents[0]?.baseCwd !== fixture
    || sessionStartEvents[0].cwd !== expectedRootWorkspacePath
    || sessionStartEvents[0].task !== LIVE_PORTFOLIO_PROMPT
    || sessionStartEvents[0].workspace?.branch !== expectedRootBranch
    || sessionStartEvents[0].workspace.path !== expectedRootWorkspacePath
    || sessionStartIndex < 0
    || workspaceIndex <= sessionStartIndex
  ) {
    throw new Error("root trace is missing worktree startup evidence");
  }
  const finals = events.filter((event) => event.type === "final_answer");
  const completedEnds = events.filter((event) => (
    event.type === "session_ended" && event.status === "completed"
  ));
  const finalIndex = events.findIndex((event) => event === finals[0]);
  const completedIndex = events.findIndex((event) => event === completedEnds[0]);
  const verificationsBeforeFinal = events
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.index < finalIndex && entry.event.type === "verification_result");
  const terminalVerification = verificationsBeforeFinal.at(-1);
  const verificationIndex = terminalVerification?.index ?? -1;
  if (
    finals.length !== 1
    || completedEnds.length !== 1
    || terminalVerification?.event.type !== "verification_result"
    || terminalVerification.event.name !== "command"
    || terminalVerification.event.status !== "passed"
    || terminalVerification.event.command !== "npm test"
    || terminalVerification.event.exitCode !== 0
    || finalIndex <= verificationIndex
    || completedIndex <= finalIndex
    || completedIndex !== events.length - 1
  ) {
    throw new Error("root trace is missing completion evidence");
  }

  const taskGraphValue: unknown = JSON.parse(
    await fs.readFile(expectedRootTaskGraphPath, "utf8"),
  );
  const graph = parseTeamTaskGraphFile(taskGraphValue);
  if (graph.tasks.length !== 1) {
    throw new Error("expected exactly one task");
  }
  const task = graph.tasks[0];
  const submissionSource = task?.submission?.source;
  const receiptSource = task?.integrationReceipt?.source;
  if (
    !task
    || task.kind !== "edit"
    || task.status !== "completed"
    || task.owner?.role !== "leader"
    || task.dependencies.length !== 0
    || task.verificationCommand !== "npm test"
    || task.verdict?.status !== "passed"
    || submissionSource?.kind !== "child"
    || submissionSource.profile !== "edit"
    || receiptSource?.kind !== "child"
    || receiptSource.profile !== "edit"
    || receiptSource.childSessionId !== submissionSource.childSessionId
  ) {
    throw new Error("task graph is missing child edit completion evidence");
  }

  const expectedChangedFiles = task.submission?.changedFiles;
  if (!expectedChangedFiles || !isSourceOnlyPatch(expectedChangedFiles)) {
    throw new Error("completed child patch contains a change outside src");
  }

  const childSessions = sessions.filter((session) => session.metadata.child !== undefined);
  if (childSessions.length !== 1 || childSessions[0]?.id !== submissionSource.childSessionId) {
    throw new Error("expected one matching child session");
  }
  const childSession = childSessions[0] as typeof sessions[number];
  const childLink = childSession.metadata.child;
  const childTaskGraph = childSession.metadata.taskGraph;
  const childWorkspace = childSession.metadata.workspace;
  const expectedChildWorkspacePath = path.join(
    fixture,
    ".forge",
    "worktrees",
    childSession.id,
  );
  const expectedChildBranch = `forge/run/${childSession.id}`;
  if (
    childSession.id !== path.basename(childSession.sessionDir)
    || childSession.metadata.baseCwd !== fixture
    || childSession.metadata.cwd !== expectedChildWorkspacePath
    || childSession.metadata.tracePath !== path.join(childSession.sessionDir, "trace.jsonl")
    || !isRecord(childLink)
    || childLink.parentSessionId !== root.id
    || childLink.profile !== "edit"
    || childLink.role !== "child"
    || !isRecord(childTaskGraph)
    || childTaskGraph.delegatedTaskId !== task.id
    || childTaskGraph.rootSessionId !== root.id
    || childTaskGraph.taskGraphPath !== path.join(root.sessionDir, "task-graph.json")
    || !isRecord(childWorkspace)
    || childWorkspace.mode !== "git_worktree"
    || childWorkspace.branch !== expectedChildBranch
    || childWorkspace.path !== expectedChildWorkspacePath
    || childWorkspace.branch !== submissionSource.workspace.branch
    || childWorkspace.path !== submissionSource.workspace.path
  ) {
    throw new Error("child session does not match the submitted task source");
  }

  const expectedChildTracePath = path.join(childSession.sessionDir, "trace.jsonl");
  const starts = events.filter((event) => event.type === "child_session_started");
  const finishes = events.filter((event) => event.type === "child_session_finished");
  const handoffs = events.filter((event) => event.type === "child_session_handoff");
  const startIndex = events.findIndex((event) => event === starts[0]);
  const finishIndex = events.findIndex((event) => event === finishes[0]);
  const handoffIndex = events.findIndex((event) => event === handoffs[0]);
  const delegateApproval = requireManualApproval(
    events,
    ["delegate"],
    starts[0]?.parentCallId,
  );
  const verifyApproval = requireManualApproval(events, ["task_verify"]);
  const integrateApproval = requireManualApproval(events, ["task_integrate"]);
  if (
    starts.length !== 1
    || starts[0]?.childSessionId !== childSession.id
    || finishes.length !== 1
    || finishes[0]?.childSessionId !== childSession.id
    || finishes[0].status !== "completed"
    || handoffs.length !== 1
    || handoffs[0]?.childSessionId !== childSession.id
    || starts[0]?.profile !== "edit"
    || starts[0].runInBackground !== false
    || starts[0].tracePath !== expectedChildTracePath
    || finishes[0]?.parentCallId !== starts[0].parentCallId
    || finishes[0].profile !== "edit"
    || finishes[0].runInBackground !== false
    || finishes[0].tracePath !== expectedChildTracePath
    || finishes[0].workspace?.branch !== submissionSource.workspace.branch
    || finishes[0].workspace.path !== submissionSource.workspace.path
    || handoffs[0]?.parentCallId !== starts[0].parentCallId
    || handoffs[0].profile !== "edit"
    || handoffs[0].tracePath !== expectedChildTracePath
    || handoffs[0].workspace?.branch !== submissionSource.workspace.branch
    || handoffs[0].workspace.path !== submissionSource.workspace.path
    || !sameStrings(handoffs[0].changedFiles, expectedChangedFiles)
    || startIndex < 0
    || startIndex <= sessionStartIndex
    || delegateApproval.approvalIndex >= startIndex
    || finishIndex <= startIndex
    || handoffIndex <= finishIndex
    || delegateApproval.resultIndex <= handoffIndex
    || verifyApproval.callIndex <= delegateApproval.resultIndex
    || integrateApproval.callIndex <= verifyApproval.resultIndex
    || verificationIndex <= integrateApproval.resultIndex
    || !isRecord(childLink)
    || childLink.parentCallId !== starts[0].parentCallId
    || events.some((event) => (
      event.type === "teammate_registered" || event.type === "teammate_rejoined"
    ))
  ) {
    throw new Error("root trace does not contain one synchronous child handoff");
  }

  const childTraceText = await fs.readFile(expectedChildTracePath, "utf8");
  const childEvents = childTraceText.split("\n").filter((line) => line.length > 0).map((line, index) => {
    const event = parseRecordedTraceEvent(JSON.parse(line));
    if (event.sessionId !== childSession.id || event.sequence !== index + 1) {
      throw new Error("child trace envelope mismatch");
    }
    return event;
  });
  const childFinalIndex = childEvents.findIndex((event) => event.type === "final_answer");
  const childCompletedIndex = childEvents.findIndex((event) => (
    event.type === "session_ended" && event.status === "completed"
  ));
  const editApprovals = requireManualApprovals(childEvents, ["edit", "write"]);
  const lastEditResultIndex = Math.max(
    ...editApprovals.map((approval) => approval.resultIndex),
  );
  if (
    childFinalIndex < 0
    || lastEditResultIndex >= childFinalIndex
    || childCompletedIndex <= childFinalIndex
  ) {
    throw new Error("child session is missing terminal evidence");
  }
}

function defaultLivePortfolioDependencies(): LivePortfolioDependencies {
  const forgeRoot = process.cwd();
  return {
    async commandAvailable(command) {
      return execFileAsync(command, ["--version"]).then(
        () => true,
        () => false,
      );
    },
    createFixture: createLivePortfolioFixture,
    environment: process.env,
    forgeRoot,
    installSignalHandlers: installProcessSignalHandlers,
    isInteractiveTerminal: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async loadEnvironment(root, environment) {
      loadDotEnv({
        path: path.join(root, ".env"),
        processEnv: environment,
        quiet: true,
      });
    },
    removeFixture: async (fixture) => fs.rm(fixture, { force: true, recursive: true }),
    runFixtureTests: runInitialFixtureTests,
    scheduleForceKill(handler) {
      const timeout = setTimeout(handler, 2_000);
      timeout.unref();
      return () => clearTimeout(timeout);
    },
    scheduleRunTimeout(handler) {
      const timeout = setTimeout(handler, 10 * 60_000);
      timeout.unref();
      return () => clearTimeout(timeout);
    },
    spawnCli(command, args, options) {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: options.shell,
        stdio: "inherit",
      });
      return {
        completion: new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
        }),
        kill(signal) {
          child.kill(signal);
        },
      };
    },
    writeLine: (line) => console.log(line),
  };
}

async function runInitialFixtureTests(fixture: string): Promise<number> {
  try {
    await execFileAsync("npm", ["test"], { cwd: fixture });
    return 0;
  } catch (error) {
    if (isExecExitError(error)) {
      return error.code;
    }
    throw error;
  }
}

function installProcessSignalHandlers(handler: (signal: NodeJS.Signals) => void): () => void {
  const onSigint = () => handler("SIGINT");
  const onSigterm = () => handler("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function unavailable(reason: LivePortfolioResult["reason"]): LivePortfolioResult {
  return { cleaned: true, reason, status: "UNAVAILABLE" };
}

function reportLivePortfolioResult(
  dependencies: Pick<LivePortfolioDependencies, "writeLine">,
  result: LivePortfolioResult,
): LivePortfolioResult {
  const message = livePortfolioResultMessage(result);
  if (message) {
    dependencies.writeLine(message);
  }
  if (result.status === "PASS") {
    dependencies.writeLine("[demo] PASS");
  }
  return result;
}

function livePortfolioResultMessage(result: LivePortfolioResult): string {
  switch (result.reason) {
    case "verified_session_evidence":
      return "[demo] Verified the isolated child edit, passing tests, Git receipt, and finalization.";
    case "missing_environment":
      return "[demo] Live walkthrough requires OPENAI_API_KEY and OPENAI_MODEL.";
    case "interactive_terminal_required":
      return "[demo] Live walkthrough requires an interactive terminal.";
    case "git_required":
      return "[demo] Live walkthrough requires Git.";
    case "bash_required":
      return "[demo] Live walkthrough requires Bash.";
    case "fixture_not_failing":
      return "[demo] The retry fixture did not start with failing tests.";
    case "child_failed":
      return "[demo] Forge run failed. See the Runtime transcript above.";
    case "invalid_session_evidence":
      return "[demo] The run finished, but the expected c17c evidence was incomplete.";
    case "setup_failed":
      return "[demo] The temporary retry fixture could not be prepared.";
    case "interrupted":
      return "[demo] The Forge run was interrupted.";
    case "timed_out":
      return "[demo] Forge run exceeded 10 minutes and was stopped.";
    case "cleanup_failed":
      return "[demo] The temporary demo directory could not be removed.";
  }
}

function hasNonEmptyEnvironment(environment: NodeJS.ProcessEnv, name: string): boolean {
  return typeof environment[name] === "string" && environment[name]?.trim().length !== 0;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function isExecExitError(error: unknown): error is Error & { code: number } {
  return error instanceof Error && "code" in error && typeof error.code === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceOnlyPatch(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every((changedFile) => {
    if (path.isAbsolute(changedFile) || changedFile.includes("\\")) {
      return false;
    }
    const normalized = path.posix.normalize(changedFile);
    return normalized === changedFile && normalized.startsWith("src/");
  });
}

function sameStrings(actual: string[] | undefined, expected: string[]): boolean {
  return actual?.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function requireManualApproval(
  events: RecordedTraceEvent[],
  toolNames: string[],
  expectedCallId?: string,
): { approvalIndex: number; callIndex: number; resultIndex: number } {
  const approvals = requireManualApprovals(events, toolNames);
  if (approvals.length !== 1) {
    throw new Error(`manual approval evidence missing for ${toolNames.join("/")}`);
  }
  const approval = approvals[0] as typeof approvals[number];
  if (expectedCallId !== undefined && approval.callId !== expectedCallId) {
    throw new Error("manual approval execution does not match child handoff");
  }
  return {
    approvalIndex: approval.approvalIndex,
    callIndex: approval.callIndex,
    resultIndex: approval.resultIndex,
  };
}

function requireManualApprovals(
  events: RecordedTraceEvent[],
  toolNames: string[],
): Array<{
  approvalIndex: number;
  callId: string;
  callIndex: number;
  resultIndex: number;
  toolName: string;
}> {
  const matchingEvents = events
    .map((event, index) => ({ event, index }))
    .filter((entry): entry is {
      event: Extract<RecordedTraceEvent, {
        type: "approval_result" | "permission_decision" | "tool_call" | "tool_result";
      }>;
      index: number;
    } => (
      (entry.event.type === "tool_call"
        || entry.event.type === "permission_decision"
        || entry.event.type === "approval_result"
        || entry.event.type === "tool_result")
      && toolNames.includes(entry.event.toolName)
    ));
  const mutations = new Map<string, { callId: string; toolName: string }>();
  for (const { event } of matchingEvents) {
    mutations.set(`${event.toolName}\0${event.callId}`, {
      callId: event.callId,
      toolName: event.toolName,
    });
  }
  if (mutations.size === 0) {
    throw new Error(`manual approval evidence missing for ${toolNames.join("/")}`);
  }

  return [...mutations.values()].map(({ callId, toolName }) => {
    const calls = matchingEvents.filter((entry) => (
      entry.event.type === "tool_call"
      && entry.event.callId === callId
      && entry.event.toolName === toolName
    ));
    const decisions = matchingEvents.filter((entry) => (
      entry.event.type === "permission_decision"
      && entry.event.callId === callId
      && entry.event.toolName === toolName
    ));
    const approvals = matchingEvents.filter((entry) => (
      entry.event.type === "approval_result"
      && entry.event.callId === callId
      && entry.event.toolName === toolName
    ));
    const results = matchingEvents.filter((entry) => (
      entry.event.type === "tool_result"
      && entry.event.callId === callId
      && entry.event.toolName === toolName
    ));
    const decision = decisions[0];
    const approval = approvals[0];
    if (
      decisions.length !== 1
      || decision?.event.type !== "permission_decision"
      || decision.event.action !== "ask"
    ) {
      throw new Error(`manual approval was bypassed for ${toolName}`);
    }
    if (
      approvals.length !== 1
      || approval?.event.type !== "approval_result"
      || approval.event.approved !== true
      || approval.index <= decision.index
    ) {
      throw new Error(`manual approval result missing for ${toolName}`);
    }
    const call = calls[0];
    const result = results[0];
    if (
      calls.length !== 1
      || call?.event.type !== "tool_call"
      || results.length !== 1
      || result?.event.type !== "tool_result"
      || result.event.status !== "completed"
      || call.index >= decision.index
      || result.index <= approval.index
    ) {
      throw new Error(`manual approval execution missing for ${toolName}`);
    }
    return {
      approvalIndex: approval.index,
      callId,
      callIndex: call.index,
      resultIndex: result.index,
      toolName,
    };
  });
}
