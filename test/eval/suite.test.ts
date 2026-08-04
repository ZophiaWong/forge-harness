import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { evalBaselinePath } from "../../src/eval/baseline.js";
import { runEvalSuite } from "../../src/eval/suite.js";
import type { RunEvalAttemptResult } from "../../src/eval/runner.js";
import type {
  EvalAssertionStatus,
  EvalAttemptResult,
  EvalBaseline,
  EvalModelMetrics,
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

function fakeAttempt(
  scenarioId: string,
  ordinal: number,
  options: {
    hardFailure?: boolean;
    hardStatus?: EvalAssertionStatus;
    invalid?: boolean;
    outcome?: EvalAttemptResult["outcome"];
  } = {},
): RunEvalAttemptResult {
  return {
    attempt: {
      assertions: [{
        evidenceRefs: [`attempts/${scenarioId}/${ordinal}/grade.json`],
        id: "contract",
        kind: options.hardFailure || options.hardStatus ? "hard" : "outcome",
        status: options.hardStatus
          ?? (options.hardFailure || options.outcome === "failed" ? "failed" : "passed"),
      }],
      attemptId: `${scenarioId}-${ordinal}`,
      evidenceRefs: [`attempts/${scenarioId}/${ordinal}/grade.json`],
      execution: options.invalid
        ? { reasonCode: "provider_error", status: "invalid" }
        : { status: "completed" },
      metrics: zeroMetrics,
      ordinal,
      outcome: options.invalid ? "unavailable" : options.outcome ?? "passed",
      scenarioId,
    },
    sessions: [],
    workspace: "/private/fake",
  };
}

describe("eval suite runner", () => {
  it("continues repetitions after behavioral failure with unavailable hard evidence", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-unavailable-hard-"));
    tempRoots.push(repositoryRoot);
    const calls: number[] = [];

    const result = await runEvalSuite({
      attemptRunner: async (input) => {
        calls.push(input.ordinal);
        return fakeAttempt(input.scenario.id, input.ordinal, {
          hardStatus: "unavailable",
          outcome: "failed",
        });
      },
      model: "gpt-test",
      providerId: "openai",
      repositoryRoot,
      scenarioId: "compaction-retention",
    });

    expect(calls).toEqual([1, 2, 3]);
    expect(result.summary.valid).toBe(true);
    expect(result.report.verdict).not.toBe("REGRESSED");
  });

  it("runs the canonical attempts serially, continues ordinary failures, and writes a partial invalid report", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-suite-"));
    tempRoots.push(repositoryRoot);
    await fs.mkdir(path.join(repositoryRoot, ".forge"), { recursive: true });
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const attemptRunner = vi.fn(async (input: Parameters<NonNullable<Parameters<typeof runEvalSuite>[0]["attemptRunner"]>>[0]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(`${input.scenario.id}-${input.ordinal}`);
      await Promise.resolve();
      active -= 1;
      if (calls.length === 2) {
        return fakeAttempt(input.scenario.id, input.ordinal, { outcome: "failed" });
      }
      if (calls.length === 4) {
        return fakeAttempt(input.scenario.id, input.ordinal, { invalid: true });
      }
      return fakeAttempt(input.scenario.id, input.ordinal);
    });

    const result = await runEvalSuite({
      attemptRunner,
      model: "gpt-test",
      now: () => new Date("2026-08-03T01:02:03.000Z"),
      providerId: "openai",
      randomSuffix: () => "abcd1234",
      repositoryRoot,
    });

    expect(maxActive).toBe(1);
    expect(calls).toEqual([
      "governed-read-only-1",
      "governed-read-only-2",
      "governed-read-only-3",
      "verification-recovery-1",
    ]);
    expect(result.summary).toMatchObject({
      canonical: true,
      issues: ["provider_error", "partial_suite"],
      scope: "suite",
      valid: false,
    });
    expect(result.report.verdict).toBe("INVALID");
    expect(JSON.parse(await fs.readFile(path.join(result.runRoot, ".forge-eval-run.json"), "utf8")))
      .toMatchObject({ status: "invalid" });
    await expect(fs.stat(path.join(result.runRoot, "summary.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(result.runRoot, "report.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(result.runRoot, "report.md"))).resolves.toBeDefined();
  });

  it("compares a scoped scenario against only that scenario in a full baseline", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-scoped-"));
    tempRoots.push(repositoryRoot);
    const attemptRunner = vi.fn(async (input: Parameters<NonNullable<Parameters<typeof runEvalSuite>[0]["attemptRunner"]>>[0]) => (
      fakeAttempt(input.scenario.id, input.ordinal)
    ));
    const first = await runEvalSuite({
      attemptRunner,
      model: "gpt-test",
      now: () => new Date("2026-08-03T01:00:00.000Z"),
      providerId: "openai",
      randomSuffix: () => "first001",
      repositoryRoot,
      scenarioId: "governed-read-only",
    });
    const baseline: EvalBaseline = {
      aggregates: [{
        assertionPassCounts: { contract: 3 },
        attemptCount: 3,
        passCount: 3,
        scenarioId: "governed-read-only",
      }, {
        assertionPassCounts: { other: 1 },
        attemptCount: 1,
        passCount: 1,
        scenarioId: "c17c-team-completion",
      }],
      artifactType: "forge-eval-baseline",
      identity: first.summary.identity,
      metrics: zeroMetrics,
      promotedAt: "2026-08-03T01:01:00.000Z",
      schemaVersion: 1,
      sourceRunId: "baseline-run",
    };
    const baselinePath = evalBaselinePath(repositoryRoot, baseline.identity);
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const second = await runEvalSuite({
      attemptRunner,
      model: "gpt-test",
      now: () => new Date("2026-08-03T02:00:00.000Z"),
      providerId: "openai",
      randomSuffix: () => "second01",
      repositoryRoot,
      scenarioId: "governed-read-only",
    });

    expect(second.summary).toMatchObject({ canonical: false, scope: "scenario", valid: true });
    expect(second.report).toMatchObject({
      compatibility: { status: "comparable" },
      exitCode: 0,
      verdict: "UNCHANGED",
    });
    expect(second.report.diffs.every((diff) => diff.scenarioId === "governed-read-only")).toBe(true);
  });

  it("requires an explicit provider id whenever OPENAI_BASE_URL is customized", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-provider-"));
    tempRoots.push(repositoryRoot);

    await expect(runEvalSuite({
      attemptRunner: vi.fn(),
      baseURL: "https://gateway.example/v1",
      model: "gpt-test",
      repositoryRoot,
      scenarioId: "governed-read-only",
    })).rejects.toThrow(/provider-id is required/);
  });

  it("hashes whichever diagnostic tool-definition sources are present", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-diagnostics-"));
    tempRoots.push(repositoryRoot);
    await fs.mkdir(path.join(repositoryRoot, "src", "tools"), { recursive: true });
    await fs.writeFile(
      path.join(repositoryRoot, "src", "tools", "defaultRuntime.ts"),
      "export const diagnostic = true;\n",
      "utf8",
    );

    const result = await runEvalSuite({
      attemptRunner: async (input) => fakeAttempt(input.scenario.id, input.ordinal),
      model: "gpt-test",
      providerId: "openai",
      repositoryRoot,
      scenarioId: "governed-read-only",
    });

    expect(result.summary.diagnostics.toolDefinitionsFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("turns fixture-runner and baseline corruption into partial INVALID reports", async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-corrupt-"));
    tempRoots.push(repositoryRoot);
    const thrown = await runEvalSuite({
      attemptRunner: vi.fn(async () => {
        throw new Error("git init failed");
      }),
      model: "gpt-test",
      providerId: "openai",
      repositoryRoot,
      scenarioId: "governed-read-only",
    });
    expect(thrown.report.verdict).toBe("INVALID");
    expect(thrown.summary).toMatchObject({ issues: ["fixture_error", "partial_suite"], valid: false });

    const cleanRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-corrupt-baseline-"));
    tempRoots.push(cleanRoot);
    const attemptRunner = vi.fn(async (input: Parameters<NonNullable<Parameters<typeof runEvalSuite>[0]["attemptRunner"]>>[0]) => (
      fakeAttempt(input.scenario.id, input.ordinal)
    ));
    const first = await runEvalSuite({
      attemptRunner,
      model: "gpt-test",
      providerId: "openai",
      repositoryRoot: cleanRoot,
      scenarioId: "governed-read-only",
    });
    const corruptPath = evalBaselinePath(cleanRoot, first.summary.identity);
    await fs.mkdir(path.dirname(corruptPath), { recursive: true });
    await fs.writeFile(corruptPath, "{not-json}\n", "utf8");

    const corrupt = await runEvalSuite({
      attemptRunner,
      model: "gpt-test",
      providerId: "openai",
      repositoryRoot: cleanRoot,
      scenarioId: "governed-read-only",
    });
    expect(corrupt.report.verdict).toBe("INVALID");
    expect(corrupt.summary.issues).toContain("baseline_corrupt");
  });
});
