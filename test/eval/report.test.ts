import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { aggregateAttempts } from "../../src/eval/aggregate.js";
import { compareEvalSummary } from "../../src/eval/compare.js";
import {
  assertPublicEvalArtifact,
  renderRegressionReportMarkdown,
  writeEvalArtifacts,
} from "../../src/eval/report.js";
import type {
  EvalAttemptResult,
  EvalBaseline,
  EvalModelMetrics,
  EvalSuiteSummary,
} from "../../src/eval/types.js";

const tempRoots: string[] = [];
const metrics: EvalModelMetrics = {
  callCount: 2,
  duration: { knownCalls: 2, status: "complete", totalMs: 250 },
  tokens: {
    knownCalls: 1,
    status: "partial",
    totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  },
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

function createSummary(hardFailure = false): EvalSuiteSummary {
  const attempt: EvalAttemptResult = {
    assertions: [{
      evidenceRefs: ["attempts/governed-read-only/1/grade.json"],
      id: "final-exact",
      kind: "outcome",
      status: "failed",
    }, {
      evidenceRefs: ["attempts/governed-read-only/1/trace.jsonl"],
      id: "permission-evidence",
      kind: "hard",
      status: hardFailure ? "failed" : "passed",
    }],
    attemptId: "governed-read-only-1",
    evidenceRefs: ["attempts/governed-read-only/1/grade.json"],
    execution: { status: "completed" },
    metrics,
    ordinal: 1,
    outcome: "failed",
    scenarioId: "governed-read-only",
  };
  return {
    aggregates: aggregateAttempts([attempt]),
    artifactType: "forge-eval-suite-summary",
    attempts: [attempt],
    canonical: false,
    diagnostics: { commit: "abc123" },
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
    metrics,
    runId: "run-002",
    schemaVersion: 1,
    scope: "scenario",
    valid: true,
  };
}

function createBaseline(candidate: EvalSuiteSummary): EvalBaseline {
  return {
    aggregates: [{
      assertionPassCounts: { "final-exact": 1 },
      attemptCount: 1,
      passCount: 1,
      scenarioId: "governed-read-only",
    }],
    artifactType: "forge-eval-baseline",
    identity: candidate.identity,
    metrics: {
      callCount: 1,
      duration: { knownCalls: 1, status: "complete", totalMs: 100 },
      tokens: {
        knownCalls: 1,
        status: "complete",
        totals: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      },
    },
    promotedAt: "2026-08-02T00:00:00.000Z",
    schemaVersion: 1,
    sourceRunId: "run-001",
  };
}

describe("eval public reports", () => {
  it("renders verdict behavior diffs findings and non-blocking metrics", () => {
    const candidate = createSummary(true);
    const report = compareEvalSummary(candidate, createBaseline(candidate));

    const markdown = renderRegressionReportMarkdown(report);

    expect(markdown).toContain("# Forge Offline Eval Regression Report");
    expect(markdown).toContain("Verdict: `REGRESSED`");
    expect(markdown).toContain("permission-evidence");
    expect(markdown).toContain("final-exact");
    expect(markdown).toContain("| 1 | 0 | -1 |");
    expect(markdown).toContain("Token coverage: `partial` (1/2 calls)");
    expect(markdown).toContain("Token totals are informational and do not affect the verdict.");
  });

  it("rejects raw model fields and absolute paths from public artifacts", () => {
    expect(() => assertPublicEvalArtifact({ outputText: "raw model answer" })).toThrow(/outputText/);
    expect(() => assertPublicEvalArtifact({ evidenceRefs: ["C:\\Users\\Poter\\trace.jsonl"] })).toThrow(
      /absolute or unsafe path/,
    );
    expect(() => assertPublicEvalArtifact({ nested: { argumentsText: "{\"command\":\"pwd\"}" } })).toThrow(
      /argumentsText/,
    );
  });

  it("writes only sanitized summary JSON report JSON and Markdown", async () => {
    const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-report-"));
    tempRoots.push(runRoot);
    const candidate = createSummary();
    const report = compareEvalSummary(candidate, createBaseline(candidate));

    const paths = await writeEvalArtifacts({ report, runRoot, summary: candidate });

    expect(Object.keys(paths).sort()).toEqual(["markdownPath", "reportPath", "summaryPath"]);
    expect(JSON.parse(await fs.readFile(paths.summaryPath, "utf8"))).toEqual(candidate);
    expect(JSON.parse(await fs.readFile(paths.reportPath, "utf8"))).toEqual(report);
    expect(await fs.readFile(paths.markdownPath, "utf8")).toContain("Verdict: `REGRESSED`");
  });
});
