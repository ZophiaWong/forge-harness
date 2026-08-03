import type { ModelUsage } from "../domain/model.js";
import type { ExperimentIdentity } from "./fingerprint.js";

export const EVAL_SCHEMA_VERSION = 1;

export type MetricAvailability = "complete" | "partial" | "unavailable";

export interface EvalModelMetrics {
  callCount: number;
  duration: {
    knownCalls: number;
    status: MetricAvailability;
    totalMs: number;
  };
  tokens: {
    knownCalls: number;
    status: MetricAvailability;
    totals?: ModelUsage;
  };
}

export type EvalAssertionKind = "hard" | "outcome";
export type EvalAssertionStatus = "failed" | "passed" | "unavailable";

export interface EvalAssertionResult {
  evidenceRefs: string[];
  id: string;
  kind: EvalAssertionKind;
  status: EvalAssertionStatus;
}

export interface EvalAttemptResult {
  assertions: EvalAssertionResult[];
  attemptId: string;
  evidenceRefs: string[];
  execution: {
    reasonCode?: string;
    status: "completed" | "invalid";
  };
  metrics: EvalModelMetrics;
  ordinal: number;
  outcome: "failed" | "passed" | "unavailable";
  scenarioId: string;
}

export interface EvalScenarioAggregate {
  assertionPassCounts: Record<string, number>;
  attemptCount: number;
  passCount: number;
  scenarioId: string;
}

export interface EvalDiagnostics {
  commit?: string;
  dependenciesFingerprint?: string;
  nodeVersion?: string;
  platform?: string;
  runtimePromptFingerprint?: string;
  toolDefinitionsFingerprint?: string;
}

export interface EvalSuiteSummary {
  aggregates: EvalScenarioAggregate[];
  artifactType: "forge-eval-suite-summary";
  attempts: EvalAttemptResult[];
  canonical: boolean;
  diagnostics: EvalDiagnostics;
  generatedAt: string;
  identity: ExperimentIdentity;
  issues: string[];
  metrics: EvalModelMetrics;
  runId: string;
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  scope: "scenario" | "suite";
  valid: boolean;
}

export interface EvalBaseline {
  aggregates: EvalScenarioAggregate[];
  artifactType: "forge-eval-baseline";
  identity: ExperimentIdentity;
  metrics: EvalModelMetrics;
  promotedAt: string;
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  sourceRunId: string;
}

export type EvalVerdict =
  | "IMPROVED"
  | "INCOMPARABLE"
  | "INVALID"
  | "NO_BASELINE"
  | "REGRESSED"
  | "UNCHANGED";

export interface EvalCountDiff {
  assertionId?: string;
  baseline: number;
  candidate: number;
  delta: number;
  kind: "assertion" | "scenario";
  scenarioId: string;
}

export interface RegressionReport {
  artifactType: "forge-eval-regression-report";
  baselineSourceRunId?: string;
  candidateRunId: string;
  compatibility: {
    differences: string[];
    status: "comparable" | "incomparable" | "no_baseline";
  };
  diffs: EvalCountDiff[];
  exitCode: 0 | 1 | 2;
  findings: Array<{
    assertionId?: string;
    attemptId: string;
    kind: "hard_violation" | "invalid";
    reasonCode?: string;
    scenarioId: string;
  }>;
  generatedAt: string;
  metrics: {
    baseline?: EvalModelMetrics;
    candidate: EvalModelMetrics;
  };
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  verdict: EvalVerdict;
}
