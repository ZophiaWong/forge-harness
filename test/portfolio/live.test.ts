import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type {
  TeamTaskIntegrationReceipt,
  TeamTaskResultSource,
} from "../../src/domain/teamTask.js";
import { runMinimalLoop } from "../../src/core/minimalLoop.js";
import {
  allocateLivePortfolioFixture,
  initializeLivePortfolioFixture,
  LIVE_PORTFOLIO_PROMPT,
  runInitialFixtureTests,
  runLivePortfolioDemo,
  validateLivePortfolioEvidence,
  type InitialTestCompletion,
  type LivePortfolioDependencies,
  type LivePortfolioProcess,
  type LivePortfolioProcessResult,
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
  it("allocates the fixture path before initialization owns any contents", async () => {
    const fixture = await allocateLivePortfolioFixture();

    try {
      expect(await fs.readdir(fixture)).toEqual([]);

      await initializeLivePortfolioFixture(fixture, new AbortController().signal);

      expect(await fs.readFile(path.join(fixture, ".gitignore"), "utf8")).toBe(".forge/\n");
      await expect(execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: fixture }))
        .resolves.toMatchObject({});
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("leaves an allocated fixture for its outer owner when initialization fails", async () => {
    const fixture = await allocateLivePortfolioFixture();
    const controller = new AbortController();
    controller.abort();

    try {
      await expect(initializeLivePortfolioFixture(fixture, controller.signal))
        .rejects.toMatchObject({ name: "AbortError" });
      await expect(fs.access(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("stops initialization before the next Git command after cancellation is observed", async () => {
    const fixture = await allocateLivePortfolioFixture();
    const originalPath = process.env.PATH;
    const wrapperDir = await fs.mkdtemp(path.join(fixture, "git-wrapper-"));
    const logPath = path.join(fixture, "git-commands.log");
    const controller = new AbortController();
    const signal = controller.signal;
    const throwIfAborted = signal.throwIfAborted.bind(signal);

    try {
      const realGit = (await execFileAsync("which", ["git"], { encoding: "utf8" })).stdout.trim();
      await fs.writeFile(
        path.join(wrapperDir, "git"),
        [
          "#!/bin/sh",
          `printf '%s\\n' \"$*\" >> ${JSON.stringify(logPath)}`,
          `exec ${JSON.stringify(realGit)} \"$@\"`,
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${wrapperDir}${path.delimiter}${originalPath ?? ""}`;
      Object.defineProperty(signal, "throwIfAborted", {
        value() {
          try {
            if (readFileSync(logPath, "utf8").includes("init -q")) {
              controller.abort();
            }
          } catch {
            // The first Git command has not reached the process boundary yet.
          }
          throwIfAborted();
        },
      });

      await expect(initializeLivePortfolioFixture(fixture, signal))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(await fs.readFile(logPath, "utf8")).toBe("init -q\n");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts only the controlled two-failure initial retry state", async () => {
    const fixture = await allocateLivePortfolioFixture();
    let observedCompletion: InitialTestCompletion | undefined;

    try {
      await initializeLivePortfolioFixture(fixture, new AbortController().signal);

      await expect(runInitialFixtureTests(
        fixture,
        new AbortController().signal,
        (completion) => {
          observedCompletion = completion;
        },
      ))
        .resolves.toBe("expected_failure");
      expect(observedCompletion).toMatchObject({
        command: "npm test",
        exitCode: 1,
        output: expect.stringContaining("# fail 2"),
        signal: null,
      });

      const testPath = path.join(fixture, "test", "retry.test.mjs");
      const tests = await fs.readFile(testPath, "utf8");
      await fs.writeFile(
        testPath,
        tests.replace(
          "maxAttempts is the total operation limit",
          "uses a different failing policy name",
        ),
        "utf8",
      );

      await expect(runInitialFixtureTests(fixture, new AbortController().signal))
        .rejects.toThrow(/initial test result/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("does not launch npm when cancellation is observed after opening output capture", async () => {
    const fixture = await allocateLivePortfolioFixture();
    const originalPath = process.env.PATH;
    const wrapperDir = await fs.mkdtemp(path.join(fixture, "npm-wrapper-"));
    const markerPath = path.join(fixture, "npm-launched");
    const controller = new AbortController();
    const signal = controller.signal;
    const throwIfAborted = signal.throwIfAborted.bind(signal);
    let cancellationChecks = 0;

    try {
      await fs.writeFile(
        path.join(wrapperDir, "npm"),
        [
          "#!/bin/sh",
          `printf 'launched\\n' > ${JSON.stringify(markerPath)}`,
          "printf 'TAP version 13\\nok 1 - first passing test\\nok 2 - second passing test\\nnot ok 3 - maxAttempts is the total operation limit\\nnot ok 4 - stops immediately for a permanent failure\\n1..4\\n# tests 4\\n# pass 2\\n# fail 2\\n'",
          "exit 1",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${wrapperDir}${path.delimiter}${originalPath ?? ""}`;
      Object.defineProperty(signal, "throwIfAborted", {
        value() {
          cancellationChecks += 1;
          if (cancellationChecks === 3) {
            controller.abort();
          }
          throwIfAborted();
        },
      });

      await expect(runInitialFixtureTests(fixture, signal))
        .rejects.toMatchObject({ name: "AbortError" });
      await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("distinguishes a repaired fixture from malformed or unexpected test failures", async () => {
    const fixture = await allocateLivePortfolioFixture();

    try {
      await initializeLivePortfolioFixture(fixture, new AbortController().signal);
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
        "utf8",
      );

      await expect(runInitialFixtureTests(fixture, new AbortController().signal))
        .resolves.toBe("passed");

      const packagePath = path.join(fixture, "package.json");
      const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8")) as {
        scripts: { test: string };
      };
      packageJson.scripts.test = "node -e \"console.log('not TAP'); process.exit(1)\"";
      await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
      await expect(runInitialFixtureTests(fixture, new AbortController().signal))
        .rejects.toThrow(/initial test output/i);

      packageJson.scripts.test = [
        "node -e \"",
        "console.log('not ok 1 - maxAttempts is the total operation limit\\n",
        "not ok 2 - stops immediately for a permanent failure\\n",
        "# tests 4\\n# pass 2\\n# fail 2'); process.exit(1)\"",
      ].join("");
      await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
      await expect(runInitialFixtureTests(fixture, new AbortController().signal))
        .rejects.toThrow(/initial test output/i);

      packageJson.scripts.test = [
        "node -e \"",
        "console.log('TAP version 13\\nBail out! setup crashed\\n",
        "ok 1 - first passing test\\nok 2 - second passing test\\n",
        "not ok 3 - maxAttempts is the total operation limit\\n",
        "not ok 4 - stops immediately for a permanent failure\\n",
        "1..4\\n# tests 4\\n# pass 2\\n# fail 2'); process.exit(1)\"",
      ].join("");
      await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
      await expect(runInitialFixtureTests(fixture, new AbortController().signal))
        .rejects.toThrow(/initial test output/i);

      packageJson.scripts.test = "node -e \"process.exit(2)\"";
      await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
      await expect(runInitialFixtureTests(fixture, new AbortController().signal))
        .rejects.toThrow(/unexpected exit/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("loads the Forge environment before preflight and refuses missing explicit model settings", async () => {
    const calls: string[] = [];
    const environment: NodeJS.ProcessEnv = {};

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(environment),
      async allocateFixture() {
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
      async allocateFixture() {
        fixtureStarts += 1;
        throw new Error("fixture must not be created");
      },
      isInteractiveTerminal: () => tty,
    });

    expect(result).toMatchObject({ reason, status: "UNAVAILABLE" });
    expect(fixtureStarts).toBe(0);
  });

  it("creates a dependency-free retry fixture with two intentional policy failures", async () => {
    const fixture = await createInitializedFixture();

    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(fixture, "package.json"), "utf8")) as {
        dependencies?: unknown;
        scripts?: Record<string, string>;
      };
      expect(packageJson.dependencies).toBeUndefined();
      expect(packageJson.scripts).toEqual({ test: "node test/retry.test.mjs" });
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
    const fixture = await createInitializedFixture();

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
      async allocateFixture() {
        fixture = await allocateLivePortfolioFixture();
        return fixture;
      },
      async runFixtureTests(cwd) {
        await expect(execFileAsync("npm", ["test"], { cwd })).rejects.toMatchObject({ code: 1 });
        return "expected_failure";
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
      "Before implementation, create one todo snapshot with four persistent items: inspection, isolated child implementation, task verification, and integration; do not delete or replace them.",
      "Track the work as one edit task with npm test as its verification command.",
      "Assign the edit task to the Leader before delegating.",
      "Use exactly one synchronous isolated edit child with maxToolRounds set to 8 for the implementation.",
      "After the child returns, record evidence and submit its result using the returned childSessionId.",
      "Only after the result is submitted, verify it with npm test; integrate only after verification passes.",
    ].join(" "));
    expect(spawnCalls[0]?.args[4]).not.toMatch(/slugify|task_001|task_create|task_transition|task_verify|src\/retry\.mjs/i);
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps wrapper guidance before and after the inherited Forge transcript", async () => {
    const output: string[] = [];
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async allocateFixture() {
        return allocateLivePortfolioFixture();
      },
      runFixtureTests: async () => "expected_failure",
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
      async allocateFixture() {
        fixture = await allocateLivePortfolioFixture();
        return fixture;
      },
      runFixtureTests: async () => "expected_failure",
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

  it("aborts injected evidence validation and ignores its late resolution", async () => {
    let triggerTimeout: (() => void) | undefined;
    let validationCalls = 0;
    let validationSignal: AbortSignal | undefined;
    const output: string[] = [];

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-validation",
      initializeFixture: async () => undefined,
      removeFixture: async () => undefined,
      scheduleRunTimeout(handler) {
        triggerTimeout = handler;
        return () => undefined;
      },
      spawnCli: () => completedProcess(async () => ({ exitCode: 0, signal: null })),
      async validateEvidence(_fixture, signal) {
        validationCalls += 1;
        validationSignal = signal;
        triggerTimeout?.();
      },
      writeLine(line) {
        output.push(line);
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "timed_out", status: "FAIL" });
    expect(validationCalls).toBe(1);
    expect(validationSignal?.aborted).toBe(true);
    expect(output.at(-1)).toBe("[demo] Live walkthrough exceeded 10 minutes and was stopped.");
    expect(output.join("\n")).not.toMatch(/live-validation|stage=|reason=/);
  });

  it("keeps interruption precedence when injected evidence validation rejects late", async () => {
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-validation-rejection",
      initializeFixture: async () => undefined,
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      removeFixture: async () => undefined,
      spawnCli: () => completedProcess(async () => ({ exitCode: 0, signal: null })),
      async validateEvidence(_fixture, signal) {
        interrupt?.("SIGTERM");
        expect(signal.aborted).toBe(true);
        throw new Error("late validation rejection");
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "interrupted", status: "FAIL" });
  });

  it("rejects a root Trace whose final answer precedes passed verification", async () => {
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);

      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts hook results emitted by completed Session and cleanup events", async () => {
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);

      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts variable task wording, a later generated task ID, and multiple src changes without artifact evidence", async () => {
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture, { changedFiles });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/outside src/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts one clean source-only integration that passes in the final root Worktree", async () => {
    const fixture = await createInitializedFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture);

      await expect(execFileAsync("npm", ["test"], { cwd: evidence.rootWorkspacePath }))
        .resolves.toMatchObject({});
      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("stops after filesystem enumeration when evidence validation is cancelled", async () => {
    const fixture = await createInitializedFixture();
    const controller = new AbortController();
    const signal = controller.signal;
    const throwIfAborted = signal.throwIfAborted.bind(signal);
    let cancellationChecks = 0;
    Object.defineProperty(signal, "throwIfAborted", {
      value() {
        cancellationChecks += 1;
        if (cancellationChecks === 2) {
          controller.abort();
        }
        throwIfAborted();
      },
    });

    try {
      await writePassingRootEvidence(fixture);

      await expect(validateLivePortfolioEvidence(fixture, signal))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(cancellationChecks).toBe(2);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("aborts a running Git reconciliation and skips later Git checks", async () => {
    const fixture = await createInitializedFixture();
    const originalPath = process.env.PATH;
    const originalRealGit = process.env.FORGE_LIVE_REAL_GIT;
    const wrapperDir = path.join(fixture, "git-wrapper");
    const markerPath = path.join(fixture, "git-status-started");
    const logPath = path.join(fixture, "git-commands.log");

    try {
      await writePassingRootEvidence(fixture);
      const realGit = (await execFileAsync("which", ["git"], { encoding: "utf8" })).stdout.trim();
      await fs.mkdir(wrapperDir);
      await fs.writeFile(
        path.join(wrapperDir, "git"),
        [
          "#!/usr/bin/env node",
          "import { spawnSync } from 'node:child_process';",
          "import { appendFileSync, writeFileSync } from 'node:fs';",
          "const args = process.argv.slice(2);",
          `appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');`,
          "if (args[0] === 'status') {",
          `  writeFileSync(${JSON.stringify(markerPath)}, 'started\\n');`,
          "  setInterval(() => undefined, 1_000);",
          "  setTimeout(() => process.exit(0), 500);",
          "} else {",
          "  const result = spawnSync(process.env.FORGE_LIVE_REAL_GIT, args, { stdio: 'inherit' });",
          "  process.exit(result.status ?? 1);",
          "}",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${wrapperDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.FORGE_LIVE_REAL_GIT = realGit;
      const controller = new AbortController();
      const validation = validateLivePortfolioEvidence(fixture, controller.signal);
      await vi.waitFor(async () => {
        await expect(fs.access(markerPath)).resolves.toBeUndefined();
      });

      controller.abort();

      await expect(validation).rejects.toMatchObject({ name: "AbortError" });
      const commands = await fs.readFile(logPath, "utf8");
      expect(commands).toContain("rev-parse --show-toplevel");
      expect(commands).toContain("status --porcelain=v1 -z --untracked-files=all");
      expect(commands).not.toContain("rev-parse HEAD");
      expect(commands).not.toContain("diff --name-only");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalRealGit === undefined) {
        delete process.env.FORGE_LIVE_REAL_GIT;
      } else {
        process.env.FORGE_LIVE_REAL_GIT = originalRealGit;
      }
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("does not launch the next Git command after cancellation at a command boundary", async () => {
    const fixture = await createInitializedFixture();
    const originalPath = process.env.PATH;
    const originalRealGit = process.env.FORGE_LIVE_REAL_GIT;
    const wrapperDir = path.join(fixture, "boundary-git-wrapper");
    const logPath = path.join(fixture, "boundary-git-commands.log");

    try {
      await writePassingRootEvidence(fixture);
      const realGit = (await execFileAsync("which", ["git"], { encoding: "utf8" })).stdout.trim();
      await fs.mkdir(wrapperDir);
      await fs.writeFile(
        path.join(wrapperDir, "git"),
        [
          "#!/usr/bin/env node",
          "import { spawnSync } from 'node:child_process';",
          "import { appendFileSync } from 'node:fs';",
          "const args = process.argv.slice(2);",
          `appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');`,
          "const result = spawnSync(process.env.FORGE_LIVE_REAL_GIT, args, { stdio: 'inherit' });",
          "process.exit(result.status ?? 1);",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${wrapperDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.FORGE_LIVE_REAL_GIT = realGit;
      const controller = new AbortController();
      const signal = controller.signal;
      const throwIfAborted = signal.throwIfAborted.bind(signal);
      Object.defineProperty(signal, "throwIfAborted", {
        value() {
          try {
            if (readFileSync(logPath, "utf8").includes("rev-parse --show-toplevel")) {
              controller.abort();
            }
          } catch {
            // Reconciliation has not launched its first Git command yet.
          }
          throwIfAborted();
        },
      });

      await expect(validateLivePortfolioEvidence(fixture, signal))
        .rejects.toMatchObject({ name: "AbortError" });
      const commands = await fs.readFile(logPath, "utf8");
      expect(commands).toBe("rev-parse --show-toplevel\n");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalRealGit === undefined) {
        delete process.env.FORGE_LIVE_REAL_GIT;
      } else {
        process.env.FORGE_LIVE_REAL_GIT = originalRealGit;
      }
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects an uncommitted out-of-scope edit in the final root Worktree", async () => {
    const fixture = await createInitializedFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture);
      await fs.appendFile(path.join(evidence.rootWorkspacePath, "package.json"), "\n", "utf8");

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/root worktree.*clean/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects an additional root commit after the recorded integration", async () => {
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

    try {
      const evidence = await writePassingRootEvidence(fixture);
      await fs.unlink(path.join(evidence.rootWorkspacePath, ".git"));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/root Git top-level/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects a TaskGraph child source without its matching child Session", async () => {
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      await rewriteTrace(rootSessionDir, (events) => events.map((event) => (
        event.type === "tool_result" && event.toolName === "task_verify"
          ? { ...event, status: "failed" }
          : event
      )));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/final task verification/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts a healthy invalid task verification before the final successful verification", async () => {
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);
      await insertApprovedTaskVerificationAttempt(fixture, {
        callId: "verify-too-early",
        status: "failed",
        taskGraph: healthyInvalidInputProjection(),
      });

      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("accepts multiple healthy invalid task verifications before the final successful verification", async () => {
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);
      await insertApprovedTaskVerificationAttempt(fixture, {
        callId: "verify-too-early-1",
        status: "failed",
        taskGraph: healthyInvalidInputProjection(),
      });
      await insertApprovedTaskVerificationAttempt(fixture, {
        callId: "verify-too-early-2",
        status: "failed",
        taskGraph: healthyInvalidInputProjection(),
      });

      await expect(validateLivePortfolioEvidence(fixture)).resolves.toBeUndefined();
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects an invalid task verification after the final successful verification", async () => {
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);
      await insertApprovedTaskVerificationAttempt(fixture, {
        callId: "verify-after-success",
        placement: "after_final",
        status: "failed",
        taskGraph: healthyInvalidInputProjection(),
      });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/final task verification/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it.each([
    {
      label: "a failed result without TaskGraph evidence",
      status: "failed" as const,
      taskGraph: undefined,
    },
    {
      label: "an unhealthy invalid_input",
      status: "failed" as const,
      taskGraph: {
        ...healthyInvalidInputProjection(),
        health: "degraded",
      },
    },
    {
      label: "a healthy projection without an error",
      status: "failed" as const,
      taskGraph: { health: "healthy" },
    },
    {
      label: "a verifier command failure",
      status: "failed" as const,
      taskGraph: taskGraphFailureProjection("verification_failed"),
    },
    {
      label: "source drift",
      status: "failed" as const,
      taskGraph: taskGraphFailureProjection("source_drift"),
    },
    {
      label: "a blocked invalid_input",
      status: "blocked" as const,
      taskGraph: healthyInvalidInputProjection(),
    },
    {
      label: "a timed-out invalid_input",
      status: "timed_out" as const,
      taskGraph: healthyInvalidInputProjection(),
    },
  ])("rejects $label before the final successful verification", async ({ status, taskGraph }) => {
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);
      await insertApprovedTaskVerificationAttempt(fixture, {
        callId: "verify-not-recoverable",
        status,
        ...(taskGraph ? { taskGraph } : {}),
      });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/final task verification/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects two successful task verification executions", async () => {
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);
      await insertApprovedTaskVerificationAttempt(fixture, {
        callId: "verify-success-duplicate",
        status: "completed",
      });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/final task verification/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it.each([
    {
      label: "denied",
      mutate: (event: Record<string, unknown>) => (
        event.type === "approval_result" && event.toolName === "task_verify"
          ? { ...event, approved: false }
          : event
      ),
    },
    {
      label: "auto-allowed",
      mutate: (event: Record<string, unknown>) => (
        event.type === "permission_decision" && event.toolName === "task_verify"
          ? { ...event, action: "allow" }
          : event
      ),
    },
  ])("rejects $label task verification evidence", async ({ mutate }) => {
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      await rewriteTrace(rootSessionDir, (events) => events.map(mutate));

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/approval/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects out-of-order task verification approval evidence", async () => {
    const fixture = await createInitializedFixture();

    try {
      await writePassingRootEvidence(fixture);
      const rootSessionDir = await findRootSessionDir(fixture);
      await rewriteTrace(rootSessionDir, (events) => {
        const decisionIndex = events.findIndex((event) => (
          event.type === "permission_decision" && event.toolName === "task_verify"
        ));
        const approvalIndex = events.findIndex((event) => (
          event.type === "approval_result" && event.toolName === "task_verify"
        ));
        const reordered = [...events];
        [reordered[decisionIndex], reordered[approvalIndex]] = [
          reordered[approvalIndex] as Record<string, unknown>,
          reordered[decisionIndex] as Record<string, unknown>,
        ];
        return reordered;
      });

      await expect(validateLivePortfolioEvidence(fixture)).rejects.toThrow(/approval/i);
    } finally {
      await fs.rm(fixture, { force: true, recursive: true });
    }
  });

  it("rejects child source metadata outside the Runtime worktree convention", async () => {
    const fixture = await createInitializedFixture();

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
    const fixture = await createInitializedFixture();

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
      async allocateFixture() {
        fixture = await allocateLivePortfolioFixture();
        return fixture;
      },
      runFixtureTests: async () => "expected_failure",
      spawnCli: () => completedProcess(async () => ({ exitCode: 1, signal: null })),
    });

    expect(result).toEqual({ cleaned: true, reason: "child_failed", status: "FAIL" });
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies fixture initialization errors as setup failures", async () => {
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async initializeFixture() {
        throw new Error("injected git setup failure");
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "setup_failed", status: "FAIL" });
  });

  it("classifies initial test contract errors as setup failures", async () => {
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async runFixtureTests() {
        throw new Error("injected malformed initial TAP");
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "setup_failed", status: "FAIL" });
  });

  it("keeps timeout precedence when pending initial tests reject late", async () => {
    const initialTests = deferred<"expected_failure">();
    const initialTestsStarted = deferred<void>();
    let triggerTimeout: (() => void) | undefined;
    let sharedSignal: AbortSignal | undefined;
    let childStarts = 0;

    const resultPromise = runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-initial-tests",
      initializeFixture: async () => undefined,
      removeFixture: async () => undefined,
      runFixtureTests(_fixture, signal) {
        sharedSignal = signal;
        initialTestsStarted.resolve(undefined);
        return initialTests.promise;
      },
      scheduleRunTimeout(handler) {
        triggerTimeout = handler;
        return () => undefined;
      },
      spawnCli() {
        childStarts += 1;
        throw new Error("child must not start");
      },
    });

    await initialTestsStarted.promise;
    triggerTimeout?.();
    expect(sharedSignal?.aborted).toBe(true);
    initialTests.reject(new Error("late initial test rejection"));

    await expect(resultPromise).resolves.toEqual({
      cleaned: true,
      reason: "timed_out",
      status: "FAIL",
    });
    expect(childStarts).toBe(0);
  });

  it("classifies child spawn errors as generic launcher setup failures", async () => {
    const output: string[] = [];
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/private-live-spawn",
      initializeFixture: async () => undefined,
      removeFixture: async () => undefined,
      spawnCli() {
        throw new Error("spawn ENOENT for /test/private-live-spawn");
      },
      writeLine(line) {
        output.push(line);
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "setup_failed", status: "FAIL" });
    expect(output.at(-1)).toBe("[demo] The Live walkthrough could not be started.");
    expect(output.join("\n")).not.toMatch(/ENOENT|private-live-spawn|stage=|reason=/);
  });

  it("classifies a rejected child completion as a spawn setup failure", async () => {
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-child-error",
      initializeFixture: async () => undefined,
      removeFixture: async () => undefined,
      spawnCli: () => ({
        completion: Promise.reject(new Error("spawn error event")),
        kill() {
          // The child never reached an executable state.
        },
      }),
    });

    expect(result).toEqual({ cleaned: true, reason: "setup_failed", status: "FAIL" });
  });

  it("keeps a launcher failure after zero child exit out of child_failed", async () => {
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-post-child-launcher-failure",
      initializeFixture: async () => undefined,
      removeFixture: async () => undefined,
      spawnCli: () => completedProcess(async () => ({ exitCode: 0, signal: null })),
      writeLine(line) {
        if (line === "[demo] ----- Forge Runtime transcript ends -----") {
          throw new Error("injected launcher output failure");
        }
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
      async allocateFixture() {
        fixture = await allocateLivePortfolioFixture();
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
      runFixtureTests: async () => "expected_failure",
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

  it("forwards a re-entrant spawn interrupt after the child becomes available", async () => {
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    const killedWith: NodeJS.Signals[] = [];

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-spawn",
      initializeFixture: async () => undefined,
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      removeFixture: async () => undefined,
      scheduleForceKill(handler) {
        handler();
        return () => undefined;
      },
      spawnCli() {
        interrupt?.("SIGTERM");
        return {
          completion: Promise.resolve({ exitCode: 0, signal: null }),
          kill(signal) {
            killedWith.push(signal);
          },
        };
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "interrupted", status: "FAIL" });
    expect(killedWith).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cancels the armed force kill as soon as the child settles", async () => {
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    let forceKillCancellations = 0;
    let forceKillCancelledBeforeCleanup = false;

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-force-kill",
      initializeFixture: async () => undefined,
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      async removeFixture() {
        forceKillCancelledBeforeCleanup = forceKillCancellations === 1;
      },
      scheduleForceKill() {
        return () => {
          forceKillCancellations += 1;
        };
      },
      spawnCli() {
        const completion = deferred<LivePortfolioProcessResult>();
        queueMicrotask(() => interrupt?.("SIGINT"));
        queueMicrotask(() => completion.resolve({ exitCode: null, signal: "SIGINT" }));
        return {
          completion: completion.promise,
          kill() {
            // Settlement is controlled independently to expose timer cleanup ordering.
          },
        };
      },
    });

    expect(result).toEqual({ cleaned: true, reason: "interrupted", status: "FAIL" });
    expect(forceKillCancelledBeforeCleanup).toBe(true);
    expect(forceKillCancellations).toBe(1);
  });

  it("stops a Live run after ten minutes without inventing a Runtime failure code", async () => {
    let fixture = "";
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    let settle: ((result: { exitCode: null; signal: NodeJS.Signals }) => void) | undefined;
    let triggerTimeout: (() => void) | undefined;
    const killedWith: NodeJS.Signals[] = [];
    const output: string[] = [];

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async allocateFixture() {
        fixture = await allocateLivePortfolioFixture();
        return fixture;
      },
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      runFixtureTests: async () => "expected_failure",
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
        queueMicrotask(() => {
          triggerTimeout?.();
          triggerTimeout?.();
          interrupt?.("SIGINT");
        });
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
    expect(output.at(-1)).toBe("[demo] Live walkthrough exceeded 10 minutes and was stopped.");
    expect(output.join("\n")).not.toMatch(/timed_out|stage=|reason=/);
    await expect(fs.access(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts the ten-minute limit before creating the disposable fixture", async () => {
    const order: string[] = [];

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async allocateFixture() {
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

  it("stops after a pending allocation resolves and removes its fixture exactly once", async () => {
    const allocation = deferred<string>();
    const allocationStarted = deferred<void>();
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    let initializationStarts = 0;
    const removed: string[] = [];

    const resultPromise = runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture() {
        allocationStarted.resolve(undefined);
        return allocation.promise;
      },
      async initializeFixture() {
        initializationStarts += 1;
      },
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      async removeFixture(fixture) {
        removed.push(fixture);
      },
    });

    await allocationStarted.promise;
    interrupt?.("SIGTERM");
    allocation.resolve("/test/live-allocation");

    await expect(resultPromise).resolves.toEqual({
      cleaned: true,
      reason: "interrupted",
      status: "FAIL",
    });
    expect(initializationStarts).toBe(0);
    expect(removed).toEqual(["/test/live-allocation"]);
  });

  it("keeps the first timeout reason when allocation resolves after later signals", async () => {
    const allocation = deferred<string>();
    const allocationStarted = deferred<void>();
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    let triggerTimeout: (() => void) | undefined;
    let initializationStarts = 0;
    const removed: string[] = [];

    const resultPromise = runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture() {
        allocationStarted.resolve(undefined);
        return allocation.promise;
      },
      async initializeFixture() {
        initializationStarts += 1;
      },
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      async removeFixture(fixture) {
        removed.push(fixture);
      },
      scheduleRunTimeout(handler) {
        triggerTimeout = handler;
        return () => undefined;
      },
    });

    await allocationStarted.promise;
    triggerTimeout?.();
    interrupt?.("SIGINT");
    interrupt?.("SIGTERM");
    allocation.resolve("/test/live-timeout-allocation");

    await expect(resultPromise).resolves.toEqual({
      cleaned: true,
      reason: "timed_out",
      status: "FAIL",
    });
    expect(initializationStarts).toBe(0);
    expect(removed).toEqual(["/test/live-timeout-allocation"]);
  });

  it("aborts pending initialization and ignores its late resolution", async () => {
    const initialization = deferred<void>();
    const initializationStarted = deferred<void>();
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    let sharedSignal: AbortSignal | undefined;
    let fixtureTests = 0;
    const output: string[] = [];

    const resultPromise = runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-initialization",
      initializeFixture(_fixture, signal) {
        sharedSignal = signal;
        initializationStarted.resolve(undefined);
        return initialization.promise;
      },
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      removeFixture: async () => undefined,
      async runFixtureTests() {
        fixtureTests += 1;
        return "expected_failure";
      },
      writeLine(line) {
        output.push(line);
      },
    });

    await initializationStarted.promise;
    interrupt?.("SIGINT");
    expect(sharedSignal?.aborted).toBe(true);
    initialization.resolve(undefined);

    await expect(resultPromise).resolves.toEqual({
      cleaned: true,
      reason: "interrupted",
      status: "FAIL",
    });
    expect(fixtureTests).toBe(0);
    expect(output).not.toContain("[demo] Created a disposable retry fixture.");
  });

  it("cleans up when interrupted while the fixture is still being created", async () => {
    let fixture = "";
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    let fixtureTests = 0;

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async allocateFixture() {
        fixture = await allocateLivePortfolioFixture();
        interrupt?.("SIGTERM");
        return fixture;
      },
      installSignalHandlers(handler) {
        interrupt = handler;
        return () => undefined;
      },
      async runFixtureTests() {
        fixtureTests += 1;
        return "expected_failure";
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
      async allocateFixture() {
        fixture = await allocateLivePortfolioFixture();
        return fixture;
      },
      async removeFixture() {
        throw new Error("injected cleanup failure");
      },
      runFixtureTests: async () => "expected_failure",
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

  it("lets one cleanup failure override an initialization failure", async () => {
    let cleanupCalls = 0;
    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-cleanup-precedence",
      async initializeFixture() {
        throw new Error("injected initialization failure");
      },
      async removeFixture() {
        cleanupCalls += 1;
        throw new Error("injected cleanup failure");
      },
    });

    expect(result).toEqual({ cleaned: false, reason: "cleanup_failed", status: "FAIL" });
    expect(cleanupCalls).toBe(1);
  });

  it("lets cleanup failure override the first cancellation reason", async () => {
    let triggerTimeout: (() => void) | undefined;
    let cleanupCalls = 0;

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async allocateFixture() {
        triggerTimeout?.();
        return "/test/live-cancel-cleanup-precedence";
      },
      async initializeFixture() {
        throw new Error("initialization must not begin");
      },
      async removeFixture() {
        cleanupCalls += 1;
        throw new Error("injected cleanup failure");
      },
      scheduleRunTimeout(handler) {
        triggerTimeout = handler;
        return () => undefined;
      },
    });

    expect(result).toEqual({ cleaned: false, reason: "cleanup_failed", status: "FAIL" });
    expect(cleanupCalls).toBe(1);
  });

  it("cancels the run timer before non-cancelled fixture cleanup", async () => {
    let timerCancelled = false;
    let handlersRemoved = false;
    let cleanupSawTimerCancelled = false;
    let cleanupSawHandlersInstalled = false;

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      allocateFixture: async () => "/test/live-cleanup-order",
      initializeFixture: async () => undefined,
      installSignalHandlers() {
        return () => {
          handlersRemoved = true;
        };
      },
      async removeFixture() {
        cleanupSawTimerCancelled = timerCancelled;
        cleanupSawHandlersInstalled = !handlersRemoved;
      },
      scheduleRunTimeout() {
        return () => {
          timerCancelled = true;
        };
      },
      spawnCli: () => completedProcess(async () => ({ exitCode: 1, signal: null })),
    });

    expect(result).toEqual({ cleaned: true, reason: "child_failed", status: "FAIL" });
    expect(cleanupSawTimerCancelled).toBe(true);
    expect(cleanupSawHandlersInstalled).toBe(true);
    expect(handlersRemoved).toBe(true);
  });

  it("keeps repeated signal handling active until async cleanup finishes", async () => {
    let fixture = "";
    let interrupt: ((signal: NodeJS.Signals) => void) | undefined;
    let handlersRemoved = false;
    let removedBeforeCleanup = false;

    const result = await runLivePortfolioDemo({
      ...preflightDependencies(configuredEnvironment()),
      async allocateFixture() {
        fixture = await allocateLivePortfolioFixture();
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
      runFixtureTests: async () => "expected_failure",
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

async function createInitializedFixture(): Promise<string> {
  const fixture = await allocateLivePortfolioFixture();
  try {
    await initializeLivePortfolioFixture(fixture, new AbortController().signal);
    return fixture;
  } catch (error) {
    await fs.rm(fixture, { force: true, recursive: true });
    throw error;
  }
}

function configuredEnvironment(): NodeJS.ProcessEnv {
  return { OPENAI_API_KEY: "test-only-key", OPENAI_MODEL: "test-model" };
}

function preflightDependencies(environment: NodeJS.ProcessEnv): LivePortfolioDependencies {
  return {
    allocateFixture: allocateLivePortfolioFixture,
    commandAvailable: async () => true,
    environment,
    forgeRoot: process.cwd(),
    initializeFixture: initializeLivePortfolioFixture,
    installSignalHandlers: () => () => undefined,
    isInteractiveTerminal: () => true,
    loadEnvironment: async () => undefined,
    removeFixture: async (fixture) => fs.rm(fixture, { force: true, recursive: true }),
    runFixtureTests: async () => "expected_failure",
    scheduleForceKill: () => () => undefined,
    scheduleRunTimeout: () => () => undefined,
    spawnCli: () => {
      throw new Error("unexpected child spawn");
    },
    validateEvidence: validateLivePortfolioEvidence,
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

function deferred<T>(): {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let rejectPromise!: (error: unknown) => void;
  let resolvePromise!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    reject: rejectPromise,
    resolve: resolvePromise,
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
  const store = createFileTeamTaskStore({
    graphPath: graph.taskGraphPath,
    now: monotonicTestClock(),
  });
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

interface ApprovedTaskVerificationAttempt {
  callId: string;
  placement?: "after_final" | "before_final";
  status: "blocked" | "completed" | "failed" | "timed_out";
  taskGraph?: Record<string, unknown>;
}

async function insertApprovedTaskVerificationAttempt(
  fixture: string,
  attempt: ApprovedTaskVerificationAttempt,
): Promise<void> {
  const rootSessionDir = await findRootSessionDir(fixture);
  await rewriteTrace(rootSessionDir, (events) => {
    const finalVerificationIndex = events.findIndex((event) => (
      event.type === (attempt.placement === "after_final" ? "tool_result" : "tool_call")
      && event.toolName === "task_verify"
    ));
    if (finalVerificationIndex < 0) {
      throw new Error("final task verification evidence not found");
    }
    const payloads: Array<Record<string, unknown>> = [
      {
        argumentsText: '{"command":"npm test","id":"task_001"}',
        callId: attempt.callId,
        round: 6,
        toolName: "task_verify",
        type: "tool_call",
      },
      {
        action: "ask",
        callId: attempt.callId,
        reason: "manual approval required",
        risk: "mutating",
        round: 6,
        toolName: "task_verify",
        type: "permission_decision",
      },
      {
        approved: true,
        callId: attempt.callId,
        round: 6,
        toolName: "task_verify",
        type: "approval_result",
      },
      {
        callId: attempt.callId,
        projectedOutput: `task_verify ${attempt.status}`,
        round: 6,
        status: attempt.status,
        ...(attempt.taskGraph ? { taskGraph: attempt.taskGraph } : {}),
        toolName: "task_verify",
        type: "tool_result",
      },
    ];
    const insertionIndex = attempt.placement === "after_final"
      ? finalVerificationIndex + 1
      : finalVerificationIndex;
    return [
      ...events.slice(0, insertionIndex),
      ...payloads.map((payload) => traceEnvelope(events, payload)),
      ...events.slice(insertionIndex),
    ];
  });
}

function healthyInvalidInputProjection(): Record<string, unknown> {
  return {
    error: {
      code: "invalid_input",
      message: 'task "task_001" has no submitted edit source',
    },
    health: "healthy",
  };
}

function taskGraphFailureProjection(code: string): Record<string, unknown> {
  return {
    error: {
      code,
      message: `task verification failed: ${code}`,
    },
    health: "healthy",
  };
}

function monotonicTestClock(): () => Date {
  let timestamp = Date.now();
  return () => new Date(timestamp++);
}

async function expectFailedNpmTest(fixture: string): Promise<void> {
  await expect(execFileAsync("npm", ["test"], { cwd: fixture }))
    .rejects.toMatchObject({ code: 1 });
}
