import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { config as loadDotEnv } from "dotenv";

import {
  assertEvidenceRunMayStart,
  beginEvidenceCapture,
  recordEvidenceCaptureFailure,
  reserveEvidenceRun,
  sealRunEvidence,
  type EvidenceCaptureResult,
} from "../runtime/evidenceBundle.js";
import {
  captureBuild,
  formatEvidenceTimestamp,
  runCapturedCommand,
  serializePrivateError,
  writeEvidenceJson,
  type CapturedCommandEvidence,
} from "../runtime/evidenceCollectorSupport.js";
import type {
  InitialTestCompletion,
  LivePortfolioDependencies,
  LivePortfolioProcess,
  LivePortfolioResult,
} from "./live.js";

const execFileAsync = promisify(execFile);

export interface SubjectLiveModule {
  allocateLivePortfolioFixture(): Promise<string>;
  initializeLivePortfolioFixture(fixture: string, signal: AbortSignal): Promise<void>;
  runInitialFixtureTests(
    fixture: string,
    signal: AbortSignal,
    observeCompletion?: (completion: Readonly<InitialTestCompletion>) => void,
  ): Promise<"expected_failure" | "passed">;
  runLivePortfolioDemo(dependencies: LivePortfolioDependencies): Promise<LivePortfolioResult>;
  validateLivePortfolioEvidence(fixture: string, signal?: AbortSignal): Promise<void>;
}

export type { CapturedCommandEvidence } from "../runtime/evidenceCollectorSupport.js";

export interface LiveEvidenceDependencies {
  buildSubject(subjectRoot: string): Promise<CapturedCommandEvidence>;
  captureFinalTests(fixture: string): Promise<CapturedCommandEvidence>;
  captureInitialTests(fixture: string): Promise<CapturedCommandEvidence>;
  environment: NodeJS.ProcessEnv;
  loadSubjectModule(modulePath: string): Promise<SubjectLiveModule>;
  now(): Date;
  randomSuffix(): string;
}

export interface RunLiveEvidenceOptions {
  intentPath: string;
  retryOf?: string;
}

export interface RunLiveEvidenceResult {
  capture: EvidenceCaptureResult;
  exitCode: 0 | 1 | 2;
  stagingRoot: string;
}

type InitialTestEvidenceSource =
  | "collector-replay"
  | "subject-validator"
  | "unavailable";

export async function runLiveEvidence(
  options: RunLiveEvidenceOptions,
  dependencies: LiveEvidenceDependencies = defaultDependencies(),
): Promise<RunLiveEvidenceResult> {
  const selection = await assertEvidenceRunMayStart({
    intentPath: options.intentPath,
    kind: "live",
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
    role: "live",
  });
  const intent = selection.intent;
  assertEnvironmentMatchesIntent(intent.environment, dependencies.environment);
  const sourceAtStart = await beginEvidenceCapture(intent);
  const startedAt = dependencies.now();
  const runId = createLiveRunId(startedAt, dependencies.randomSuffix());
  const reserved = await reserveEvidenceRun({
    intentPath: options.intentPath,
    kind: "live",
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
    role: "live",
    runId,
    startedAt: startedAt.toISOString(),
  });
  const intentRoot = path.dirname(path.resolve(options.intentPath));
  const runsRoot = path.join(intentRoot, "runs");
  const stagingRoot = path.join(intentRoot, "staging", runId);
  await fs.mkdir(path.dirname(stagingRoot), { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: false });
  await fs.mkdir(path.join(stagingRoot, "operator"), { recursive: true });
  await writeEvidenceJson(path.join(stagingRoot, "reservation.json"), reserved.reservation);

  let liveResult: LivePortfolioResult = {
    cleaned: true,
    reason: "setup_failed",
    status: "FAIL",
  };
  let preCleanupCaptureError: unknown;
  let executionError: unknown;
  let fixtureCaptureStarted = false;
  let finalTests: CapturedCommandEvidence | undefined;
  let initialTestEvidenceSource: InitialTestEvidenceSource = "unavailable";
  const build = await captureBuild(dependencies.buildSubject, intent.subject.checkout);
  await writeEvidenceJson(path.join(stagingRoot, "operator", "subject-build.json"), build);

  if (build.exitCode === 0 && build.signal === null) {
    try {
      const subject = await dependencies.loadSubjectModule(
        path.join(intent.subject.checkout, "dist", "portfolio", "live.js"),
      );
      liveResult = await subject.runLivePortfolioDemo(createSubjectDependencies({
        dependencies,
        expectedEnvironment: intent.environment,
        onCaptureError(error) {
          preCleanupCaptureError ??= error;
        },
        onFixtureCaptureStarted() {
          fixtureCaptureStarted = true;
        },
        onFixtureCaptured(result) {
          finalTests = result;
        },
        onInitialTestEvidence(source) {
          initialTestEvidenceSource = source;
        },
        stagingRoot,
        subject,
        subjectRoot: intent.subject.checkout,
      }));
    } catch (error) {
      executionError = error;
      liveResult = { cleaned: true, reason: "setup_failed", status: "FAIL" };
    }
  }

  const completedAt = dependencies.now();
  if (executionError) {
    await writeEvidenceJson(path.join(stagingRoot, "operator", "live-execution.json"), {
      error: serializePrivateError(executionError),
      status: "infrastructure-invalid",
    });
  }
  if (liveResult.status === "PASS"
    && (!finalTests || finalTests.exitCode !== 0 || finalTests.signal !== null)) {
    preCleanupCaptureError ??= new Error("final Live fixture tests did not pass");
  }
  await writeEvidenceJson(path.join(stagingRoot, "operator", "live-result.json"), liveResult);
  const publicReportPath = path.join(stagingRoot, "operator", "report.json");
  await writeEvidenceJson(publicReportPath, {
    cleaned: liveResult.cleaned,
    finalTests: finalTests
      ? { exitCode: finalTests.exitCode, signal: finalTests.signal }
      : { exitCode: null, signal: null },
    reason: liveResult.reason,
    status: liveResult.status,
    subjectBuild: { exitCode: build.exitCode, signal: build.signal },
  });
  const infrastructureInvalid = isInfrastructureInvalid(liveResult, build);
  const run = {
    baselineEligible: false,
    behavior: {
      infrastructureInvalid,
      verdict: `${liveResult.status}:${liveResult.reason}`,
    },
    completedAt: completedAt.toISOString(),
    infrastructureInvalid,
    kind: "live" as const,
    limitations: [initialTestEvidenceLimitation(initialTestEvidenceSource)],
    promotionEligible: fixtureCaptureStarted && !infrastructureInvalid,
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
    role: "live" as const,
    runId,
    startedAt: startedAt.toISOString(),
  };
  let capture: EvidenceCaptureResult;
  if (preCleanupCaptureError) {
    capture = await recordEvidenceCaptureFailure({
      intent,
      outputRoot: runsRoot,
      reasonCode: "live_capture_failed",
      run,
    });
  } else {
    capture = await sealRunEvidence({
      intent,
      now: dependencies.now,
      outputRoot: runsRoot,
      publicArtifacts: [{ name: "report.json", path: publicReportPath }],
      rawSources: [{ prefix: "live", root: stagingRoot }],
      run,
      sourceAtStart,
    });
  }
  return {
    capture,
    exitCode: capture.captureStatus === "failed" || infrastructureInvalid
      ? 2
      : liveResult.status === "PASS"
        ? 0
        : liveResult.status === "FAIL"
          ? 1
          : 2,
    stagingRoot,
  };
}

function createSubjectDependencies(options: {
  dependencies: LiveEvidenceDependencies;
  expectedEnvironment: { endpointHash: string; model: string; providerId: string };
  onCaptureError(error: unknown): void;
  onFixtureCaptureStarted(): void;
  onFixtureCaptured(result: CapturedCommandEvidence): void;
  onInitialTestEvidence(source: InitialTestEvidenceSource): void;
  stagingRoot: string;
  subject: SubjectLiveModule;
  subjectRoot: string;
}): LivePortfolioDependencies {
  return {
    allocateFixture: options.subject.allocateLivePortfolioFixture,
    async commandAvailable(command) {
      return execFileAsync(command, ["--version"]).then(
        () => true,
        () => false,
      );
    },
    environment: options.dependencies.environment,
    forgeRoot: options.subjectRoot,
    initializeFixture: options.subject.initializeLivePortfolioFixture,
    installSignalHandlers: installProcessSignalHandlers,
    isInteractiveTerminal: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async loadEnvironment(root, environment) {
      loadDotEnv({ path: path.join(root, ".env"), processEnv: environment, quiet: true });
      assertEnvironmentMatchesIntent(options.expectedEnvironment, environment);
    },
    async removeFixture(fixture) {
      options.onFixtureCaptureStarted();
      try {
        options.onFixtureCaptured(
          await captureLiveFixture(fixture, options.stagingRoot, options.dependencies),
        );
      } catch (error) {
        options.onCaptureError(error);
      }
      await fs.rm(fixture, { force: true, recursive: true });
    },
    async runFixtureTests(fixture, signal) {
      let result: "expected_failure" | "passed" | undefined;
      let validatorError: unknown;
      let subjectCompletion: Readonly<InitialTestCompletion> | undefined;
      try {
        result = await options.subject.runInitialFixtureTests(fixture, signal, (completion) => {
          subjectCompletion = completion;
        });
      } catch (error) {
        validatorError = error;
      }
      let replay: CapturedCommandEvidence | undefined;
      let replayError: unknown;
      if (!subjectCompletion && !validatorError) {
        try {
          replay = await captureLegacyInitialTests(fixture, options.dependencies);
        } catch (error) {
          replayError = error;
        }
      }
      const evidenceSource = subjectCompletion
        ? "subject-validator"
        : replay
          ? "collector-replay"
          : "unavailable";
      options.onInitialTestEvidence(evidenceSource);
      try {
        await writeEvidenceJson(path.join(options.stagingRoot, "operator", "initial-test.json"), {
          evidenceSource,
          ...(replay || replayError
            ? { collectorReplay: replay ?? { error: serializePrivateError(replayError) } }
            : {}),
          subjectValidator: {
            ...(subjectCompletion ? { completion: subjectCompletion } : {}),
            ...(result
              ? { result }
              : { error: serializePrivateError(validatorError), result: "error" }),
          },
        });
      } catch (error) {
        options.onCaptureError(error);
      }
      if (validatorError) {
        throw validatorError;
      }
      if (!replay) {
        if (!subjectCompletion) {
          options.onCaptureError(
            replayError ?? new Error("collector initial test replay was unavailable"),
          );
        }
      } else {
        const expectedExitCode = result === "passed" ? 0 : 1;
        if (replay.signal !== null || replay.exitCode !== expectedExitCode) {
          options.onCaptureError(
            new Error("collector initial test replay disagreed with the subject validator"),
          );
        }
      }
      return result as "expected_failure" | "passed";
    },
    scheduleForceKill(handler) {
      const timer = setTimeout(handler, 2_000);
      timer.unref();
      return () => clearTimeout(timer);
    },
    scheduleRunTimeout(handler) {
      const timer = setTimeout(handler, 10 * 60_000);
      timer.unref();
      return () => clearTimeout(timer);
    },
    spawnCli(command, args, spawnOptions): LivePortfolioProcess {
      const child = spawn(command, args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        shell: spawnOptions.shell,
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
    validateEvidence: options.subject.validateLivePortfolioEvidence,
    writeLine: (line) => console.log(line),
  };
}

async function captureLegacyInitialTests(
  fixture: string,
  dependencies: LiveEvidenceDependencies,
): Promise<CapturedCommandEvidence> {
  const replayRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-live-initial-replay-"));
  const replayFixture = path.join(replayRoot, "fixture");
  try {
    await fs.cp(fixture, replayFixture, { errorOnExist: true, force: false, recursive: true });
    return await dependencies.captureInitialTests(replayFixture);
  } finally {
    await fs.rm(replayRoot, { force: true, recursive: true });
  }
}

function initialTestEvidenceLimitation(
  source: InitialTestEvidenceSource,
): string {
  if (source === "subject-validator") {
    return "Initial test output came from the command completion consumed by the subject validator.";
  }
  if (source === "collector-replay") {
    return "This older subject did not expose its command completion; initial test output is a non-authoritative collector replay against an isolated fixture snapshot after the subject validator.";
  }
  return "The subject validator owned the initial verdict, but its raw command completion was unavailable to the collector.";
}

async function captureLiveFixture(
  fixture: string,
  stagingRoot: string,
  dependencies: LiveEvidenceDependencies,
): Promise<CapturedCommandEvidence> {
  const evidenceWorkspace = await resolveLiveEvidenceWorkspace(fixture);
  await Promise.all([
    copyIfExists(path.join(fixture, ".forge", "sessions"), path.join(stagingRoot, "sessions")),
    copyFixtureInputs(evidenceWorkspace, path.join(stagingRoot, "fixture")),
  ]);
  const gitRoot = path.join(stagingRoot, "git");
  await fs.mkdir(gitRoot, { recursive: true });
  let finalTests: CapturedCommandEvidence | undefined;
  let finalTestError: unknown;
  try {
    finalTests = await dependencies.captureFinalTests(evidenceWorkspace);
    await writeEvidenceJson(path.join(stagingRoot, "operator", "final-test.json"), finalTests);
  } catch (error) {
    finalTestError = error;
    await writeEvidenceJson(path.join(stagingRoot, "operator", "final-test.json"), {
      result: "collector-error",
    });
  }
  const [head, tree, status, diff] = await Promise.all([
    git(evidenceWorkspace, ["rev-parse", "HEAD"]),
    git(evidenceWorkspace, ["rev-parse", "HEAD^{tree}"]),
    git(evidenceWorkspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(evidenceWorkspace, ["diff", "--binary", "HEAD"]),
  ]);
  await Promise.all([
    writeEvidenceJson(path.join(gitRoot, "facts.json"), { head, tree }),
    fs.writeFile(path.join(gitRoot, "status.txt"), status ? `${status}\n` : "", "utf8"),
    fs.writeFile(path.join(gitRoot, "working-tree.patch"), diff, "utf8"),
    execFileAsync("git", ["bundle", "create", path.join(gitRoot, "repository.bundle"), "--all"], {
      cwd: evidenceWorkspace,
    }),
  ]);
  if (finalTestError) {
    throw finalTestError;
  }
  return finalTests as CapturedCommandEvidence;
}

async function resolveLiveEvidenceWorkspace(fixture: string): Promise<string> {
  const sessionsRoot = path.join(fixture, ".forge", "sessions");
  let sessionEntries;
  try {
    sessionEntries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return fixture;
    }
    throw error;
  }

  const rootSessionIds: string[] = [];
  for (const entry of sessionEntries) {
    if (entry.isSymbolicLink()) {
      throw new Error("Live session evidence cannot contain symlinked session directories");
    }
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const taskGraph = await fs.lstat(path.join(sessionsRoot, entry.name, "task-graph.json"));
      if (!taskGraph.isFile() || taskGraph.isSymbolicLink()) {
        throw new Error("Live root task graph must be a real file");
      }
      rootSessionIds.push(entry.name);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (rootSessionIds.length === 0) {
    return fixture;
  }
  if (rootSessionIds.length !== 1) {
    throw new Error("Live evidence must contain exactly one root session task graph");
  }

  const worktreesRoot = path.join(fixture, ".forge", "worktrees");
  const workspace = path.join(worktreesRoot, rootSessionIds[0] as string);
  const [worktreesStats, workspaceStats] = await Promise.all([
    fs.lstat(worktreesRoot),
    fs.lstat(workspace),
  ]);
  if (!worktreesStats.isDirectory() || worktreesStats.isSymbolicLink()
    || !workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new Error("Live root session worktree must be a real directory");
  }
  const [realWorktreesRoot, realWorkspace] = await Promise.all([
    fs.realpath(worktreesRoot),
    fs.realpath(workspace),
  ]);
  if (!realWorkspace.startsWith(`${realWorktreesRoot}${path.sep}`)) {
    throw new Error("Live root session worktree escapes the fixture worktree root");
  }
  return workspace;
}

async function copyFixtureInputs(fixture: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  for (const name of [".gitignore", "package.json", "src", "test"]) {
    await copyIfExists(path.join(fixture, name), path.join(destination, name));
  }
}

async function copyIfExists(source: string, destination: string): Promise<void> {
  try {
    await fs.cp(source, destination, { errorOnExist: true, force: false, recursive: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function isInfrastructureInvalid(
  result: LivePortfolioResult,
  build: CapturedCommandEvidence,
): boolean {
  return build.exitCode !== 0
    || build.signal !== null
    || result.status === "UNAVAILABLE"
    || ["cleanup_failed", "fixture_not_failing", "interrupted", "setup_failed", "timed_out"].includes(result.reason);
}

function assertEnvironmentMatchesIntent(
  expected: { endpointHash: string; model: string; providerId: string },
  environment: NodeJS.ProcessEnv,
): void {
  const endpoint = environment.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const endpointHash = crypto.createHash("sha256").update(endpoint).digest("hex");
  const model = environment.OPENAI_MODEL?.trim();
  const providerId = environment.EVIDENCE_PROVIDER_ID?.trim() || "my-gateway";
  if (endpointHash !== expected.endpointHash || model !== expected.model || providerId !== expected.providerId) {
    throw new Error("Live environment identity does not match the evidence intent");
  }
}

function createLiveRunId(now: Date, suffixValue: string): string {
  const suffix = suffixValue.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!suffix) {
    throw new Error("Live evidence random suffix must contain a letter or number");
  }
  return `live-${formatEvidenceTimestamp(now)}-${suffix}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }))
    .stdout.trim();
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

function defaultDependencies(): LiveEvidenceDependencies {
  return {
    buildSubject: (subjectRoot) => runCapturedCommand("npm", ["run", "--silent", "build"], subjectRoot),
    captureFinalTests: (fixture) => runCapturedCommand("npm", ["test"], fixture),
    captureInitialTests: (fixture) => runCapturedCommand("npm", ["test"], fixture),
    environment: process.env,
    async loadSubjectModule(modulePath) {
      return await import(pathToFileURL(modulePath).href) as SubjectLiveModule;
    },
    now: () => new Date(),
    randomSuffix: () => crypto.randomBytes(4).toString("hex"),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
