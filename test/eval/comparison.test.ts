import { describe, expect, it } from "vitest";

import { aggregateAttempts } from "../../src/eval/aggregate.js";
import { compareEvalSummary } from "../../src/eval/compare.js";
import type {
  EvalAssertionResult,
  EvalAttemptResult,
  EvalBaseline,
  EvalModelMetrics,
  EvalSuiteSummary,
} from "../../src/eval/types.js";

const zeroMetrics: EvalModelMetrics = {
  callCount: 0,
  duration: { knownCalls: 0, status: "unavailable", totalMs: 0 },
  tokens: { knownCalls: 0, status: "unavailable" },
};

function assertion(
  id: string,
  status: EvalAssertionResult["status"],
  kind: EvalAssertionResult["kind"] = "outcome",
): EvalAssertionResult {
  return { evidenceRefs: [], id, kind, status };
}

function attempt(
  ordinal: number,
  outcome: EvalAttemptResult["outcome"],
  assertions: EvalAssertionResult[],
  execution: EvalAttemptResult["execution"] = { status: "completed" },
): EvalAttemptResult {
  return {
    assertions,
    attemptId: `governed-read-only-${ordinal}`,
    evidenceRefs: [],
    execution,
    metrics: zeroMetrics,
    ordinal,
    outcome,
    scenarioId: "governed-read-only",
  };
}

function summary(
  attempts: EvalAttemptResult[],
  overrides: Partial<EvalSuiteSummary> = {},
): EvalSuiteSummary {
  return {
    aggregates: aggregateAttempts(attempts),
    artifactType: "forge-eval-suite-summary",
    attempts,
    canonical: true,
    diagnostics: {},
    generatedAt: "2026-08-03T00:00:00.000Z",
    identity: {
      endpointHash: "endpoint",
      fingerprint: "experiment",
      model: "gpt-test",
      providerId: "openai",
      requestFingerprint: "request",
      suiteFingerprint: "suite",
    },
    issues: [],
    metrics: zeroMetrics,
    runId: "candidate",
    schemaVersion: 1,
    scope: "suite",
    valid: true,
    ...overrides,
  };
}

function baselineFrom(source: EvalSuiteSummary): EvalBaseline {
  return {
    aggregates: source.aggregates,
    artifactType: "forge-eval-baseline",
    identity: source.identity,
    metrics: source.metrics,
    promotedAt: "2026-08-03T00:05:00.000Z",
    schemaVersion: 1,
    sourceRunId: source.runId,
  };
}

describe("eval comparison", () => {
  it("lets a hard invariant violation outrank invalid execution and missing baseline", () => {
    const candidate = summary([
      attempt(1, "unavailable", [assertion("permission-evidence", "failed", "hard")], {
        reasonCode: "provider_error",
        status: "invalid",
      }),
    ], { valid: false });

    expect(compareEvalSummary(candidate)).toMatchObject({
      exitCode: 1,
      verdict: "REGRESSED",
    });
  });

  it("marks infrastructure failures invalid before checking compatibility", () => {
    const candidate = summary([
      attempt(1, "unavailable", [], { reasonCode: "provider_error", status: "invalid" }),
    ], {
      identity: {
        endpointHash: "changed",
        fingerprint: "changed",
        model: "gpt-test",
        providerId: "openai",
        requestFingerprint: "request",
        suiteFingerprint: "suite",
      },
      valid: false,
    });
    const baseline = baselineFrom(summary([attempt(1, "passed", [assertion("final-exact", "passed")])]));

    expect(compareEvalSummary(candidate, baseline)).toMatchObject({
      exitCode: 2,
      verdict: "INVALID",
    });
  });

  it("distinguishes no baseline from an incompatible baseline", () => {
    const candidate = summary([attempt(1, "passed", [assertion("final-exact", "passed")])]);
    expect(compareEvalSummary(candidate)).toMatchObject({ exitCode: 2, verdict: "NO_BASELINE" });

    const baseline = baselineFrom(summary(candidate.attempts, {
      identity: {
        ...candidate.identity,
        fingerprint: "old-experiment",
        suiteFingerprint: "old-suite",
      },
    }));
    expect(compareEvalSummary(candidate, baseline)).toMatchObject({
      compatibility: {
        differences: ["suiteFingerprint", "fingerprint"],
        status: "incomparable",
      },
      diffs: [],
      exitCode: 2,
      verdict: "INCOMPARABLE",
    });
  });

  it("treats a mismatched derived experiment fingerprint as incomparable", () => {
    const candidate = summary([attempt(1, "passed", [assertion("final-exact", "passed")])]);
    const baseline = baselineFrom(summary(candidate.attempts, {
      identity: { ...candidate.identity, fingerprint: "tampered" },
    }));

    expect(compareEvalSummary(candidate, baseline)).toMatchObject({
      compatibility: { differences: ["fingerprint"], status: "incomparable" },
      diffs: [],
      verdict: "INCOMPARABLE",
    });
  });

  it("does not let one improved assertion compensate for another regression", () => {
    const baselineSummary = summary([
      attempt(1, "passed", [assertion("background-child", "passed"), assertion("final-exact", "passed")]),
      attempt(2, "passed", [assertion("background-child", "passed"), assertion("final-exact", "passed")]),
      attempt(3, "failed", [assertion("background-child", "passed"), assertion("final-exact", "failed")]),
    ]);
    const candidate = summary([
      attempt(1, "passed", [assertion("background-child", "passed"), assertion("final-exact", "passed")]),
      attempt(2, "passed", [assertion("background-child", "passed"), assertion("final-exact", "passed")]),
      attempt(3, "failed", [assertion("background-child", "failed"), assertion("final-exact", "passed")]),
    ]);

    expect(compareEvalSummary(candidate, baselineFrom(baselineSummary))).toMatchObject({
      diffs: expect.arrayContaining([
        expect.objectContaining({ assertionId: "background-child", delta: -1 }),
        expect.objectContaining({ assertionId: "final-exact", delta: 1 }),
      ]),
      exitCode: 1,
      verdict: "REGRESSED",
    });
  });

  it("catches a lower scenario pass count even when assertion counts are unchanged", () => {
    const baselineSummary = summary([
      attempt(1, "passed", [assertion("a", "passed"), assertion("b", "passed")]),
      attempt(2, "failed", [assertion("a", "passed"), assertion("b", "failed")]),
      attempt(3, "failed", [assertion("a", "failed"), assertion("b", "passed")]),
    ]);
    const candidate = summary([
      attempt(1, "failed", [assertion("a", "passed"), assertion("b", "failed")]),
      attempt(2, "failed", [assertion("a", "passed"), assertion("b", "failed")]),
      attempt(3, "failed", [assertion("a", "failed"), assertion("b", "passed")]),
    ]);

    expect(compareEvalSummary(candidate, baselineFrom(baselineSummary))).toMatchObject({
      diffs: expect.arrayContaining([
        expect.objectContaining({ delta: -1, kind: "scenario" }),
      ]),
      verdict: "REGRESSED",
    });
  });

  it("reports improved only when no comparable count decreases", () => {
    const baselineSummary = summary([
      attempt(1, "passed", [assertion("final-exact", "passed")]),
      attempt(2, "failed", [assertion("final-exact", "failed")]),
    ]);
    const candidate = summary([
      attempt(1, "passed", [assertion("final-exact", "passed")]),
      attempt(2, "passed", [assertion("final-exact", "passed")]),
    ], {
      metrics: {
        callCount: 99,
        duration: { knownCalls: 99, status: "complete", totalMs: 99_000 },
        tokens: {
          knownCalls: 99,
          status: "complete",
          totals: { inputTokens: 90_000, outputTokens: 9_000, totalTokens: 99_000 },
        },
      },
    });

    expect(compareEvalSummary(candidate, baselineFrom(baselineSummary))).toMatchObject({
      exitCode: 0,
      verdict: "IMPROVED",
    });
  });

  it("reports unchanged when all behavior counts match", () => {
    const source = summary([
      attempt(1, "passed", [assertion("final-exact", "passed")]),
      attempt(2, "failed", [assertion("final-exact", "failed")]),
    ]);

    expect(compareEvalSummary(source, baselineFrom(source))).toMatchObject({
      exitCode: 0,
      verdict: "UNCHANGED",
    });
  });
});
