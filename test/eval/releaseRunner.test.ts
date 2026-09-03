import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { aggregateAttempts } from "../../src/eval/aggregate.js";
import { CANONICAL_SCENARIO_REPETITIONS } from "../../src/eval/canonicalSuite.js";
import { compareEvalSummary } from "../../src/eval/compare.js";
import {
  runEvalEvidence,
  type SubjectEvalModule,
} from "../../src/eval/releaseEvidence.js";
import type {
  EvalAttemptResult,
  EvalBaseline,
  EvalModelMetrics,
  EvalSuiteSummary,
} from "../../src/eval/types.js";
import {
  prepareEvidenceIntent,
  writeEvidenceIntent,
} from "../../src/runtime/evidenceBundle.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const zeroMetrics: EvalModelMetrics = {
  callCount: 0,
  duration: { knownCalls: 0, status: "unavailable", totalMs: 0 },
  tokens: { knownCalls: 0, status: "unavailable" },
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("Eval release evidence", () => {
  it("seals all 13 raw attempts and records an observational batch without promotion", async () => {
    const prepared = await createIntent("observation");
    const subject = fakeSubjectEvalModule(prepared.commit);

    const result = await runEvalEvidence({
      intentPath: prepared.intentPath,
      role: "observation",
    }, dependencies(subject, "evalobs1"));

    expect(result).toMatchObject({
      capture: {
        baselineEligible: false,
        behavioralVerdict: "NO_BASELINE",
        captureStatus: "sealed",
        promotionEligible: true,
      },
      exitCode: 0,
    });
    const runRoot = path.join(path.dirname(prepared.intentPath), "runs", result.capture.runId);
    const inventory = JSON.parse(await fs.readFile(
      path.join(runRoot, "private", "inventory.json"),
      "utf8",
    )) as {
      files: Array<{ path: string }>;
      references: Array<{ relation: string; source: string; target: string }>;
    };
    expect(inventory.files.filter((file) => file.path.endsWith("/grade.json"))).toHaveLength(13);
    expect(inventory.files.filter((file) => file.path.endsWith("/root-trace.jsonl"))).toHaveLength(13);
    expect(inventory.references).toHaveLength(26);
    expect(inventory.references[0]).toMatchObject({
      relation: "evidenceRef",
      source: "eval/summary.json",
    });
    expect(result.capture.artifacts?.reports).toEqual(expect.arrayContaining([
      "public/report.json",
      "public/report.md",
      "public/summary.json",
    ]));
    expect(result.capture.artifacts?.reports).not.toContain("public/baseline.json");
    await expect(fs.access(result.stagingRoot)).resolves.toBeUndefined();
  });

  it("promotes the first eligible baseline and passes only that external file to the candidate", async () => {
    const prepared = await createIntent("regression");
    const seenBaselines: Array<EvalBaseline | null | undefined> = [];
    const subject = fakeSubjectEvalModule(prepared.commit, (baseline) => {
      seenBaselines.push(baseline);
    });
    const deps = dependencies(subject, "evalreg1");

    const baseline = await runEvalEvidence({
      intentPath: prepared.intentPath,
      role: "baseline",
    }, deps);
    expect(baseline.capture).toMatchObject({
      baselineEligible: true,
      captureStatus: "sealed",
      promotionEligible: true,
    });
    const baselinePath = path.join(
      path.dirname(prepared.intentPath),
      "runs",
      baseline.capture.runId,
      "public",
      "baseline.json",
    );

    const candidate = await runEvalEvidence({
      baselinePath,
      intentPath: prepared.intentPath,
      role: "candidate",
    }, deps);

    expect(candidate.capture).toMatchObject({
      baselineEligible: false,
      captureStatus: "sealed",
      promotionEligible: true,
    });
    expect(seenBaselines).toHaveLength(2);
    expect(seenBaselines[0]).toBeNull();
    expect(seenBaselines[1]).toMatchObject({
      artifactType: "forge-eval-baseline",
      sourceRunId: "subject-run-1",
    });
  });

  it("seals a hard-violation baseline as behavioral evidence and blocks the candidate", async () => {
    const prepared = await createIntent("regression");
    const subject = fakeSubjectEvalModule(prepared.commit, undefined, (summary) => {
      const first = summary.attempts[0];
      if (first?.assertions[0]) {
        first.assertions[0] = { ...first.assertions[0], kind: "hard", status: "failed" };
        first.outcome = "failed";
      }
    });

    const baseline = await runEvalEvidence({
      intentPath: prepared.intentPath,
      role: "baseline",
    }, dependencies(subject, "evalhard"));

    expect(baseline).toMatchObject({
      capture: {
        baselineEligible: false,
        behavioralVerdict: "REGRESSED",
        captureStatus: "sealed",
        infrastructureInvalid: false,
        promotionEligible: true,
      },
      exitCode: 1,
    });
    await expect(runEvalEvidence({
      baselinePath: path.join(
        path.dirname(prepared.intentPath),
        "runs",
        baseline.capture.runId,
        "public",
        "baseline.json",
      ),
      intentPath: prepared.intentPath,
      role: "candidate",
    }, dependencies(subject, "forbidden"))).rejects.toThrow(/promotion-eligible baseline/);
  });

  it("seals but rejects a candidate whose identity is incompatible with the external baseline", async () => {
    const prepared = await createIntent("regression");
    const subject = fakeSubjectEvalModule(prepared.commit, undefined, (summary, sequence) => {
      if (sequence === 2) {
        summary.identity = { ...summary.identity, fingerprint: "incompatible-experiment" };
      }
    });
    const deps = dependencies(subject, "evaldiff");
    const baseline = await runEvalEvidence({
      intentPath: prepared.intentPath,
      role: "baseline",
    }, deps);
    const candidate = await runEvalEvidence({
      baselinePath: path.join(
        path.dirname(prepared.intentPath),
        "runs",
        baseline.capture.runId,
        "public",
        "baseline.json",
      ),
      intentPath: prepared.intentPath,
      role: "candidate",
    }, deps);

    expect(candidate).toMatchObject({
      capture: {
        behavioralVerdict: "INCOMPARABLE",
        captureStatus: "sealed",
        infrastructureInvalid: true,
        promotionEligible: false,
      },
      exitCode: 2,
    });
  });

  it("keeps an infrastructure-invalid bundle and links its one allowed retry", async () => {
    const prepared = await createIntent("observation");
    const subject = fakeSubjectEvalModule(prepared.commit);
    const failedDependencies = {
      ...dependencies(subject, "evalfail"),
      buildSubject: async () => ({
        command: "npm run --silent build",
        exitCode: 1,
        signal: null,
        stderr: "build failed",
        stdout: "",
      }),
    };
    const first = await runEvalEvidence({
      intentPath: prepared.intentPath,
      role: "observation",
    }, failedDependencies);
    expect(first).toMatchObject({
      capture: {
        captureStatus: "sealed",
        infrastructureInvalid: true,
        promotionEligible: false,
      },
      exitCode: 2,
    });

    const retry = await runEvalEvidence({
      intentPath: prepared.intentPath,
      retryOf: first.capture.runId,
      role: "observation",
    }, dependencies(subject, "evalretry"));
    expect(retry.capture).toMatchObject({
      captureStatus: "sealed",
      promotionEligible: true,
      retryOf: first.capture.runId,
    });
    await expect(runEvalEvidence({
      intentPath: prepared.intentPath,
      retryOf: retry.capture.runId,
      role: "observation",
    }, dependencies(subject, "thirdtry"))).rejects.toThrow(/cannot itself be retried|one allowed retry/);
    await expect(fs.access(path.join(
      path.dirname(prepared.intentPath),
      "runs",
      first.capture.runId,
      "private",
      `${first.capture.runId}.tgz`,
    ))).resolves.toBeUndefined();
  });

  it("preserves the subject run but fails capture when an evidenceRef is missing", async () => {
    const prepared = await createIntent("observation");
    const subject = fakeSubjectEvalModule(prepared.commit, undefined, (summary) => {
      const first = summary.attempts[0];
      if (first) {
        first.evidenceRefs = ["attempts/missing/1/grade.json"];
      }
    });

    const result = await runEvalEvidence({
      intentPath: prepared.intentPath,
      role: "observation",
    }, dependencies(subject, "evalrefs"));

    expect(result).toMatchObject({
      capture: {
        behavioralVerdict: "NO_BASELINE",
        captureStatus: "failed",
        promotionEligible: false,
        reasonCode: "eval_capture_failed",
      },
      exitCode: 2,
    });
    await expect(fs.access(path.join(
      path.dirname(prepared.intentPath),
      "..",
      "..",
      "evals",
      "subject-run-1",
    ))).resolves.toBeUndefined();
    await expect(fs.access(path.join(
      path.dirname(prepared.intentPath),
      "staging",
      result.capture.runId,
    ))).resolves.toBeUndefined();
  });
});

function dependencies(subject: SubjectEvalModule, suffix: string) {
  return {
    buildSubject: async () => ({
      command: "npm run --silent build",
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "built\n",
    }),
    environment: {
      EVIDENCE_PROVIDER_ID: "my-gateway",
      OPENAI_API_KEY: "test-only-key",
      OPENAI_BASE_URL: "https://gateway.example/v1",
    },
    loadSubjectModule: vi.fn(async () => subject),
    now: sequenceDates(
      "2026-08-28T04:00:00.000Z",
      "2026-08-28T04:10:00.000Z",
      "2026-08-28T04:11:00.000Z",
      "2026-08-28T05:00:00.000Z",
      "2026-08-28T05:10:00.000Z",
      "2026-08-28T05:11:00.000Z",
    ),
    randomSuffix: () => suffix,
  };
}

async function createIntent(mode: "observation" | "regression") {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-evidence-source-"));
  tempRoots.push(repository);
  await git(repository, ["init", "-q"]);
  await git(repository, ["config", "user.name", "Forge Eval Evidence"]);
  await git(repository, ["config", "user.email", "eval-evidence@example.invalid"]);
  await fs.writeFile(path.join(repository, ".gitignore"), ".forge/\ndist/\n", "utf8");
  await fs.writeFile(path.join(repository, "source.txt"), "subject\n", "utf8");
  await git(repository, ["add", ".gitignore", "source.txt"]);
  await git(repository, ["commit", "-qm", "subject"]);
  await git(repository, ["tag", "v1.0.0"]);
  const commit = await git(repository, ["rev-parse", "HEAD"]);
  const intent = await prepareEvidenceIntent({
    collectorRoot: repository,
    endpoint: "https://gateway.example/v1",
    mode,
    model: "gpt-5.4-mini",
    now: () => new Date("2026-08-28T01:00:00.000Z"),
    providerId: "my-gateway",
    randomSuffix: () => "intent01",
    ref: "v1.0.0",
    subjectRoot: repository,
  });
  return {
    commit,
    intentPath: await writeEvidenceIntent(intent, undefined, repository),
  };
}

function fakeSubjectEvalModule(
  commit: string,
  observeBaseline: (baseline: EvalBaseline | null | undefined) => void = () => undefined,
  customizeSummary: (summary: EvalSuiteSummary, sequence: number) => void = () => undefined,
): SubjectEvalModule {
  let runSequence = 0;
  return {
    async runEvalSuite(options) {
      runSequence += 1;
      observeBaseline(options.comparisonBaseline);
      const runId = `subject-run-${runSequence}`;
      const runRoot = path.join(options.repositoryRoot, ".forge", "evals", runId);
      const attempts = canonicalAttempts();
      for (const attempt of attempts) {
        const attemptRoot = path.join(
          runRoot,
          "attempts",
          attempt.scenarioId,
          String(attempt.ordinal),
        );
        await fs.mkdir(attemptRoot, { recursive: true });
        await fs.writeFile(path.join(attemptRoot, "grade.json"), "{\"outcome\":\"passed\"}\n", "utf8");
        await fs.writeFile(path.join(attemptRoot, "root-trace.jsonl"), "{\"sequence\":1}\n", "utf8");
      }
      const summary: EvalSuiteSummary = {
        aggregates: aggregateAttempts(attempts),
        artifactType: "forge-eval-suite-summary",
        attempts,
        canonical: true,
        diagnostics: { commit },
        generatedAt: `2026-08-28T0${runSequence + 4}:00:00.000Z`,
        identity: {
          endpointHash: "endpoint",
          fingerprint: "experiment",
          model: "gpt-5.4-mini",
          providerId: "my-gateway",
          requestFingerprint: "request",
          suiteFingerprint: "suite",
        },
        issues: [],
        metrics: zeroMetrics,
        runId,
        schemaVersion: 1,
        scope: "suite",
        valid: true,
      };
      customizeSummary(summary, runSequence);
      const report = compareEvalSummary(summary, options.comparisonBaseline ?? undefined);
      const summaryPath = path.join(runRoot, "summary.json");
      const reportPath = path.join(runRoot, "report.json");
      const markdownPath = path.join(runRoot, "report.md");
      await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      await fs.writeFile(markdownPath, `# Eval\n\n- Verdict: \`${report.verdict}\`\n`, "utf8");
      return {
        artifactPaths: { markdownPath, reportPath, summaryPath },
        report,
        runRoot,
        summary,
      };
    },
  };
}

function canonicalAttempts(): EvalAttemptResult[] {
  return Object.entries(CANONICAL_SCENARIO_REPETITIONS).flatMap(([scenarioId, repetitions]) => (
    Array.from({ length: repetitions }, (_, index): EvalAttemptResult => {
      const ordinal = index + 1;
      const evidenceRefs = [
        `attempts/${scenarioId}/${ordinal}/grade.json`,
        `attempts/${scenarioId}/${ordinal}/root-trace.jsonl`,
      ];
      return {
        assertions: [{ evidenceRefs, id: "behavior", kind: "outcome", status: "passed" }],
        attemptId: `${scenarioId}-${ordinal}`,
        evidenceRefs,
        execution: { status: "completed" },
        metrics: zeroMetrics,
        ordinal,
        outcome: "passed",
        scenarioId,
      };
    })
  ));
}

function sequenceDates(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)] as string);
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}
