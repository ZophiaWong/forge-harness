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

async function createRuntimeRepository(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const fixtureRoot = path.join(root, "examples", "plugins", "issue-workflow");
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "plugin.json"), "{\"enabled\":true}\n", "utf8");
  return root;
}

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
  it("fingerprints injected contract bytes without serializing their contents", async () => {
    const repositoryRoot = await createRuntimeRepository("forge-eval-contract-");
    const attemptRunner = async (input: Parameters<NonNullable<Parameters<typeof runEvalSuite>[0]["attemptRunner"]>>[0]) => (
      fakeAttempt(input.scenario.id, input.ordinal)
    );
    const firstSource = "base64:gA==";
    const secondSource = "base64:gQ==";
    const firstLoader = vi.fn(async (_runtimeRoot: string) => ({ "eval/scenarios": firstSource }));
    const secondLoader = vi.fn(async (_runtimeRoot: string) => ({ "eval/scenarios": secondSource }));

    const first = await runEvalSuite({
      attemptRunner,
      contractSourceLoader: firstLoader,
      model: "gpt-test",
      now: () => new Date("2026-08-03T01:00:00.000Z"),
      providerId: "openai",
      randomSuffix: () => "contract1",
      repositoryRoot,
      scenarioId: "governed-read-only",
    });
    const second = await runEvalSuite({
      attemptRunner,
      contractSourceLoader: secondLoader,
      model: "gpt-test",
      now: () => new Date("2026-08-03T02:00:00.000Z"),
      providerId: "openai",
      randomSuffix: () => "contract2",
      repositoryRoot,
      scenarioId: "governed-read-only",
    });

    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(secondLoader).toHaveBeenCalledTimes(1);
    expect(firstLoader).toHaveBeenCalledWith(repositoryRoot);
    expect(secondLoader).toHaveBeenCalledWith(repositoryRoot);
    expect(second.summary.identity.suiteFingerprint)
      .not.toBe(first.summary.identity.suiteFingerprint);
    expect(Object.keys(first.summary.identity).sort()).toEqual([
      "endpointHash",
      "fingerprint",
      "model",
      "providerId",
      "requestFingerprint",
      "suiteFingerprint",
    ]);
    for (const result of [first, second]) {
      const serializedArtifacts = [
        JSON.stringify(result.summary),
        JSON.stringify(result.report),
        await fs.readFile(result.artifactPaths.summaryPath, "utf8"),
        await fs.readFile(result.artifactPaths.reportPath, "utf8"),
        await fs.readFile(result.artifactPaths.markdownPath, "utf8"),
      ].join("\n");
      expect(serializedArtifacts).not.toContain(firstSource);
      expect(serializedArtifacts).not.toContain(secondSource);
      expect(serializedArtifacts).not.toContain(repositoryRoot);
    }
  });

  it("continues repetitions after behavioral failure with unavailable hard evidence", async () => {
    const repositoryRoot = await createRuntimeRepository("forge-eval-unavailable-hard-");
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
    const repositoryRoot = await createRuntimeRepository("forge-eval-suite-");
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
    const repositoryRoot = await createRuntimeRepository("forge-eval-scoped-");
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

  it("uses an explicit external baseline without falling back to repository state", async () => {
    const repositoryRoot = await createRuntimeRepository("forge-eval-explicit-baseline-");
    const attemptRunner = vi.fn(async (input: Parameters<NonNullable<Parameters<typeof runEvalSuite>[0]["attemptRunner"]>>[0]) => (
      fakeAttempt(input.scenario.id, input.ordinal)
    ));
    const first = await runEvalSuite({
      attemptRunner,
      comparisonBaseline: null,
      model: "gpt-test",
      now: () => new Date("2026-08-03T01:00:00.000Z"),
      providerId: "openai",
      randomSuffix: () => "external1",
      repositoryRoot,
      scenarioId: "governed-read-only",
    });
    const externalBaseline: EvalBaseline = {
      aggregates: first.summary.aggregates,
      artifactType: "forge-eval-baseline",
      identity: first.summary.identity,
      metrics: zeroMetrics,
      promotedAt: "2026-08-03T01:30:00.000Z",
      schemaVersion: 1,
      sourceRunId: first.summary.runId,
    };
    const corruptRepositoryBaseline = evalBaselinePath(repositoryRoot, first.summary.identity);
    await fs.mkdir(path.dirname(corruptRepositoryBaseline), { recursive: true });
    await fs.writeFile(corruptRepositoryBaseline, "not-json\n", "utf8");

    const candidate = await runEvalSuite({
      attemptRunner,
      comparisonBaseline: externalBaseline,
      model: "gpt-test",
      now: () => new Date("2026-08-03T02:00:00.000Z"),
      providerId: "openai",
      randomSuffix: () => "external2",
      repositoryRoot,
      scenarioId: "governed-read-only",
    });

    expect(candidate.summary.valid).toBe(true);
    expect(candidate.summary.issues).not.toContain("baseline_corrupt");
    expect(candidate.report).toMatchObject({
      baselineSourceRunId: first.summary.runId,
      compatibility: { status: "comparable" },
      verdict: "UNCHANGED",
    });
  });

  it("requires an explicit provider id whenever OPENAI_BASE_URL is customized", async () => {
    const repositoryRoot = await createRuntimeRepository("forge-eval-provider-");

    await expect(runEvalSuite({
      attemptRunner: vi.fn(),
      baseURL: "https://gateway.example/v1",
      model: "gpt-test",
      repositoryRoot,
      scenarioId: "governed-read-only",
    })).rejects.toThrow(/provider-id is required/);
  });

  it("hashes whichever diagnostic tool-definition sources are present", async () => {
    const repositoryRoot = await createRuntimeRepository("forge-eval-diagnostics-");
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
    const repositoryRoot = await createRuntimeRepository("forge-eval-corrupt-");
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

    const cleanRoot = await createRuntimeRepository("forge-eval-corrupt-baseline-");
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
