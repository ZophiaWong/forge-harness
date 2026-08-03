import type { ExperimentIdentity } from "./fingerprint.js";
import {
  EVAL_SCHEMA_VERSION,
  type EvalBaseline,
  type EvalCountDiff,
  type EvalSuiteSummary,
  type EvalVerdict,
  type RegressionReport,
} from "./types.js";

export function compareEvalSummary(
  candidate: EvalSuiteSummary,
  baseline?: EvalBaseline,
): RegressionReport {
  const compatibility = compareIdentity(candidate.identity, baseline?.identity);
  const diffs = baseline && compatibility.status === "comparable"
    ? buildCountDiffs(candidate, baseline)
    : [];
  const verdict = chooseVerdict(candidate, baseline, compatibility.status, diffs);

  return {
    artifactType: "forge-eval-regression-report",
    ...(baseline ? { baselineSourceRunId: baseline.sourceRunId } : {}),
    candidateRunId: candidate.runId,
    compatibility,
    diffs,
    exitCode: verdictExitCode(verdict),
    findings: candidate.attempts.flatMap((attempt) => [
      ...attempt.assertions
        .filter((assertion) => assertion.kind === "hard" && assertion.status === "failed")
        .map((assertion) => ({
          assertionId: assertion.id,
          attemptId: attempt.attemptId,
          kind: "hard_violation" as const,
          scenarioId: attempt.scenarioId,
        })),
      ...(attempt.execution.status === "invalid"
        ? [{
            attemptId: attempt.attemptId,
            kind: "invalid" as const,
            ...(attempt.execution.reasonCode ? { reasonCode: attempt.execution.reasonCode } : {}),
            scenarioId: attempt.scenarioId,
          }]
        : []),
    ]),
    generatedAt: candidate.generatedAt,
    metrics: {
      ...(baseline ? { baseline: baseline.metrics } : {}),
      candidate: candidate.metrics,
    },
    schemaVersion: EVAL_SCHEMA_VERSION,
    verdict,
  };
}

function chooseVerdict(
  candidate: EvalSuiteSummary,
  baseline: EvalBaseline | undefined,
  compatibility: RegressionReport["compatibility"]["status"],
  diffs: EvalCountDiff[],
): EvalVerdict {
  if (candidate.attempts.some((attempt) => attempt.assertions.some((assertion) => (
    assertion.kind === "hard" && assertion.status === "failed"
  )))) {
    return "REGRESSED";
  }
  if (!candidate.valid || candidate.attempts.some((attempt) => attempt.execution.status === "invalid")) {
    return "INVALID";
  }
  if (!baseline) {
    return "NO_BASELINE";
  }
  if (compatibility === "incomparable") {
    return "INCOMPARABLE";
  }
  if (diffs.some((diff) => diff.delta < 0)) {
    return "REGRESSED";
  }
  if (diffs.some((diff) => diff.delta > 0)) {
    return "IMPROVED";
  }
  return "UNCHANGED";
}

function compareIdentity(
  candidate: ExperimentIdentity,
  baseline: ExperimentIdentity | undefined,
): RegressionReport["compatibility"] {
  if (!baseline) {
    return { differences: [], status: "no_baseline" };
  }
  const comparableFields: Array<keyof ExperimentIdentity> = [
    "endpointHash",
    "model",
    "providerId",
    "requestFingerprint",
    "suiteFingerprint",
    "fingerprint",
  ];
  const differences = comparableFields.filter((field) => candidate[field] !== baseline[field]);
  return {
    differences,
    status: differences.length === 0 ? "comparable" : "incomparable",
  };
}

function buildCountDiffs(candidate: EvalSuiteSummary, baseline: EvalBaseline): EvalCountDiff[] {
  const candidateByScenario = new Map(candidate.aggregates.map((aggregate) => [aggregate.scenarioId, aggregate]));
  const baselineByScenario = new Map(baseline.aggregates.map((aggregate) => [aggregate.scenarioId, aggregate]));
  const scenarioIds = [...new Set([
    ...candidateByScenario.keys(),
    ...baselineByScenario.keys(),
  ])].sort((left, right) => left.localeCompare(right));
  const diffs: EvalCountDiff[] = [];

  for (const scenarioId of scenarioIds) {
    const candidateAggregate = candidateByScenario.get(scenarioId);
    const baselineAggregate = baselineByScenario.get(scenarioId);
    diffs.push(createDiff(
      "scenario",
      scenarioId,
      baselineAggregate?.passCount ?? 0,
      candidateAggregate?.passCount ?? 0,
    ));

    const assertionIds = [...new Set([
      ...Object.keys(candidateAggregate?.assertionPassCounts ?? {}),
      ...Object.keys(baselineAggregate?.assertionPassCounts ?? {}),
    ])].sort((left, right) => left.localeCompare(right));
    for (const assertionId of assertionIds) {
      diffs.push({
        ...createDiff(
          "assertion",
          scenarioId,
          baselineAggregate?.assertionPassCounts[assertionId] ?? 0,
          candidateAggregate?.assertionPassCounts[assertionId] ?? 0,
        ),
        assertionId,
      });
    }
  }

  return diffs;
}

function createDiff(
  kind: EvalCountDiff["kind"],
  scenarioId: string,
  baseline: number,
  candidate: number,
): EvalCountDiff {
  return {
    baseline,
    candidate,
    delta: candidate - baseline,
    kind,
    scenarioId,
  };
}

function verdictExitCode(verdict: EvalVerdict): 0 | 1 | 2 {
  if (verdict === "REGRESSED") {
    return 1;
  }
  if (verdict === "IMPROVED" || verdict === "UNCHANGED") {
    return 0;
  }
  return 2;
}
