import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type {
  TeamTaskIntegrationReceipt,
  TeamTaskResultSource,
} from "../../src/domain/teamTask.js";
import { runMinimalLoop } from "../../src/core/minimalLoop.js";
import {
  createLivePortfolioFixture,
  LIVE_PORTFOLIO_PROMPT,
  runLivePortfolioDemo,
  validateLivePortfolioEvidence,
  type LivePortfolioDependencies,
  type LivePortfolioProcess,
} from "../../src/portfolio/live.js";
import {
  createLifecycleEmitter,
  type LifecycleHook,
} from "../../src/extensions/lifecycle.js";
import { createTeammateManager } from "../../src/extensions/teammates.js";
import { createGitIntegrationService } from "../../src/runtime/gitIntegration.js";
import { createCliSessionTrace } from "../../src/runtime/session.js";
import { prepareWorktreeSession } from "../../src/runtime/sessionWorkspace.js";
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

  it("creates a dependency-free retry fixture with two intentional policy failures", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(fixture, "package.json"), "utf8")) as {
        dependencies?: unknown;
        scripts?: Record<string, string>;
      };
      expect(packageJson.dependencies).toBeUndefined();
      expect(packageJson.scripts).toEqual({ test: "node --test" });
      expect(await fs.readFile(path.join(fixture, ".gitignore"), "utf8")).toBe(".forge/\n");
      expect(await fs.readFile(path.join(fixture, "src", "errors.mjs"), "utf8"))
        .toContain("export class TransientError");
      expect(await fs.readFile(path.join(fixture, "src", "retry.mjs"), "utf8"))
        .toContain("export async function runWithRetry");
      expect(await fs.readFile(path.join(fixture, "test", "retry.test.mjs"), "utf8"))
        .toContain("maxAttempts is the total operation limit");
      await expectFailedNpmTest(fixture);

      await fs.writeFile(
        path.join(fixture, "src", "retry.mjs"),
        [
          "export async function runWithRetry(operation, { maxAttempts, isRetryable }) {",
          "  for (let attempt = 1; ; attempt += 1) {",
          "    try {",
          "      return await operation();",
          "    } catch (error) {",
          "      if (!isRetryable(error) || attempt >= maxAttempts) {",
          "        throw error;",
          "      }",
          "    }",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      await expect(execFileAsync("npm", ["test"], { cwd: fixture })).resolves.toMatchObject({});
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("keeps Runtime Session files from blocking root Worktree setup", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const session = await createCliSessionTrace({
        cwd: fixture,
        maxToolRounds: 48,
        model: "test-model",
        task: LIVE_PORTFOLIO_PROMPT,
      });
      const workspace = await prepareWorktreeSession({
        baseCwd: fixture,
        lifecycleEmitter: createLifecycleEmitter({ recorder: session.recorder }),
        sessionTrace: session,
      });

      expect(workspace.mode).toBe("git_worktree");
      expect(workspace.path).toBe(path.join(fixture, ".forge", "worktrees", session.metadata.id));
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
    expect(spawnCalls[0]?.args[4]).toBe([
      "Fix the failing retry-policy tests without modifying tests, package.json, or the public API.",
      "Keep implementation changes within src/** and keep the solution focused.",
      "Track the work as one edit task with npm test as its verification command.",
      "Use one synchronous isolated edit child for the implementation, then verify and integrate the result before finishing.",
    ].join(" "));
    expect(spawnCalls[0]?.args[4]).not.toMatch(/slugify|task_001|maxToolRounds|task_create|task_transition|task_verify|src\/retry\.mjs/i);
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps wrapper guidance before and after the inherited Forge transcript", async () => {
    const output: string[] = [];
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        return createLivePortfolioFixture();
      },
      runFixtureTests: async () => 1,
      spawnCli(_command, _args, options) {
        output.push("[runtime] original Forge transcript");
        return completedProcess(async () => {
          await writePassingRootEvidence(options.cwd);
          return { exitCode: 0, signal: null };
        });
      },
      writeLine(line) {
        output.push(line);
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "verified_session_evidence", status: "PASS" });
    expect(output).toEqual([
      "[demo] Created a disposable retry fixture.",
      "[demo] Initial tests fail as expected.",
      "[demo] ----- Forge Runtime transcript begins -----",
      "[runtime] original Forge transcript",
      "[demo] ----- Forge Runtime transcript ends -----",
      "[demo] Verified the isolated child edit, passing tests, Git receipt, final root Git state, and finalization.",
      "[demo] PASS",
    ]);
  });

  it("rejects a zero child exit when root Session evidence is absent and still cleans up", async () => {
    let fixture = "";
    const output: string[] = [];
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        fixture = await createLivePortfolioFixture();
        return fixture;
      },
      runFixtureTests: async () => 1,
      spawnCli: () => completedProcess(async () => ({ exitCode: 0, signal: null })),
      writeLine(line) {
        output.push(line);
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "invalid_session_evidence", status: "FAIL" });
    expect(output.at(-1)).toBe(
      "[demo] The run finished, but the expected c17c evidence or final root Git state was invalid.",
    );
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

  it("accepts graceful CLI cleanup after a completed root Session", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);

      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts hook results emitted by completed Session and cleanup events", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture, { postCoreHooks: true });

      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expectedTail: [
        { status: "completed", type: "session_ended" },
        { mode: "graceful", type: "team_cleanup" },
      ],
      hooks: false,
      label: "without hooks",
    },
    {
      expectedTail: [
        { status: "completed", type: "session_ended" },
        { sourceEventType: "session_ended", type: "hook_result" },
        { mode: "graceful", type: "team_cleanup" },
        { sourceEventType: "team_cleanup", type: "hook_result" },
      ],
      hooks: true,
      label: "with hooks",
    },
  ])("records the real CLI component teardown tail $label", async ({ expectedTail, hooks }) => {
    const fixture = await createLivePortfolioFixture();

    try {
      const session = await createCliSessionTrace({
        cwd: fixture,
        maxToolRounds: 1,
        model: "test-model",
        task: "characterize the root CLI teardown",
      });
      const lifecycleHooks: LifecycleHook[] = hooks
        ? [{
            events: ["session_ended", "team_cleanup"],
            handle() {
              // The real lifecycle emitter records the hook result.
            },
            name: "portfolio-tail",
          }]
        : [];
      const lifecycleEmitter = createLifecycleEmitter({
        hooks: lifecycleHooks,
        recorder: session.recorder,
      });
      const teammateManager = createTeammateManager({
        baseCwd: fixture,
        lifecycleEmitter,
        rootSessionId: session.metadata.id,
        teamRoot: path.join(session.paths.sessionDir, "team"),
      });
      await teammateManager.initialize();

      await runMinimalLoop({
        apiKey: "",
        baseURL: "",
        contextCompaction: false,
        cwd: fixture,
        lifecycleEmitter,
        maxToolRounds: 1,
        model: "test-model",
        promptAssets: { skills: [] },
        responseCreate: async () => ({ output: [], output_text: "done" }),
        task: "characterize the root CLI teardown",
        teammates: teammateManager,
      });
      await teammateManager.close();

      const events = await readTraceEvents(session.paths.tracePath);
      expect(events.slice(-expectedTail.length)).toEqual(
        expectedTail.map((expected) => expect.objectContaining(expected)),
      );
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it.each([
    ["a model response", {
      functionCallCount: 0,
      outputText: "late model output",
      round: 10,
      type: "model_response",
    }],
    ["a tool call", {
      argumentsText: "{}",
      callId: "late-tool",
      round: 10,
      toolName: "read",
      type: "tool_call",
    }],
    ["a verification", {
      command: "npm test",
      exitCode: 0,
      name: "command",
      round: 10,
      status: "passed",
      summary: "late verification",
      type: "verification_result",
    }],
    ["a task mutation", {
      operation: "update",
      revision: 9,
      taskId: "task_001",
      type: "task_graph_mutated",
    }],
  ])("rejects %s after the completed root Session", async (_label, payload) => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      await appendRootTraceEvents(fixture, [payload]);

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/completion evidence/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it.each([
    ["missing cleanup", (events: Array<Record<string, unknown>>) => (
      events.filter((event) => event.type !== "team_cleanup")
    )],
    ["a second cleanup", (events: Array<Record<string, unknown>>) => [
      ...events,
      traceEnvelope(events, { mode: "graceful", stopped: [], type: "team_cleanup" }),
    ]],
    ["terminate cleanup", (events: Array<Record<string, unknown>>) => events.map((event) => (
      event.type === "team_cleanup" ? { ...event, mode: "terminate" } : event
    ))],
  ])("rejects $0 in the post-core tail", async (_label, mutate) => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      await rewriteTrace(rootSessionDir, mutate);

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/completion evidence/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts two manually approved child mutations", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);

      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts variable task wording, a later generated task ID, and multiple src changes without artifact evidence", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture, {
        acceptance: ["Retry policy behavior matches the tests"],
        changedFiles: ["src/retry.mjs", "src/retryPolicy.mjs"],
        description: "Correct the bounded retry behavior.",
        taskSequence: 2,
        title: "Correct retry semantics",
      });

      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it.each([
    ["a test edit", ["src/retry.mjs", "test/retry.test.mjs"]],
    ["a package edit", ["src/retry.mjs", "package.json"]],
    ["a path traversal", ["src/retry.mjs", "src/../test/retry.test.mjs"]],
  ])("rejects %s outside the src-only patch boundary", async (_label, changedFiles) => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture, { changedFiles });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/outside src/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts one clean source-only integration that passes in the final root Worktree", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture);

      await expect(execFileAsync("npm", ["test"], { cwd: evidence.rootWorkspacePath }))
        .resolves.toMatchObject({});
      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects an uncommitted out-of-scope edit in the final root Worktree", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture);
      await fs.appendFile(path.join(evidence.rootWorkspacePath, "package.json"), "\n", "utf8");

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/root worktree.*clean/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects an additional root commit after the recorded integration", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture);
      await fs.writeFile(
        path.join(evidence.rootWorkspacePath, "root-note.txt"),
        "created after integration\n",
        "utf8",
      );
      await runGit(evidence.rootWorkspacePath, ["add", "root-note.txt"]);
      await runGit(evidence.rootWorkspacePath, [
        "commit",
        "--no-gpg-sign",
        "-qm",
        "post-integration root edit",
      ]);

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/root HEAD.*receipt/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects an integration receipt that does not match the actual root HEAD", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture);
      await rewriteRootTaskGraph(fixture, (graph) => {
        const task = requireMutablePortfolioTask(graph);
        task.integrationReceipt.integratedCommit = evidence.receipt.targetBefore;
      });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/root HEAD.*receipt/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects a final base-to-HEAD path set that differs from the child submission", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture, {
        actualChangedFiles: ["src/retry.mjs", "src/retryPolicy.mjs"],
      });
      await rewriteRootTaskGraph(fixture, (graph) => {
        const task = requireMutablePortfolioTask(graph);
        task.submission.changedFiles = ["src/retry.mjs"];
      });
      const rootSessionDir = await findRootSessionDir(fixture);
      await rewriteTrace(rootSessionDir, (events) => events.map((event) => (
        event.type === "child_session_handoff"
          ? { ...event, changedFiles: ["src/retry.mjs"] }
          : event
      )));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/root.*path set/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects an integration targetBefore that is not the root Worktree base", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture);
      await rewriteRootTaskGraph(fixture, (graph) => {
        const task = requireMutablePortfolioTask(graph);
        task.integrationReceipt.targetBefore = evidence.receipt.integratedCommit;
      });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/root.*base/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects option-shaped root commit evidence without Git side effects", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const outputPath = path.join(fixture, "git-diff-option-output..HEAD");
      const optionShapedBase = `--output=${path.join(fixture, "git-diff-option-output")}`;
      const rootSessionDir = await findRootSessionDir(fixture);
      const metadataPath = path.join(rootSessionDir, "session.json");
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
        workspace: { baseCommit: string };
      };
      metadata.workspace.baseCommit = optionShapedBase;
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      await rewriteTrace(rootSessionDir, (events) => events.map((event) => (
        event.type === "workspace_created"
          ? { ...event, baseCommit: optionShapedBase }
          : event
      )));
      await rewriteRootTaskGraph(fixture, (graph) => {
        const task = requireMutablePortfolioTask(graph);
        task.integrationReceipt.targetBefore = optionShapedBase;
      });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toBeInstanceOf(Error);
      await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects a root workspace path that is not an actual Git top-level", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture);
      await fs.unlink(path.join(evidence.rootWorkspacePath, ".git"));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/root Git top-level/i);
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
    { role: "child" as const, toolName: "write" },
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

  it.each([
    { role: "root" as const, toolName: "delegate" },
    { role: "child" as const, toolName: "edit" },
    { role: "child" as const, toolName: "write" },
    { role: "root" as const, toolName: "task_verify" },
    { role: "root" as const, toolName: "task_integrate" },
  ])("rejects an orphan approval pair without $toolName execution", async ({ role, toolName }) => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const sessionDir = role === "root"
        ? await findRootSessionDir(fixture)
        : await findChildSessionDir(fixture);
      await rewriteTrace(sessionDir, (events) => events.filter((event) => !(
        (event.type === "tool_call" || event.type === "tool_result")
        && event.toolName === toolName
      )));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/execution/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("binds the delegate execution call ID to the child parent call ID", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      await rewriteTrace(rootSessionDir, (events) => events.map((event) => (
        "toolName" in event && event.toolName === "delegate"
          ? { ...event, callId: "different-delegate-call" }
          : event
      )));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/child handoff/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects a failed tool execution after manual approval", async () => {
    const fixture = await createLivePortfolioFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      await rewriteTrace(rootSessionDir, (events) => events.map((event) => (
        event.type === "tool_result" && event.toolName === "task_verify"
          ? { ...event, status: "failed" }
          : event
      )));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/execution/i);
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

  it("stops a Live run after ten minutes without inventing a Runtime failure code", async () => {
    let fixture = "";
    let settle: ((result: { exitCode: null; signal: NodeJS.Signals }) => void) | undefined;
    let triggerTimeout: (() => void) | undefined;
    const killedWith: NodeJS.Signals[] = [];
    const output: string[] = [];

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        fixture = await createLivePortfolioFixture();
        return fixture;
      },
      runFixtureTests: async () => 1,
      scheduleForceKill(handler) {
        handler();
        return () => undefined;
      },
      scheduleRunTimeout(handler) {
        triggerTimeout = handler;
        return () => undefined;
      },
      spawnCli() {
        const completion = new Promise<{ exitCode: null; signal: NodeJS.Signals }>((resolve) => {
          settle = resolve;
          setTimeout(() => resolve({ exitCode: null, signal: "SIGTERM" }), 20);
        });
        queueMicrotask(() => triggerTimeout?.());
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
      writeLine(line) {
        output.push(line);
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "timed_out", status: "FAIL" });
    expect(killedWith).toEqual(["SIGTERM", "SIGKILL"]);
    expect(output.at(-1)).toBe("[demo] Forge run exceeded 10 minutes and was stopped.");
    expect(output.join("\n")).not.toMatch(/timed_out|stage=|reason=/);
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts the ten-minute limit before creating the disposable fixture", async () => {
    const order: string[] = [];

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async createFixture() {
        order.push("fixture");
        throw new Error("stop after recording timer order");
      },
      scheduleRunTimeout() {
        order.push("timeout");
        return () => undefined;
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "setup_failed", status: "FAIL" });
    expect(order).toEqual(["timeout", "fixture"]);
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
    scheduleRunTimeout: () => () => undefined,
    spawnCli: () => {
      throw new Error("unexpected child spawn");
    },
    writeLine: () => undefined,
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

interface PassingRootEvidenceOptions {
  acceptance?: string[];
  actualChangedFiles?: string[];
  changedFiles?: string[];
  description?: string;
  includeArtifactEvidence?: boolean;
  postCoreHooks?: boolean;
  taskSequence?: 1 | 2;
  title?: string;
}

interface PassingRootEvidence {
  receipt: TeamTaskIntegrationReceipt;
  rootWorkspacePath: string;
}

async function writePassingRootEvidence(
  cwd: string,
  options: PassingRootEvidenceOptions = {},
): Promise<PassingRootEvidence> {
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
  const rootWorkspace = await prepareWorktreeSession({
    baseCwd: cwd,
    lifecycleEmitter: createLifecycleEmitter({ recorder: session.recorder }),
    sessionTrace: session,
  });
  const leader = { role: "leader" as const, sessionId: session.metadata.id };
  if (options.taskSequence === 2) {
    const placeholder = await store.create(leader, {
      acceptance: ["Placeholder is deleted before acquisition"],
      description: "Reserve the first generated task ID.",
      kind: "research",
      title: "Discarded placeholder",
    });
    await store.delete(leader, placeholder.task.id);
  }
  const created = await store.create(leader, {
    acceptance: options.acceptance ?? ["Retry policy tests pass"],
    description: options.description ?? "Repair retry policy behavior.",
    kind: "edit",
    title: options.title ?? "Repair retry policy",
    verificationCommand: "npm test",
  });
  const taskId = created.task.id;
  await store.transition(leader, {
    action: "assign",
    assignee: { role: "leader" },
    id: taskId,
  });

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
    task: "repair retry policy",
    taskGraph: {
      delegatedTaskId: taskId,
      rootSessionId: session.metadata.id,
      taskGraphPath: graph.taskGraphPath,
    },
  });
  const childWorkspace = await prepareWorktreeSession({
    baseCwd: cwd,
    lifecycleEmitter: createLifecycleEmitter({ recorder: childSession.recorder }),
    sessionTrace: childSession,
  });
  const child = {
    delegatedTaskId: taskId,
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
  await writePassingChildChanges(
    childWorkspace.path,
    options.actualChangedFiles ?? options.changedFiles ?? ["src/retry.mjs"],
  );
  const integration = createGitIntegrationService({ targetCwd: rootWorkspace.path });
  const snapshot = await integration.capture(source);
  const changedFiles = options.changedFiles ?? snapshot.changedFiles;

  await store.addEvidence(child, taskId, {
    callId: "child-write",
    ...(options.includeArtifactEvidence
      ? { references: [{ kind: "artifact" as const, value: changedFiles[0] as string }] }
      : {}),
    round: 1,
    summary: "Recorded the retry implementation handoff.",
  });
  await store.transition(leader, {
    action: "submit_result",
    changedFiles,
    fingerprint: snapshot.fingerprint,
    id: taskId,
    source,
    summary: "Registered child handoff.",
  });
  await store.recordVerification(leader, taskId, {
    command: "npm test",
    exitCode: 0,
    fingerprint: snapshot.fingerprint,
    summary: "passed",
  });
  const receipt = await integration.integrate((await store.get(taskId)).task);
  await store.recordIntegration(leader, taskId, receipt);
  await childSession.recorder.record({
    baseCwd: cwd,
    cwd: childWorkspace.path,
    maxToolRounds: 8,
    model: "test-model",
    task: "repair retry policy",
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
  await recordApprovedAction(childSession.recorder, "child-write-second", "write", 2);
  await childSession.recorder.record({ answer: "fixed", round: 3, type: "final_answer" });
  await childSession.recorder.record({ rounds: 3, status: "completed", type: "session_ended" });
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
  await recordApprovalRequest(session.recorder, "delegate-child", "delegate", 2);
  await session.recorder.record({
    childSessionId: child.sessionId,
    parentCallId: "delegate-child",
    profile: "edit",
    round: 2,
    runInBackground: false,
    task: "repair retry policy",
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
    changedFiles,
    childSessionId: child.sessionId,
    finalAnswer: "fixed",
    parentCallId: "delegate-child",
    profile: "edit",
    round: 2,
    tracePath: childSession.paths.tracePath,
    type: "child_session_handoff",
    workspace: childWorkspace,
  });
  await recordSuccessfulToolResult(session.recorder, "delegate-child", "delegate", 2);
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
  if (options.postCoreHooks) {
    await session.recorder.record({
      hookName: "portfolio-session-hook",
      sourceEventType: "session_ended",
      status: "completed",
      type: "hook_result",
    });
  }
  await session.recorder.record({ mode: "graceful", stopped: [], type: "team_cleanup" });
  if (options.postCoreHooks) {
    await session.recorder.record({
      hookName: "portfolio-cleanup-hook",
      sourceEventType: "team_cleanup",
      status: "completed",
      type: "hook_result",
    });
  }
  return {
    receipt,
    rootWorkspacePath: rootWorkspace.path,
  };
}

async function writePassingChildChanges(cwd: string, requestedFiles: string[]): Promise<void> {
  await fs.writeFile(
    path.join(cwd, "src", "retry.mjs"),
    [
      "export async function runWithRetry(operation, { maxAttempts, isRetryable }) {",
      "  for (let attempt = 1; ; attempt += 1) {",
      "    try {",
      "      return await operation();",
      "    } catch (error) {",
      "      if (!isRetryable(error) || attempt >= maxAttempts) {",
      "        throw error;",
      "      }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  if (requestedFiles.includes("src/retryPolicy.mjs")) {
    await fs.writeFile(
      path.join(cwd, "src", "retryPolicy.mjs"),
      "export const retryPolicy = \"bounded\";\n",
      "utf8",
    );
  }
  if (requestedFiles.includes("test/retry.test.mjs")) {
    await fs.appendFile(path.join(cwd, "test", "retry.test.mjs"), "\n", "utf8");
  }
  if (requestedFiles.includes("package.json")) {
    await fs.appendFile(path.join(cwd, "package.json"), "\n", "utf8");
  }
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

interface MutablePortfolioTaskGraph {
  tasks: Array<{
    integrationReceipt: TeamTaskIntegrationReceipt;
    submission: { changedFiles: string[] };
  }>;
}

function requireMutablePortfolioTask(
  graph: MutablePortfolioTaskGraph,
): MutablePortfolioTaskGraph["tasks"][number] {
  const task = graph.tasks[0];
  if (!task) {
    throw new Error("portfolio task not found");
  }
  return task;
}

async function rewriteRootTaskGraph(
  fixture: string,
  mutate: (graph: MutablePortfolioTaskGraph) => void,
): Promise<void> {
  const rootSessionDir = await findRootSessionDir(fixture);
  const graphPath = path.join(rootSessionDir, "task-graph.json");
  const graph = JSON.parse(
    await fs.readFile(graphPath, "utf8"),
  ) as MutablePortfolioTaskGraph;
  mutate(graph);
  await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
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

async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function readTraceEvents(tracePath: string): Promise<Array<Record<string, unknown>>> {
  return (await fs.readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function traceEnvelope(
  events: Array<Record<string, unknown>>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const terminal = events.at(-1);
  if (!terminal) {
    throw new Error("root trace is empty");
  }
  return {
    ...payload,
    sessionId: terminal.sessionId,
    timestamp: terminal.timestamp,
  };
}

async function appendRootTraceEvents(
  fixture: string,
  payloads: Array<Record<string, unknown>>,
): Promise<void> {
  const rootSessionDir = await findRootSessionDir(fixture);
  await rewriteTrace(rootSessionDir, (events) => {
    const terminal = events.at(-1);
    if (!terminal) {
      throw new Error("root trace is empty");
    }
    return [
      ...events,
      ...payloads.map((payload) => traceEnvelope(events, payload)),
    ];
  });
}

async function recordApprovedAction(
  recorder: TraceRecorder,
  callId: string,
  toolName: string,
  round: number,
): Promise<void> {
  await recordApprovalRequest(recorder, callId, toolName, round);
  await recordSuccessfulToolResult(recorder, callId, toolName, round);
}

async function recordApprovalRequest(
  recorder: TraceRecorder,
  callId: string,
  toolName: string,
  round: number,
): Promise<void> {
  await recorder.record({
    argumentsText: "{}",
    callId,
    round,
    toolName,
    type: "tool_call",
  });
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

async function recordSuccessfulToolResult(
  recorder: TraceRecorder,
  callId: string,
  toolName: string,
  round: number,
): Promise<void> {
  await recorder.record({
    callId,
    projectedOutput: "completed",
    round,
    status: "completed",
    toolName,
    type: "tool_result",
  });
}

async function expectFailedNpmTest(fixture: string): Promise<void> {
  await expect(execFileAsync("npm", ["test"], { cwd: fixture }))
    .rejects.toMatchObject({ code: 1 });
}
