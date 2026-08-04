import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  DEFAULT_MODEL_REQUEST_MAX_RETRIES,
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  type ResponseCreate,
} from "../core/minimalLoop.js";
import { aggregateAttempts } from "./aggregate.js";
import {
  loadComparisonBaseline,
  scopeBaselineToScenario,
} from "./baselineStore.js";
import {
  CANONICAL_SCENARIO_ORDER,
} from "./canonicalSuite.js";
import { compareEvalSummary } from "./compare.js";
import { EVAL_RUN_MARKER, type EvalRunMarker } from "./cleanup.js";
import { loadEvalContractSources } from "./contract.js";
import {
  buildExperimentIdentity,
  fingerprint,
} from "./fingerprint.js";
import { writeEvalArtifacts, type EvalArtifactPaths } from "./report.js";
import {
  runEvalAttempt,
  type RunEvalAttemptOptions,
  type RunEvalAttemptResult,
} from "./runner.js";
import {
  getEvalScenario,
  listEvalScenarios,
} from "./scenarios.js";
import {
  EVAL_SCHEMA_VERSION,
  type EvalModelMetrics,
  type EvalSuiteSummary,
  type RegressionReport,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1";

export type EvalAttemptRunner = (options: RunEvalAttemptOptions) => Promise<RunEvalAttemptResult>;

export interface RunEvalSuiteOptions {
  apiKey?: string;
  attemptRunner?: EvalAttemptRunner;
  baseURL?: string;
  contractSourceLoader?: (runtimeRepositoryRoot: string) => Promise<Record<string, string>>;
  model: string;
  now?: () => Date;
  providerId?: string;
  randomSuffix?: () => string;
  repositoryRoot: string;
  responseCreateForAttempt?: (scenarioId: string, ordinal: number) => ResponseCreate;
  scenarioId?: string;
}

export interface RunEvalSuiteResult {
  artifactPaths: EvalArtifactPaths;
  report: RegressionReport;
  runRoot: string;
  summary: EvalSuiteSummary;
}

export async function runEvalSuite(options: RunEvalSuiteOptions): Promise<RunEvalSuiteResult> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const providerId = resolveProviderId(options.baseURL, options.providerId);
  if (!options.model.trim()) {
    throw new Error("eval model must be non-empty");
  }
  const selectedScenarios = options.scenarioId
    ? [getEvalScenario(options.scenarioId)]
    : CANONICAL_SCENARIO_ORDER.map((id) => getEvalScenario(id));
  const contractSources = await (options.contractSourceLoader ?? loadEvalContractSources)(repositoryRoot);
  const identity = buildExperimentIdentity({
    contractSources,
    endpoint: options.baseURL ?? DEFAULT_OPENAI_ENDPOINT,
    model: options.model,
    providerId,
    requestSettings: {
      include: ["reasoning.encrypted_content"],
      maxRetries: DEFAULT_MODEL_REQUEST_MAX_RETRIES,
      parallelToolCalls: false,
      reasoning: { effort: "low" },
      store: false,
      text: { verbosity: "low" },
      timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    },
    scenarios: listEvalScenarios().map((scenario) => ({
      id: scenario.id,
      manifest: scenario.manifest,
    })),
  });
  const now = options.now ?? (() => new Date());
  const runId = createRunId(now(), options.randomSuffix?.() ?? randomBytes(4).toString("hex"));
  const runRoot = path.join(repositoryRoot, ".forge", "evals", runId);
  await fs.mkdir(path.dirname(runRoot), { recursive: true });
  await fs.mkdir(runRoot);
  const marker: EvalRunMarker = {
    artifactType: "forge-eval-run",
    runId,
    status: "running",
    worktrees: [],
  };
  await writeMarker(runRoot, marker);

  const attemptRunner = options.attemptRunner ?? runEvalAttempt;
  const results: RunEvalAttemptResult[] = [];
  let stoppedForHardViolation = false;
  for (const scenario of selectedScenarios) {
    for (let ordinal = 1; ordinal <= scenario.manifest.repetitions; ordinal += 1) {
      const attemptRoot = path.join(runRoot, "attempts", scenario.id, String(ordinal));
      await fs.mkdir(path.dirname(attemptRoot), { recursive: true });
      const responseCreate = options.responseCreateForAttempt?.(scenario.id, ordinal);
      let result: RunEvalAttemptResult;
      try {
        result = await attemptRunner({
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          attemptRoot,
          ...(options.baseURL ? { baseURL: options.baseURL } : {}),
          evidenceRefPrefix: `attempts/${scenario.id}/${ordinal}`,
          model: options.model,
          ordinal,
          repositoryRoot,
          ...(responseCreate ? { responseCreate } : {}),
          scenario,
        });
      } catch {
        await fs.mkdir(attemptRoot, { recursive: true });
        const evidenceRef = `attempts/${scenario.id}/${ordinal}/grade.json`;
        await fs.writeFile(
          path.join(attemptRoot, "grade.json"),
          `${JSON.stringify({ execution: { reasonCode: "fixture_error", status: "invalid" } }, null, 2)}\n`,
          "utf8",
        );
        result = {
          attempt: {
            assertions: [],
            attemptId: `${scenario.id}-${ordinal}`,
            evidenceRefs: [evidenceRef],
            execution: { reasonCode: "fixture_error", status: "invalid" },
            metrics: emptyMetrics(),
            ordinal,
            outcome: "unavailable",
            scenarioId: scenario.id,
          },
          sessions: [],
          workspace: attemptRoot,
        };
      }
      results.push(result);
      marker.worktrees = mergeWorktrees(
        marker.worktrees,
        await discoverNestedWorktrees(runRoot, result.workspace),
      );
      await writeMarker(runRoot, marker);

      if (result.attempt.execution.status === "invalid") {
        break;
      }
      if (result.attempt.assertions.some((assertion) => (
        assertion.kind === "hard" && assertion.status === "failed"
      ))) {
        stoppedForHardViolation = true;
        break;
      }
    }
    const latest = results.at(-1)?.attempt;
    if (stoppedForHardViolation || latest?.execution.status === "invalid") {
      break;
    }
  }

  const attempts = results.map((result) => result.attempt);
  const expectedAttemptCount = selectedScenarios.reduce(
    (total, scenario) => total + scenario.manifest.repetitions,
    0,
  );
  const hasInvalid = attempts.some((attempt) => attempt.execution.status === "invalid");
  const complete = attempts.length === expectedAttemptCount;
  const issues = unique([
    ...attempts.flatMap((attempt) => attempt.execution.reasonCode ? [attempt.execution.reasonCode] : []),
    ...(!complete ? [stoppedForHardViolation ? "hard_violation" : "partial_suite"] : []),
    ...(!complete && hasInvalid ? ["partial_suite"] : []),
  ]);
  const generatedAt = now().toISOString();
  const summary: EvalSuiteSummary = {
    aggregates: aggregateAttempts(attempts),
    artifactType: "forge-eval-suite-summary",
    attempts,
    canonical: options.scenarioId === undefined,
    diagnostics: await buildDiagnostics(repositoryRoot),
    generatedAt,
    identity,
    issues,
    metrics: combineEvalModelMetrics(attempts.map((attempt) => attempt.metrics)),
    runId,
    schemaVersion: EVAL_SCHEMA_VERSION,
    scope: options.scenarioId ? "scenario" : "suite",
    valid: complete && !hasInvalid,
  };
  let discoveredBaseline;
  let baselineCorrupt = false;
  try {
    discoveredBaseline = await loadComparisonBaseline(repositoryRoot, identity);
  } catch {
    baselineCorrupt = true;
    summary.valid = false;
    summary.issues = unique([...summary.issues, "baseline_corrupt"]);
  }
  const baseline = discoveredBaseline && options.scenarioId
    ? scopeBaselineToScenario(discoveredBaseline, options.scenarioId)
    : discoveredBaseline;
  const report = compareEvalSummary(summary, baseline);
  const artifactPaths = await writeEvalArtifacts({ report, runRoot, summary });
  marker.status = hasInvalid || baselineCorrupt ? "invalid" : "completed";
  await writeMarker(runRoot, marker);
  return { artifactPaths, report, runRoot, summary };
}

export function combineEvalModelMetrics(metrics: EvalModelMetrics[]): EvalModelMetrics {
  const callCount = metrics.reduce((total, item) => total + item.callCount, 0);
  const durationKnownCalls = metrics.reduce((total, item) => total + item.duration.knownCalls, 0);
  const tokenKnownCalls = metrics.reduce((total, item) => total + item.tokens.knownCalls, 0);
  const totals = metrics.flatMap((item) => item.tokens.totals ? [item.tokens.totals] : []);
  const sawCached = totals.some((item) => item.cachedInputTokens !== undefined);
  const sawReasoning = totals.some((item) => item.reasoningTokens !== undefined);
  return {
    callCount,
    duration: {
      knownCalls: durationKnownCalls,
      status: coverage(durationKnownCalls, callCount),
      totalMs: metrics.reduce((total, item) => total + item.duration.totalMs, 0),
    },
    tokens: {
      knownCalls: tokenKnownCalls,
      status: coverage(tokenKnownCalls, callCount),
      ...(totals.length > 0
        ? {
            totals: {
              ...(sawCached
                ? { cachedInputTokens: totals.reduce((sum, item) => sum + (item.cachedInputTokens ?? 0), 0) }
                : {}),
              inputTokens: totals.reduce((sum, item) => sum + item.inputTokens, 0),
              outputTokens: totals.reduce((sum, item) => sum + item.outputTokens, 0),
              ...(sawReasoning
                ? { reasoningTokens: totals.reduce((sum, item) => sum + (item.reasoningTokens ?? 0), 0) }
                : {}),
              totalTokens: totals.reduce((sum, item) => sum + item.totalTokens, 0),
            },
          }
        : {}),
    },
  };
}

function coverage(known: number, total: number): EvalModelMetrics["tokens"]["status"] {
  if (known === 0) {
    return "unavailable";
  }
  return known === total ? "complete" : "partial";
}

function resolveProviderId(baseURL: string | undefined, providerId: string | undefined): string {
  if (baseURL !== undefined && !providerId?.trim()) {
    throw new Error("--provider-id is required when OPENAI_BASE_URL is customized");
  }
  const resolved = providerId?.trim() || "openai";
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(resolved)) {
    throw new Error("provider id must use lowercase letters, numbers, dots, underscores, or hyphens");
  }
  return resolved;
}

function createRunId(now: Date, randomSuffix: string): string {
  const suffix = randomSuffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!suffix) {
    throw new Error("eval run random suffix must contain a letter or number");
  }
  return [
    String(now.getUTCFullYear()).padStart(4, "0"),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "-",
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
    "-",
    suffix,
  ].join("");
}

async function buildDiagnostics(repositoryRoot: string): Promise<EvalSuiteSummary["diagnostics"]> {
  const [commit, dependencies, runtimePrompt, toolDefinitions] = await Promise.all([
    readGitCommit(repositoryRoot),
    hashFileIfExists(path.join(repositoryRoot, "package-lock.json")),
    hashFileIfExists(path.join(repositoryRoot, "src", "context", "promptAssembly.ts")),
    hashFilesIfPresent(repositoryRoot, [
      "src/tools/defaultRuntime.ts",
      "src/tools/teamTaskTools.ts",
      "src/tools/teammateTools.ts",
    ]),
  ]);
  return {
    ...(commit ? { commit } : {}),
    ...(dependencies ? { dependenciesFingerprint: dependencies } : {}),
    nodeVersion: process.version,
    platform: process.platform,
    ...(runtimePrompt ? { runtimePromptFingerprint: runtimePrompt } : {}),
    ...(toolDefinitions ? { toolDefinitionsFingerprint: toolDefinitions } : {}),
  };
}

async function readGitCommit(cwd: string): Promise<string | undefined> {
  try {
    return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" })).stdout.trim();
  } catch {
    return undefined;
  }
}

async function hashFileIfExists(pathname: string): Promise<string | undefined> {
  try {
    return fingerprint(await fs.readFile(pathname, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function hashFilesIfPresent(root: string, relativePaths: string[]): Promise<string | undefined> {
  const sources = await Promise.all(relativePaths.map((relativePath) => (
    fs.readFile(path.join(root, relativePath), "utf8").catch(() => undefined)
  )));
  const present = sources.flatMap((source, index) => source === undefined
    ? []
    : [{ path: relativePaths[index], source }]);
  return present.length === 0 ? undefined : fingerprint(present);
}

async function writeMarker(runRoot: string, marker: EvalRunMarker): Promise<void> {
  await fs.writeFile(
    path.join(runRoot, EVAL_RUN_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
}

async function discoverNestedWorktrees(
  runRoot: string,
  gitRoot: string,
): Promise<EvalRunMarker["worktrees"]> {
  try {
    const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: gitRoot,
      encoding: "utf8",
    })).stdout;
    return output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice("worktree ".length)))
      .filter((worktreePath) => worktreePath !== path.resolve(gitRoot))
      .flatMap((worktreePath) => {
        const gitRelative = safeRelative(runRoot, gitRoot);
        const worktreeRelative = safeRelative(runRoot, worktreePath);
        return gitRelative && worktreeRelative
          ? [{ gitRoot: gitRelative, path: worktreeRelative }]
          : [];
      });
  } catch {
    return [];
  }
}

function safeRelative(root: string, candidate: string): string | undefined {
  const relative = path.relative(root, path.resolve(candidate));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : undefined;
}

function mergeWorktrees(
  current: EvalRunMarker["worktrees"],
  discovered: EvalRunMarker["worktrees"],
): EvalRunMarker["worktrees"] {
  const byPath = new Map(current.map((item) => [item.path, item]));
  for (const item of discovered) {
    byPath.set(item.path, item);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function emptyMetrics(): EvalModelMetrics {
  return {
    callCount: 0,
    duration: { knownCalls: 0, status: "unavailable", totalMs: 0 },
    tokens: { knownCalls: 0, status: "unavailable" },
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
