import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { TeamTaskResultSource } from "../../src/domain/teamTask.js";
import {
  createLivePortfolioFixture,
  LIVE_PORTFOLIO_PROMPT,
  runLivePortfolioDemo,
  validateLivePortfolioEvidence,
  type LivePortfolioDependencies,
  type LivePortfolioProcess,
} from "../../src/portfolio/live.js";
import { createCliSessionTrace } from "../../src/runtime/session.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";
import type { TraceRecorder } from "../../src/runtime/trace.js";

const execFileAsync = promisify(execFile);

describe("focused live portfolio walkthrough", () => {
  it("loads the Forge environment before preflight and refuses missing explicit model settings", async () => {
    const calls: string[] = [];
    const environment: NodeJS.ProcessEnv = {};

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(environment),
      async createFixture() {
        calls.push("fixture");
        throw new Error("fixture must not be created");
      },
      async loadEnvironment() {
        calls.push("environment");
      },
    });

    expect(result).toMatchObject({ reason: "missing_environment", status: "UNAVAILABLE" });
    expect(calls).toEqual(["environment"]);
  });

  it.each([
    { available: { bash: true, git: true }, reason: "interactive_terminal_required", tty: false },
    { available: { bash: true, git: false }, reason: "git_required", tty: true },
    { available: { bash: false, git: true }, reason: "bash_required", tty: true },
  ])("stops at the $reason preflight before creating a fixture", async ({ available, reason, tty }) => {
    let fixtureStarts = 0;
    const environment = configuredEnvironment();

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(environment),
      async commandAvailable(command) {
        return available[command as keyof typeof available];
      },
      async createFixture() {
        fixtureStarts += 1;
        throw new Error("fixture must not be created");
      },
      isInteractiveTerminal: () => tty,
    });

    expect(result).toMatchObject({ reason, status: "UNAVAILABLE" });
    expect(fixtureStarts).toBe(0);
  });

  it("creates a dependency-free slugify fixture whose initial npm test fails", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(fixture, "package.json"), "utf8")) as {
        dependencies?: unknown;
        scripts?: Record<string, string>;
      };
      expect(packageJson.dependencies).toBeUndefined();
      expect(packageJson.scripts).toEqual({ test: "node --test" });
      expect(await fs.readFile(path.join(fixture, "src", "slugify.mjs"), "utf8"))
        .toContain("export function slugify");
      await expectFailedNpmTest(fixture);

      await fs.writeFile(
        path.join(fixture, "src", "slugify.mjs"),
        'export function slugify(value) { return value.trim().replace(/\\s+/g, "-"); }\n',
      );
      await expectFailedNpmTest(fixture);

      await fs.writeFile(
        path.join(fixture, "src", "slugify.mjs"),
        'export function slugify(value) { return value.trim().toLowerCase(); }\n',
      );
      await expectFailedNpmTest(fixture);

      await fs.writeFile(
        path.join(fixture, "src", "slugify.mjs"),
        'export function slugify(value) { return value.trim().toLowerCase().replace(/\\s+/g, "-"); }\n',
      );
      await expect(execFileAsync("npm", ["test"], { cwd: fixture })).resolves.toMatchObject({});
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("spawns the compiled CLI with an argv array and accepts only structured root evidence", async () => {
    let fixture = "";
    const spawnCalls: Array<{ args: string[]; command: string; cwd: string; shell?: boolean }> = [];
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        fixture = await createLivePortfolioFixture();
        return fixture;
      },
      async runFixtureTests(cwd) {
        await expect(execFileAsync("npm", ["test"], { cwd })).rejects.toMatchObject({ code: 1 });
        return 1;
      },
      spawnCli(command, args, options) {
        spawnCalls.push({ args, command, cwd: options.cwd, shell: options.shell });
        return completedProcess(async () => {
          await writePassingRootEvidence(options.cwd);
          return { exitCode: 0, signal: null };
        });
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "verified_session_evidence", status: "PASS" });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: process.execPath,
      cwd: fixture,
      shell: false,
    });
    expect(spawnCalls[0]?.args.slice(0, 4)).toEqual([
      path.resolve(process.cwd(), "dist", "cli", "index.js"),
      "--worktree",
      "--verify",
      "npm test",
    ]);
    expect(spawnCalls[0]?.args).toHaveLength(5);
    expect(spawnCalls[0]?.args[4]).toMatch(/exactly one edit task.*synchronous edit child.*slugify/is);
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a zero child exit when root Session evidence is absent and still cleans up", async () => {
    let fixture = "";
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        fixture = await createLivePortfolioFixture();
        return fixture;
      },
      runFixtureTests: async () => 1,
      spawnCli: () => completedProcess(async () => ({ exitCode: 0, signal: null })),
    });

    expect(result).toEqual({ cleaned: true, reason: "invalid_session_evidence", status: "FAIL" });
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a root Trace whose final answer precedes passed verification", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      const tracePath = path.join(rootSessionDir, "trace.jsonl");
      const events = (await fs.readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const verificationIndex = events.findIndex((event) => event.type === "verification_result");
      const finalIndex = events.findIndex((event) => event.type === "final_answer");
      const reorderedEvents = [...events];
      [reorderedEvents[verificationIndex], reorderedEvents[finalIndex]] = [
        reorderedEvents[finalIndex],
        reorderedEvents[verificationIndex],
      ];
      const reordered = reorderedEvents.map((event, index) => ({
        ...event,
        sequence: index + 1,
      }));
      await fs.writeFile(tracePath, `${reordered.map((event) => JSON.stringify(event)).join("\n")}\n`);

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/completion evidence/);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects a TaskGraph child source without its matching child Session", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const sessionsRoot = path.join(fixture, ".forge", "sessions");
      const sessions = await fs.readdir(sessionsRoot);
      for (const session of sessions) {
        const metadata = JSON.parse(
          await fs.readFile(path.join(sessionsRoot, session, "session.json"), "utf8"),
        ) as { child?: unknown };
        if (metadata.child) {
          await fs.rm(path.join(sessionsRoot, session), { force: true, recursive: true });
        }
      }

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/child session/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects root evidence that does not prove --worktree setup", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      const tracePath = path.join(rootSessionDir, "trace.jsonl");
      const events = (await fs.readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type !== "workspace_created")
        .map((event, index) => ({ ...event, sequence: index + 1 }));
      await fs.writeFile(tracePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/worktree/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it.each([
    { role: "root" as const, toolName: "delegate" },
    { role: "child" as const, toolName: "edit" },
    { role: "root" as const, toolName: "task_verify" },
    { role: "root" as const, toolName: "task_integrate" },
  ])("rejects missing manual approval evidence for $toolName", async ({ role, toolName }) => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const sessionDir = role === "root"
        ? await findRootSessionDir(fixture)
        : await findChildSessionDir(fixture);
      await rewriteTrace(sessionDir, (events) => events.filter((event) => !(
        event.type === "approval_result" && event.toolName === toolName
      )));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/approval/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects auto-allowed evidence for a manually approved action", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      await rewriteTrace(rootSessionDir, (events) => events.map((event) => (
        event.type === "permission_decision" && event.toolName === "delegate"
          ? { ...event, action: "allow" }
          : event
      )));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/approval/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects child source metadata outside the Runtime worktree convention", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const childSessionDir = await findChildSessionDir(fixture);
      const childMetadataPath = path.join(childSessionDir, "session.json");
      const childMetadata = JSON.parse(await fs.readFile(childMetadataPath, "utf8")) as {
        workspace: { branch: string; path: string };
      };
      const wrongWorkspace = {
        branch: "fabricated/child",
        path: path.join(fixture, "outside-runtime-layout"),
      };
      Object.assign(childMetadata.workspace, wrongWorkspace);
      await fs.writeFile(childMetadataPath, `${JSON.stringify(childMetadata, null, 2)}\n`);

      const rootSessionDir = await findRootSessionDir(fixture);
      const graphPath = path.join(rootSessionDir, "task-graph.json");
      const graph = JSON.parse(await fs.readFile(graphPath, "utf8")) as {
        tasks: Array<{
          integrationReceipt: { source: { workspace: { branch: string; path: string } } };
          submission: { source: { workspace: { branch: string; path: string } } };
        }>;
      };
      Object.assign(graph.tasks[0]?.submission.source.workspace ?? {}, wrongWorkspace);
      Object.assign(graph.tasks[0]?.integrationReceipt.source.workspace ?? {}, wrongWorkspace);
      await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
      await rewriteTrace(rootSessionDir, (events) => events.map((event) => (
        (event.type === "child_session_finished" || event.type === "child_session_handoff")
          ? {
              ...event,
              workspace: {
                ...(event.workspace as Record<string, unknown>),
                ...wrongWorkspace,
              },
            }
          : event
      )));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/child session/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("requires the last root verification before final to be passed npm test", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      await rewriteTrace(rootSessionDir, (events) => {
        const finalIndex = events.findIndex((event) => event.type === "final_answer");
        const envelope = [...events].reverse().find(
          (event) => event.type === "verification_result",
        ) as Record<string, unknown>;
        return [
          ...events.slice(0, finalIndex),
          {
            ...envelope,
            command: "npm test",
            exitCode: 1,
            name: "command",
            round: 10,
            status: "failed",
            summary: "failed after prior pass",
            type: "verification_result",
          },
          ...events.slice(finalIndex),
        ];
      });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/completion evidence/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("cleans up when the child fails", async () => {
    let fixture = "";
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        fixture = await createLivePortfolioFixture();
        return fixture;
      },
      runFixtureTests: async () => 1,
      spawnCli: () => completedProcess(async () => ({ exitCode: 1, signal: null })),
    });

    expect(result).toEqual({ cleaned: true, reason: "child_failed", status: "FAIL" });
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies fixture creation errors as setup failures", async () => {
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        throw new Error("injected git setup failure");
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "setup_failed", status: "FAIL" });
  });

  it("forwards an interrupt to the child and cleans up the fixture", async () => {
    let fixture = "";
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    const killedWith: NodeJS.Signals[] = [];
    let settle: ((result: { exitCode: null; signal: NodeJS.Signals }) => void) | undefined;

    const resultPromise = runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        fixture = await createLivePortfolioFixture();
        return fixture;
      },
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      scheduleForceKill(handler) {
        handler();
        return () => undefined;
      },
      runFixtureTests: async () => 1,
      spawnCli() {
        const completion = new Promise<{ exitCode: null; signal: NodeJS.Signals }>((resolve) => {
          settle = resolve;
        });
        queueMicrotask(() => interrupt?.("SIGINT"));
        return {
          completion,
          kill(signal) {
            killedWith.push(signal);
            if (signal === "SIGKILL") {
              settle?.({ exitCode: null, signal });
            }
          },
        };
      },
    });

    await expect(resultPromise).resolves.toEqual({
      cleaned: true,
      reason: "interrupted",
      status: "FAIL",
    });
    expect(killedWith).toEqual(["SIGINT", "SIGKILL"]);
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up when interrupted while the fixture is still being created", async () => {
    let fixture = "";
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    let fixtureTests = 0;

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        fixture = await createLivePortfolioFixture();
        interrupt?.("SIGTERM");
        return fixture;
      },
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      async runFixtureTests() {
        fixtureTests += 1;
        return 1;
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "interrupted", status: "FAIL" });
    expect(fixtureTests).toBe(0);
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not report success or cleaned when fixture removal fails", async () => {
    let fixture = "";
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        fixture = await createLivePortfolioFixture();
        return fixture;
      },
      async removeFixture() {
        throw new Error("injected cleanup failure");
      },
      runFixtureTests: async () => 1,
      spawnCli(_command, _args, options) {
        return completedProcess(async () => {
          await writePassingRootEvidence(options.cwd);
          return { exitCode: 0, signal: null };
        });
      },
    });

    expect(result).toEqual({ cleaned: false, reason: "cleanup_failed", status: "FAIL" });
    await fs.rm(fixture, { force: true, recursive: true });
  });

  it("keeps repeated signal handling active until async cleanup finishes", async () => {
    let fixture = "";
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    let handlersRemoved = false;
    let removedBeforeCleanup = false;

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        fixture = await createLivePortfolioFixture();
        return fixture;
      },
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => {
          handlersRemoved = true;
        };
      },
      async removeFixture(pathname) {
        removedBeforeCleanup = handlersRemoved;
        interrupt?.("SIGINT");
        interrupt?.("SIGTERM");
        await fs.rm(pathname, { force: true, recursive: true });
      },
      runFixtureTests: async () => 1,
      scheduleForceKill: () => () => undefined,
      spawnCli(_command, _args, options) {
        return completedProcess(async () => {
          await writePassingRootEvidence(options.cwd);
          return { exitCode: 0, signal: null };
        });
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "interrupted", status: "FAIL" });
    expect(removedBeforeCleanup).toBe(false);
    expect(handlersRemoved).toBe(true);
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function configuredEnvironment(): NodeJS.ProcessEnv {
  return { OPENAI_API_KEY: "test-only-key", OPENAI_MODEL: "test-model" };
}

function preflightDependencies(environment: NodeJS.ProcessEnv): LivePortfolioDependencies {
  return {
    commandAvailable: async () => true,
    createFixture: createLivePortfolioFixture,
    environment,
    forgeRoot: process.cwd(),
    installSignalHandlers: () => () => undefined,
    isInteractiveTerminal: () => true,
    loadEnvironment: async () => undefined,
    removeFixture: async (fixture) => fs.rm(fixture, { force: true, recursive: true }),
    runFixtureTests: async () => 1,
    scheduleForceKill: () => () => undefined,
    spawnCli: () => {
      throw new Error("unexpected child spawn");
    },
  };
}

function completedProcess(
  run: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>,
): LivePortfolioProcess {
  return {
    completion: run(),
    kill() {
      // A completed fake process has nothing to interrupt.
    },
  };
}

async function writePassingRootEvidence(cwd: string): Promise<void> {
  const session = await createCliSessionTrace({
    cwd,
    maxToolRounds: 24,
    model: "test-model",
    task: LIVE_PORTFOLIO_PROMPT,
  });
  const graph = session.metadata.taskGraph;
  if (!graph) {
    throw new Error("root session did not create a task graph");
  }
  const store = createFileTeamTaskStore({ graphPath: graph.taskGraphPath });
  const rootWorkspace = {
    baseBranch: "main",
    baseCommit: "e".repeat(40),
    branch: `forge/run/${session.metadata.id}`,
    mode: "git_worktree" as const,
    path: path.join(cwd, ".forge", "worktrees", session.metadata.id),
  };
  session.metadata = {
    ...session.metadata,
    baseCwd: cwd,
    cwd: rootWorkspace.path,
    workspace: rootWorkspace,
  };
  await fs.writeFile(
    session.paths.sessionMetadataPath,
    `${JSON.stringify(session.metadata, null, 2)}\n`,
    "utf8",
  );
  const leader = { role: "leader" as const, sessionId: session.metadata.id };
  const childSession = await createCliSessionTrace({
    child: {
      parentCallId: "delegate-child",
      parentSessionId: session.metadata.id,
      profile: "edit",
      role: "child",
    },
    cwd,
    maxToolRounds: 8,
    model: "test-model",
    task: "repair slugify",
    taskGraph: {
      delegatedTaskId: "task_001",
      rootSessionId: session.metadata.id,
      taskGraphPath: graph.taskGraphPath,
    },
  });
  const childWorkspace = {
    baseBranch: "main",
    baseCommit: "d".repeat(40),
    branch: `forge/run/${childSession.metadata.id}`,
    mode: "git_worktree" as const,
    path: path.join(cwd, ".forge", "worktrees", childSession.metadata.id),
  };
  childSession.metadata = {
    ...childSession.metadata,
    baseCwd: cwd,
    cwd: childWorkspace.path,
    workspace: childWorkspace,
  };
  await fs.writeFile(
    childSession.paths.sessionMetadataPath,
    `${JSON.stringify(childSession.metadata, null, 2)}\n`,
    "utf8",
  );
  const child = {
    delegatedTaskId: "task_001",
    profile: "edit" as const,
    role: "child" as const,
    sessionId: childSession.metadata.id,
  };
  const source: TeamTaskResultSource = {
    childSessionId: child.sessionId,
    kind: "child",
    profile: "edit",
    workspace: { branch: childWorkspace.branch, path: childWorkspace.path },
  };
  const fingerprint = "a".repeat(64);
  const commit = "b".repeat(40);

  await store.create(leader, {
    acceptance: [
      "npm test passes and slugify trims, lowercases, and collapses whitespace to hyphens",
    ],
    description: "Repair slugify behavior",
    kind: "edit",
    title: "Repair slugify",
    verificationCommand: "npm test",
  });
  await store.transition(leader, {
    action: "assign",
    assignee: { role: "leader" },
    id: "task_001",
  });
  await store.addEvidence(child, "task_001", {
    callId: "child-write",
    references: [{ kind: "artifact", value: "src/slugify.mjs" }],
    round: 1,
    summary: "Fixed slugify and observed the test pass.",
  });
  await store.transition(leader, {
    action: "submit_result",
    changedFiles: ["src/slugify.mjs"],
    fingerprint,
    id: "task_001",
    source,
    summary: "Registered child handoff.",
  });
  await store.recordVerification(leader, "task_001", {
    command: "npm test",
    exitCode: 0,
    fingerprint,
    summary: "passed",
  });
  await store.recordIntegration(leader, "task_001", {
    fingerprint,
    integratedAt: new Date().toISOString(),
    integratedCommit: commit,
    source,
    sourceCommit: commit,
    targetBefore: "c".repeat(40),
  });
  await childSession.recorder.record({
    baseCwd: cwd,
    cwd: childWorkspace.path,
    maxToolRounds: 8,
    model: "test-model",
    task: "repair slugify",
    type: "session_started",
    workspace: childWorkspace,
  });
  await childSession.recorder.record({
    baseBranch: childWorkspace.baseBranch,
    baseCommit: childWorkspace.baseCommit,
    baseCwd: cwd,
    branch: childWorkspace.branch,
    type: "workspace_created",
    workspacePath: childWorkspace.path,
  });
  await recordApprovedAction(childSession.recorder, "child-write", "edit", 1);
  await childSession.recorder.record({ answer: "fixed", round: 2, type: "final_answer" });
  await childSession.recorder.record({ rounds: 2, status: "completed", type: "session_ended" });
  await session.recorder.record({
    baseCwd: cwd,
    cwd: rootWorkspace.path,
    maxToolRounds: 24,
    model: "test-model",
    task: LIVE_PORTFOLIO_PROMPT,
    type: "session_started",
    workspace: rootWorkspace,
  });
  await session.recorder.record({
    baseBranch: rootWorkspace.baseBranch,
    baseCommit: rootWorkspace.baseCommit,
    baseCwd: cwd,
    branch: rootWorkspace.branch,
    type: "workspace_created",
    workspacePath: rootWorkspace.path,
  });
  await recordApprovedAction(session.recorder, "delegate-child", "delegate", 2);
  await session.recorder.record({
    childSessionId: child.sessionId,
    parentCallId: "delegate-child",
    profile: "edit",
    round: 2,
    runInBackground: false,
    task: "repair slugify",
    tracePath: childSession.paths.tracePath,
    type: "child_session_started",
    workspace: childWorkspace,
  });
  await session.recorder.record({
    childSessionId: child.sessionId,
    parentCallId: "delegate-child",
    profile: "edit",
    round: 2,
    runInBackground: false,
    status: "completed",
    tracePath: childSession.paths.tracePath,
    type: "child_session_finished",
    workspace: childWorkspace,
  });
  await session.recorder.record({
    changedFiles: ["src/slugify.mjs"],
    childSessionId: child.sessionId,
    finalAnswer: "fixed",
    parentCallId: "delegate-child",
    profile: "edit",
    round: 2,
    tracePath: childSession.paths.tracePath,
    type: "child_session_handoff",
    workspace: childWorkspace,
  });
  await recordApprovedAction(session.recorder, "verify-task", "task_verify", 7);
  await recordApprovedAction(session.recorder, "integrate-task", "task_integrate", 8);
  await session.recorder.record({
    command: "npm test",
    exitCode: 0,
    name: "command",
    round: 9,
    status: "passed",
    summary: "passed",
    type: "verification_result",
  });
  await session.recorder.record({ answer: "done", round: 9, type: "final_answer" });
  await session.recorder.record({ rounds: 9, status: "completed", type: "session_ended" });
}

async function findRootSessionDir(fixture: string): Promise<string> {
  const sessionsRoot = path.join(fixture, ".forge", "sessions");
  const sessions = await fs.readdir(sessionsRoot);
  for (const session of sessions) {
    const sessionDir = path.join(sessionsRoot, session);
    const metadata = JSON.parse(await fs.readFile(path.join(sessionDir, "session.json"), "utf8")) as {
      child?: unknown;
    };
    if (!metadata.child) {
      return sessionDir;
    }
  }
  throw new Error("root session not found");
}

async function findChildSessionDir(fixture: string): Promise<string> {
  const sessionsRoot = path.join(fixture, ".forge", "sessions");
  const sessions = await fs.readdir(sessionsRoot);
  for (const session of sessions) {
    const sessionDir = path.join(sessionsRoot, session);
    const metadata = JSON.parse(await fs.readFile(path.join(sessionDir, "session.json"), "utf8")) as {
      child?: unknown;
    };
    if (metadata.child) {
      return sessionDir;
    }
  }
  throw new Error("child session not found");
}

async function rewriteTrace(
  sessionDir: string,
  mutate: (events: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): Promise<void> {
  const tracePath = path.join(sessionDir, "trace.jsonl");
  const events = (await fs.readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const rewritten = mutate(events).map((event, index) => ({ ...event, sequence: index + 1 }));
  await fs.writeFile(tracePath, `${rewritten.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

async function recordApprovedAction(
  recorder: TraceRecorder,
  callId: string,
  toolName: string,
  round: number,
): Promise<void> {
  await recorder.record({
    action: "ask",
    callId,
    reason: "manual approval required",
    risk: "mutating",
    round,
    toolName,
    type: "permission_decision",
  });
  await recorder.record({
    approved: true,
    callId,
    round,
    toolName,
    type: "approval_result",
  });
}

async function expectFailedNpmTest(fixture: string): Promise<void> {
  await expect(execFileAsync("npm", ["test"], { cwd: fixture }))
    .rejects.toMatchObject({ code: 1 });
}
