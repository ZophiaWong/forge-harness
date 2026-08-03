import fs from "node:fs/promises";
import path from "node:path";

import { aggregateAttempts } from "./aggregate.js";
import {
  CANONICAL_ATTEMPT_COUNT,
  CANONICAL_SCENARIO_REPETITIONS,
} from "./canonicalSuite.js";
import { canonicalJson } from "./fingerprint.js";
import { parseEvalSuiteSummary } from "./schema.js";
import {
  EVAL_SCHEMA_VERSION,
  type EvalBaseline,
  type EvalCountDiff,
  type EvalSuiteSummary,
} from "./types.js";
import type { ExperimentIdentity } from "./fingerprint.js";
import { parseEvalBaseline } from "./schema.js";

export interface PromoteEvalBaselineOptions {
  from: string;
  now?: () => Date;
  onReplacementDiff?: (diffs: EvalCountDiff[], baselinePath: string) => Promise<void> | void;
  replace: boolean;
  repositoryRoot: string;
}

export interface PromoteEvalBaselineResult {
  baseline: EvalBaseline;
  baselinePath: string;
  replacementDiffs?: EvalCountDiff[];
  replaced: boolean;
}

export function createEvalBaseline(
  summary: EvalSuiteSummary,
  now: () => Date = () => new Date(),
): EvalBaseline {
  validateCanonicalSummary(summary);
  const aggregates = aggregateAttempts(summary.attempts);
  if (canonicalJson(summary.aggregates) !== canonicalJson(aggregates)) {
    throw new Error("summary aggregates do not match canonical attempt results");
  }

  return {
    aggregates,
    artifactType: "forge-eval-baseline",
    identity: summary.identity,
    metrics: summary.metrics,
    promotedAt: now().toISOString(),
    schemaVersion: EVAL_SCHEMA_VERSION,
    sourceRunId: summary.runId,
  };
}

export async function promoteEvalBaseline(
  options: PromoteEvalBaselineOptions,
): Promise<PromoteEvalBaselineResult> {
  const raw = JSON.parse(await fs.readFile(options.from, "utf8")) as unknown;
  const summary = parseEvalSuiteSummary(raw);
  const baseline = createEvalBaseline(summary, options.now);
  const baselinePath = evalBaselinePath(options.repositoryRoot, baseline.identity);
  const replaced = await fileExists(baselinePath);
  if (replaced && !options.replace) {
    throw new Error(`baseline already exists at ${baselinePath}; pass --replace to overwrite it`);
  }
  const replacementDiffs = replaced
    ? diffEvalBaselines(
        parseEvalBaseline(JSON.parse(await fs.readFile(baselinePath, "utf8")) as unknown),
        baseline,
      )
    : undefined;
  if (replacementDiffs) {
    await options.onReplacementDiff?.(replacementDiffs, baselinePath);
  }

  await fs.mkdir(path.dirname(baselinePath), { recursive: true });
  const temporaryPath = `${baselinePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, baselinePath);

  return {
    baseline,
    baselinePath,
    ...(replacementDiffs ? { replacementDiffs } : {}),
    replaced,
  };
}

export function diffEvalBaselines(previous: EvalBaseline, next: EvalBaseline): EvalCountDiff[] {
  const previousByScenario = new Map(previous.aggregates.map((aggregate) => [aggregate.scenarioId, aggregate]));
  const nextByScenario = new Map(next.aggregates.map((aggregate) => [aggregate.scenarioId, aggregate]));
  const scenarioIds = [...new Set([
    ...previousByScenario.keys(),
    ...nextByScenario.keys(),
  ])].sort((left, right) => left.localeCompare(right));
  return scenarioIds.flatMap((scenarioId): EvalCountDiff[] => {
    const oldAggregate = previousByScenario.get(scenarioId);
    const newAggregate = nextByScenario.get(scenarioId);
    const scenarioDiff: EvalCountDiff = {
      baseline: oldAggregate?.passCount ?? 0,
      candidate: newAggregate?.passCount ?? 0,
      delta: (newAggregate?.passCount ?? 0) - (oldAggregate?.passCount ?? 0),
      kind: "scenario",
      scenarioId,
    };
    const assertionIds = [...new Set([
      ...Object.keys(oldAggregate?.assertionPassCounts ?? {}),
      ...Object.keys(newAggregate?.assertionPassCounts ?? {}),
    ])].sort((left, right) => left.localeCompare(right));
    return [scenarioDiff, ...assertionIds.map((assertionId): EvalCountDiff => {
      const oldCount = oldAggregate?.assertionPassCounts[assertionId] ?? 0;
      const newCount = newAggregate?.assertionPassCounts[assertionId] ?? 0;
      return {
        assertionId,
        baseline: oldCount,
        candidate: newCount,
        delta: newCount - oldCount,
        kind: "assertion",
        scenarioId,
      };
    })];
  });
}

function validateCanonicalSummary(summary: EvalSuiteSummary): void {
  if (!summary.canonical || summary.scope !== "suite") {
    throw new Error("baseline promotion requires a full canonical suite");
  }
  if (!summary.valid || summary.attempts.some((attempt) => attempt.execution.status === "invalid")) {
    throw new Error("baseline promotion requires a valid canonical suite");
  }
  if (summary.attempts.length !== CANONICAL_ATTEMPT_COUNT) {
    throw new Error(`baseline promotion requires exactly ${CANONICAL_ATTEMPT_COUNT} canonical attempts`);
  }
  if (summary.attempts.some((attempt) => attempt.assertions.some((assertion) => (
    assertion.kind === "hard" && assertion.status === "failed"
  )))) {
    throw new Error("baseline promotion rejects hard invariant violations");
  }
  if (summary.attempts.some((attempt) => (
    attempt.outcome === "unavailable"
    || attempt.assertions.some((assertion) => assertion.status === "unavailable")
  ))) {
    throw new Error("baseline promotion rejects unavailable behavior or assertions");
  }
  if (summary.attempts.some((attempt) => (
    attempt.attemptId !== `${attempt.scenarioId}-${attempt.ordinal}`
  ))) {
    throw new Error("baseline promotion requires canonical attempt identifiers");
  }

  for (const [scenarioId, repetitions] of Object.entries(CANONICAL_SCENARIO_REPETITIONS)) {
    const ordinals = summary.attempts
      .filter((attempt) => attempt.scenarioId === scenarioId)
      .map((attempt) => attempt.ordinal)
      .sort((left, right) => left - right);
    const expected = Array.from({ length: repetitions }, (_, index) => index + 1);
    if (canonicalJson(ordinals) !== canonicalJson(expected)) {
      throw new Error(`scenario ${scenarioId} must contain canonical ordinals ${expected.join(", ")}`);
    }
  }

  const knownScenarioIds = new Set(Object.keys(CANONICAL_SCENARIO_REPETITIONS));
  if (summary.attempts.some((attempt) => !knownScenarioIds.has(attempt.scenarioId))) {
    throw new Error("canonical suite contains an unknown scenario");
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function evalBaselinePath(repositoryRoot: string, identity: ExperimentIdentity): string {
  return path.join(
    path.resolve(repositoryRoot),
    "eval",
    "baselines",
    safeEvalSlug(identity.providerId),
    safeEvalSlug(identity.model),
    `${safeEvalSlug(identity.fingerprint)}.json`,
  );
}

export function safeEvalSlug(value: string): string {
  const slug = value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!slug || slug === "." || slug === "..") {
    throw new Error(`cannot derive a safe path segment from ${JSON.stringify(value)}`);
  }
  return slug;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
