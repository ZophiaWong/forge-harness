import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { aggregateAttempts } from "../../src/eval/aggregate.js";
import {
  createEvalBaseline,
  promoteEvalBaseline,
} from "../../src/eval/baseline.js";
import {
  CANONICAL_ATTEMPT_COUNT,
  CANONICAL_SCENARIO_REPETITIONS,
} from "../../src/eval/canonicalSuite.js";
import type {
  EvalAttemptResult,
  EvalModelMetrics,
  EvalSuiteSummary,
} from "../../src/eval/types.js";

const tempRoots: string[] = [];
const zeroMetrics: EvalModelMetrics = {
  callCount: 0,
  duration: { knownCalls: 0, status: "unavailable", totalMs: 0 },
  tokens: { knownCalls: 0, status: "unavailable" },
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

function canonicalAttempts(): EvalAttemptResult[] {
  return Object.entries(CANONICAL_SCENARIO_REPETITIONS).flatMap(([scenarioId, repetitions]) => (
    Array.from({ length: repetitions }, (_, index): EvalAttemptResult => {
      const ordinal = index + 1;
      const passed = ordinal !== 1;
      return {
        assertions: [{
          evidenceRefs: [`attempts/${scenarioId}/${ordinal}/grade.json`],
          id: "behavior-contract",
          kind: "outcome",
          status: passed ? "passed" : "failed",
        }, {
          evidenceRefs: [`attempts/${scenarioId}/${ordinal}/trace.jsonl`],
          id: "action-boundary",
          kind: "hard",
          status: "passed",
        }],
        attemptId: `${scenarioId}-${ordinal}`,
        evidenceRefs: [`attempts/${scenarioId}/${ordinal}/grade.json`],
        execution: { status: "completed" },
        metrics: zeroMetrics,
        ordinal,
        outcome: passed ? "passed" : "failed",
        scenarioId,
      };
    })
  ));
}

function validSummary(): EvalSuiteSummary {
  const attempts = canonicalAttempts();
  return {
    aggregates: aggregateAttempts(attempts),
    artifactType: "forge-eval-suite-summary",
    attempts,
    canonical: true,
    diagnostics: { commit: "abc123", nodeVersion: "v22.22.2" },
    generatedAt: "2026-08-03T00:00:00.000Z",
    identity: {
      endpointHash: "endpoint-hash",
      fingerprint: "experiment-hash",
      model: "openai/gpt-test",
      providerId: "openai",
      requestFingerprint: "request-hash",
      suiteFingerprint: "suite-hash",
    },
    issues: [],
    metrics: zeroMetrics,
    runId: "run-001",
    schemaVersion: 1,
    scope: "suite",
    valid: true,
  };
}

describe("eval baseline promotion", () => {
  it("normalizes a valid canonical batch even when ordinary outcomes are not all green", () => {
    const summary = validSummary();
    expect(summary.attempts).toHaveLength(CANONICAL_ATTEMPT_COUNT);

    const baseline = createEvalBaseline(summary, () => new Date("2026-08-03T01:00:00.000Z"));

    expect(baseline).toMatchObject({
      aggregates: expect.arrayContaining([
        expect.objectContaining({ passCount: 2, scenarioId: "governed-read-only" }),
        expect.objectContaining({ passCount: 0, scenarioId: "c17c-team-completion" }),
      ]),
      artifactType: "forge-eval-baseline",
      promotedAt: "2026-08-03T01:00:00.000Z",
      sourceRunId: "run-001",
    });
    expect(baseline).not.toHaveProperty("attempts");
    expect(baseline).not.toHaveProperty("diagnostics");
  });

  const rejectedSuiteShapes: Array<[string, Partial<EvalSuiteSummary>]> = [
    ["partial scope", { canonical: false, scope: "scenario" }],
    ["invalid suite", { valid: false }],
  ];

  it.each(rejectedSuiteShapes)("rejects %s", (_name, changes) => {
    expect(() => createEvalBaseline({ ...validSummary(), ...changes })).toThrow();
  });

  it("rejects missing canonical attempts and hard invariant violations", () => {
    const missing = validSummary();
    missing.attempts = missing.attempts.slice(0, -1);
    missing.aggregates = aggregateAttempts(missing.attempts);
    expect(() => createEvalBaseline(missing)).toThrow(/13 canonical attempts/);

    const hardFailure = validSummary();
    hardFailure.attempts[0].assertions[1].status = "failed";
    expect(() => createEvalBaseline(hardFailure)).toThrow(/hard invariant/);
  });

  it("rejects unavailable behavior or assertions from an allegedly valid batch", () => {
    const unavailable = validSummary();
    unavailable.attempts[0].outcome = "unavailable";
    unavailable.attempts[0].assertions[0].status = "unavailable";
    unavailable.aggregates = aggregateAttempts(unavailable.attempts);

    expect(() => createEvalBaseline(unavailable)).toThrow(/unavailable/);
  });

  it("writes the derived baseline path and requires replace for an existing identity", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-baseline-"));
    tempRoots.push(repositoryRoot);
    const summaryPath = await writeSummaryWithEvidence(repositoryRoot, "summary.json", validSummary());

    const first = await promoteEvalBaseline({
      from: summaryPath,
      now: () => new Date("2026-08-03T01:00:00.000Z"),
      replace: false,
      repositoryRoot,
    });

    expect(path.relative(repositoryRoot, first.baselinePath)).toBe(
      "eval/baselines/openai/openai-gpt-test/experiment-hash.json",
    );
    await expect(promoteEvalBaseline({
      from: summaryPath,
      replace: false,
      repositoryRoot,
    })).rejects.toThrow(/--replace/);
    await expect(promoteEvalBaseline({
      from: summaryPath,
      replace: true,
      repositoryRoot,
    })).resolves.toMatchObject({ replaced: true });
  });

  it("publishes the old/new assertion diff before replacing an existing baseline", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-replace-"));
    tempRoots.push(repositoryRoot);
    const firstSummary = validSummary();
    const firstPath = await writeSummaryWithEvidence(repositoryRoot, "first.json", firstSummary);
    const first = await promoteEvalBaseline({
      from: firstPath,
      replace: false,
      repositoryRoot,
    });
    const secondSummary = validSummary();
    secondSummary.runId = "run-002";
    secondSummary.attempts[0].assertions[0].status = "passed";
    secondSummary.attempts[0].outcome = "passed";
    secondSummary.aggregates = aggregateAttempts(secondSummary.attempts);
    const secondPath = await writeSummaryWithEvidence(repositoryRoot, "second.json", secondSummary);
    let callbackSawOldFile = false;

    const replaced = await promoteEvalBaseline({
      from: secondPath,
      onReplacementDiff: async (diffs) => {
        callbackSawOldFile = JSON.parse(await fs.readFile(first.baselinePath, "utf8")).sourceRunId === "run-001";
        expect(diffs).toContainEqual(expect.objectContaining({
          assertionId: "behavior-contract",
          delta: 1,
          scenarioId: "async-child-handoff",
        }));
      },
      replace: true,
      repositoryRoot,
    });

    expect(callbackSawOldFile).toBe(true);
    expect(replaced.replacementDiffs).toContainEqual(expect.objectContaining({ delta: 1 }));
    expect(JSON.parse(await fs.readFile(first.baselinePath, "utf8"))).toMatchObject({
      sourceRunId: "run-002",
    });
  });

  it("rejects unsafe absolute evidence references before promotion", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-unsafe-"));
    tempRoots.push(repositoryRoot);
    const unsafe = validSummary();
    unsafe.attempts[0].evidenceRefs = ["/home/user/raw-trace.jsonl"];
    const summaryPath = path.join(repositoryRoot, "summary.json");
    await fs.writeFile(summaryPath, JSON.stringify(unsafe), "utf8");

    await expect(promoteEvalBaseline({
      from: summaryPath,
      replace: false,
      repositoryRoot,
    })).rejects.toThrow(/relative evidence reference/);
  });

  it("keeps ordinary baseline promotion independent from release raw-bundle closure", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-missing-evidence-"));
    tempRoots.push(repositoryRoot);
    const summaryPath = path.join(repositoryRoot, "summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify(validSummary(), null, 2)}\n`, "utf8");

    await expect(promoteEvalBaseline({
      from: summaryPath,
      replace: false,
      repositoryRoot,
    })).resolves.toMatchObject({
      baseline: { sourceRunId: "run-001" },
    });
  });
});

async function writeSummaryWithEvidence(
  root: string,
  name: string,
  summary: EvalSuiteSummary,
): Promise<string> {
  const references = new Set(summary.attempts.flatMap((attempt) => [
    ...attempt.evidenceRefs,
    ...attempt.assertions.flatMap((assertion) => assertion.evidenceRefs),
  ]));
  for (const reference of references) {
    const pathname = path.join(root, ...reference.split("/"));
    await fs.mkdir(path.dirname(pathname), { recursive: true });
    await fs.writeFile(pathname, "{}\n", "utf8");
  }
  const summaryPath = path.join(root, name);
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summaryPath;
}
