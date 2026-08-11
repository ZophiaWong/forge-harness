import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { config as loadDotEnv } from "dotenv";

import { parseTeamTaskGraphFile } from "../domain/teamTask.js";
import { parseRecordedTraceEvent } from "../runtime/traceSchema.js";

const execFileAsync = promisify(execFile);

export const LIVE_PORTFOLIO_PROMPT = [
  "Run the focused c17c one-shot edit walkthrough with exactly one edit task and one synchronous edit child.",
  "Create task_001 titled=\"Repair slugify\", kind=\"edit\", dependencies=[], acceptance=[\"npm test passes and slugify trims, lowercases, and collapses whitespace to hyphens\"], and verificationCommand=\"npm test\".",
  "Assign task_001 to leader, then delegate one synchronous edit child with taskId=\"task_001\", maxToolRounds=8, and runInBackground=false.",
  "Tell the child to inspect the failing node:test, fix only src/slugify.mjs, run npm test, append task evidence with an artifact reference to src/slugify.mjs, and return a concise final response.",
  "Use the returned childSessionId in Leader task_transition submit_result without passing a workspace path.",
  "Read task_get, call task_verify with command=\"npm test\", then call task_integrate.",
  "Return final only after the completion gate and root verifier pass. Do not create another task, teammate, plugin, or MCP server.",
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
  spawnCli(
    command: string,
    args: string[],
    options: LivePortfolioSpawnOptions,
  ): LivePortfolioProcess;
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
    return unavailable("missing_environment");
  }

  if (!hasNonEmptyEnvironment(dependencies.environment, "OPENAI_API_KEY")
    || !hasNonEmptyEnvironment(dependencies.environment, "OPENAI_MODEL")) {
    return unavailable("missing_environment");
  }
  if (!dependencies.isInteractiveTerminal()) {
    return unavailable("interactive_terminal_required");
  }
  if (!await dependencies.commandAvailable("git")) {
    return unavailable("git_required");
  }
  if (!await dependencies.commandAvailable("bash")) {
    return unavailable("bash_required");
  }

  let fixture: string | undefined;
  let child: LivePortfolioProcess | undefined;
  let creatingFixture = true;
  let interrupted: NodeJS.Signals | undefined;
  let cancelForceKill: () => void = () => undefined;
  let result: LivePortfolioResult = { cleaned: false, reason: "setup_failed", status: "FAIL" };
  const removeSignalHandlers = dependencies.installSignalHandlers((signal) => {
    interrupted = signal;
    if (child) {
      child.kill(signal);
      cancelForceKill();
      cancelForceKill = dependencies.scheduleForceKill(() => child?.kill("SIGKILL"));
    }
  });

  try {
    fixture = await dependencies.createFixture();
    creatingFixture = false;
    if (interrupted) {
      result = { cleaned: false, reason: "interrupted", status: "FAIL" };
    } else {
      const initialTestExit = await dependencies.runFixtureTests(fixture);
      if (initialTestExit === 0) {
        result = { cleaned: false, reason: "fixture_not_failing", status: "FAIL" };
      } else if (interrupted) {
        result = { cleaned: false, reason: "interrupted", status: "FAIL" };
      } else {
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
        const childResult = await child.completion;
        if (interrupted || childResult.signal) {
          result = { cleaned: false, reason: "interrupted", status: "FAIL" };
        } else if (childResult.exitCode !== 0) {
          result = { cleaned: false, reason: "child_failed", status: "FAIL" };
        } else {
          try {
            await validateLivePortfolioEvidence(fixture);
            result = interrupted
              ? { cleaned: false, reason: "interrupted", status: "FAIL" }
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
    result = interrupted
      ? { cleaned: false, reason: "interrupted", status: "FAIL" }
      : creatingFixture
        ? { cleaned: false, reason: "setup_failed", status: "FAIL" }
        : { cleaned: false, reason: "child_failed", status: "FAIL" };
  } finally {
    cancelForceKill();
    removeSignalHandlers();
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
  }

  return result;
}

export async function createLivePortfolioFixture(): Promise<string> {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "forge-portfolio-live-"));
  try {
    await fs.mkdir(path.join(fixture, "src"), { recursive: true });
    await fs.mkdir(path.join(fixture, "test"), { recursive: true });
    await fs.writeFile(
      path.join(fixture, "package.json"),
      `${JSON.stringify({
        name: "forge-portfolio-live-fixture",
        private: true,
        scripts: { test: "node --test" },
        type: "module",
      }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(fixture, "src", "slugify.mjs"),
      [
        "export function slugify(value) {",
        "  return value.toLowerCase().replace(/\\s+/g, \"-\");",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixture, "test", "slugify.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        "",
        'import { slugify } from "../src/slugify.mjs";',
        "",
        'test("trims, lowercases, and collapses whitespace to hyphens", () => {',
        '  assert.equal(slugify("  Hello   Forge  "), "hello-forge");',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await runGit(fixture, ["init", "-q"]);
    await runGit(fixture, ["config", "user.name", "Forge Portfolio Live"]);
    await runGit(fixture, ["config", "user.email", "portfolio-live@example.invalid"]);
    await runGit(fixture, ["add", "package.json", "src/slugify.mjs", "test/slugify.test.mjs"]);
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
  const verificationIndex = events.findIndex((event) => (
    event.type === "verification_result"
    && event.name === "command"
    && event.status === "passed"
    && event.command === "npm test"
    && event.exitCode === 0
  ));
  const finals = events.filter((event) => event.type === "final_answer");
  const completedEnds = events.filter((event) => (
    event.type === "session_ended" && event.status === "completed"
  ));
  const finalIndex = events.findIndex((event) => event === finals[0]);
  const completedIndex = events.findIndex((event) => event === completedEnds[0]);
  if (
    verificationIndex < 0
    || finals.length !== 1
    || completedEnds.length !== 1
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
  if (graph.tasks.length !== 1 || graph.nextTaskSequence !== 2) {
    throw new Error("expected exactly one task");
  }
  const task = graph.tasks[0];
  const submissionSource = task?.submission?.source;
  const receiptSource = task?.integrationReceipt?.source;
  if (
    !task
    || task.id !== "task_001"
    || task.title !== "Repair slugify"
    || task.kind !== "edit"
    || task.status !== "completed"
    || task.owner?.role !== "leader"
    || task.dependencies.length !== 0
    || !sameStrings(task.acceptance, [
      "npm test passes and slugify trims, lowercases, and collapses whitespace to hyphens",
    ])
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

  const expectedChangedFiles = ["src/slugify.mjs"];
  if (
    !sameStrings(task.submission?.changedFiles, expectedChangedFiles)
    || !task.evidence.some((evidence) => (
      evidence.reportedByRole === "child"
      && evidence.reportedBySessionId === submissionSource.childSessionId
      && evidence.references?.some((reference) => (
        reference.kind === "artifact" && reference.value === "src/slugify.mjs"
      ))
    ))
  ) {
    throw new Error("child edit evidence does not anchor the slugify artifact");
  }

  const childSessions = sessions.filter((session) => session.metadata.child !== undefined);
  if (childSessions.length !== 1 || childSessions[0]?.id !== submissionSource.childSessionId) {
    throw new Error("expected one matching child session");
  }
  const childSession = childSessions[0] as typeof sessions[number];
  const childLink = childSession.metadata.child;
  const childTaskGraph = childSession.metadata.taskGraph;
  const childWorkspace = childSession.metadata.workspace;
  if (
    !isRecord(childLink)
    || childLink.parentSessionId !== root.id
    || childLink.profile !== "edit"
    || childLink.role !== "child"
    || !isRecord(childTaskGraph)
    || childTaskGraph.delegatedTaskId !== task.id
    || childTaskGraph.rootSessionId !== root.id
    || childTaskGraph.taskGraphPath !== path.join(root.sessionDir, "task-graph.json")
    || !isRecord(childWorkspace)
    || childWorkspace.mode !== "git_worktree"
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
    || finishIndex <= startIndex
    || handoffIndex <= finishIndex
    || verificationIndex <= handoffIndex
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
  if (childFinalIndex < 0 || childCompletedIndex <= childFinalIndex) {
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
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function unavailable(reason: LivePortfolioResult["reason"]): LivePortfolioResult {
  return { cleaned: true, reason, status: "UNAVAILABLE" };
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

function sameStrings(actual: string[] | undefined, expected: string[]): boolean {
  return actual?.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}
