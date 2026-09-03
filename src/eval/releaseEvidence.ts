import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertEvidenceRunMayStart,
  beginEvidenceCapture,
  recordEvidenceCaptureFailure,
  reserveEvidenceRun,
  sealRunEvidence,
  verifyRunEvidence,
  type EvidenceCaptureResult,
} from "../runtime/evidenceBundle.js";
import {
  captureBuild,
  formatEvidenceTimestamp,
  runCapturedCommand,
  serializePrivateError,
  writeEvidenceJson,
  type CapturedCommandEvidence,
} from "../runtime/evidenceCollectorSupport.js";
import { createEvalBaseline } from "./baseline.js";
import { CANONICAL_ATTEMPT_COUNT } from "./canonicalSuite.js";
import { compareEvalSummary } from "./compare.js";
import { assertEvalEvidenceRefsClosed } from "./evidence.js";
import { canonicalJson } from "./fingerprint.js";
import { renderRegressionReportMarkdown } from "./report.js";
import { parseEvalBaseline, parseEvalSuiteSummary } from "./schema.js";
import type { RunEvalSuiteOptions, RunEvalSuiteResult } from "./suite.js";
import type { EvalBaseline, EvalSuiteSummary } from "./types.js";

export interface SubjectEvalModule {
  runEvalSuite(options: RunEvalSuiteOptions): Promise<RunEvalSuiteResult>;
}

export type CapturedEvalCommandEvidence = CapturedCommandEvidence;

export interface EvalEvidenceDependencies {
  buildSubject(subjectRoot: string): Promise<CapturedEvalCommandEvidence>;
  environment: NodeJS.ProcessEnv;
  loadSubjectModule(modulePath: string): Promise<SubjectEvalModule>;
  now(): Date;
  randomSuffix(): string;
}

export interface RunEvalEvidenceOptions {
  baselinePath?: string;
  intentPath: string;
  retryOf?: string;
  role: "baseline" | "candidate" | "observation";
}

export interface RunEvalEvidenceResult {
  capture: EvidenceCaptureResult;
  exitCode: 0 | 1 | 2;
  stagingRoot: string;
}

/**
 * Executes the tagged subject's Eval runner and seals its complete run root.
 * The collector owns selection/capture; the subject still owns execution and grading.
 */
export async function runEvalEvidence(
  options: RunEvalEvidenceOptions,
  dependencies: EvalEvidenceDependencies = defaultDependencies(),
): Promise<RunEvalEvidenceResult> {
  const selection = await assertEvidenceRunMayStart({
    intentPath: options.intentPath,
    kind: "eval",
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
    role: options.role,
  });
  const intent = selection.intent;
  assertEnvironmentMatchesIntent(intent.environment, dependencies.environment);
  const sourceAtStart = await beginEvidenceCapture(intent);
  const startedAt = dependencies.now();
  const runId = createEvalEvidenceRunId(options.role, startedAt, dependencies.randomSuffix());
  const reserved = await reserveEvidenceRun({
    intentPath: options.intentPath,
    kind: "eval",
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
    role: options.role,
    runId,
    startedAt: startedAt.toISOString(),
  });
  const intentRoot = path.dirname(path.resolve(options.intentPath));
  const runsRoot = path.join(intentRoot, "runs");
  const stagingRoot = path.join(intentRoot, "staging", runId);
  await fs.mkdir(path.dirname(stagingRoot), { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: false });
  await fs.mkdir(path.join(stagingRoot, "operator"), { recursive: true });
  await writeEvidenceJson(path.join(stagingRoot, "reservation.json"), reserved.reservation);

  const build = await captureBuild(dependencies.buildSubject, intent.subject.checkout);
  await writeEvidenceJson(path.join(stagingRoot, "operator", "subject-build.json"), build);

  let suiteResult: RunEvalSuiteResult | undefined;
  let executionError: unknown;
  let comparisonBaseline: EvalBaseline | null = null;
  try {
    if (build.exitCode !== 0 || build.signal !== null) {
      throw new Error("subject build failed before Eval execution");
    }
    if (options.role === "candidate") {
      comparisonBaseline = await loadSealedExternalBaseline({
        baselinePath: options.baselinePath as string,
        intentId: intent.intentId,
        intentRoot,
      });
    }
    const subject = await dependencies.loadSubjectModule(
      path.join(intent.subject.checkout, "dist", "eval", "suite.js"),
    );
    suiteResult = await subject.runEvalSuite({
      ...(dependencies.environment.OPENAI_API_KEY
        ? { apiKey: dependencies.environment.OPENAI_API_KEY }
        : {}),
      ...(dependencies.environment.OPENAI_BASE_URL
        ? { baseURL: dependencies.environment.OPENAI_BASE_URL }
        : {}),
      comparisonBaseline,
      model: intent.environment.model,
      providerId: intent.environment.providerId,
      repositoryRoot: intent.subject.checkout,
    });
  } catch (error) {
    executionError = error;
  }

  if (!suiteResult) {
    const completedAt = dependencies.now();
    await writeEvidenceJson(path.join(stagingRoot, "operator", "eval-execution.json"), {
      error: serializePrivateError(executionError),
      status: "infrastructure-invalid",
    });
    const publicReportPath = path.join(stagingRoot, "operator", "report.json");
    await writeEvidenceJson(publicReportPath, {
      role: options.role,
      status: "infrastructure-invalid",
      verdict: "INVALID",
    });
    const run = {
      baselineEligible: false,
      behavior: {
        infrastructureInvalid: true,
        valid: false,
        verdict: "INVALID",
      },
      completedAt: completedAt.toISOString(),
      infrastructureInvalid: true,
      kind: "eval" as const,
      limitations: evidenceLimitations(intent.subject.commit === intent.collector.commit),
      promotionEligible: false,
      ...(options.retryOf ? { retryOf: options.retryOf } : {}),
      role: options.role,
      runId,
      startedAt: startedAt.toISOString(),
    };
    const capture = await sealRunEvidence({
      intent,
      now: dependencies.now,
      outputRoot: runsRoot,
      publicArtifacts: [{ name: "report.json", path: publicReportPath }],
      rawSources: [{ prefix: "operator", root: path.join(stagingRoot, "operator") }],
      run,
      sourceAtStart,
    });
    return { capture, exitCode: 2, stagingRoot };
  }

  const completedAt = dependencies.now();
  const summary = suiteResult.summary;
  const publicReport = options.role === "candidate"
    ? suiteResult.report
    : compareEvalSummary(summary);
  const hardViolation = hasHardViolation(summary);
  const candidateComparisonInvalid = options.role === "candidate"
    && (suiteResult.report.compatibility.status !== "comparable"
      || suiteResult.report.baselineSourceRunId !== comparisonBaseline?.sourceRunId);
  const infrastructureInvalid = isInfrastructureInvalid(summary)
    || candidateComparisonInvalid;
  const baselineEligible = options.role === "baseline"
    && isBaselineEligible(summary, hardViolation, infrastructureInvalid);
  const promotionEligible = !infrastructureInvalid;
  const behavior = {
    attemptCount: summary.attempts.length,
    canonical: summary.canonical,
    hardViolation,
    infrastructureInvalid,
    sourceRunId: summary.runId,
    valid: summary.valid,
    verdict: publicReport.verdict,
  };
  const run = {
    baselineEligible,
    behavior,
    completedAt: completedAt.toISOString(),
    infrastructureInvalid,
    kind: "eval" as const,
    limitations: evidenceLimitations(intent.subject.commit === intent.collector.commit),
    promotionEligible,
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
    role: options.role,
    runId,
    startedAt: startedAt.toISOString(),
  };

  const publicReportPath = path.join(stagingRoot, "operator", "report.json");
  const publicMarkdownPath = path.join(stagingRoot, "operator", "report.md");
  await Promise.all([
    writeEvidenceJson(publicReportPath, publicReport),
    fs.writeFile(publicMarkdownPath, renderRegressionReportMarkdown(publicReport), "utf8"),
  ]);
  const publicArtifacts = [
    { name: "report.json", path: publicReportPath },
    { name: "report.md", path: publicMarkdownPath },
    { name: "summary.json", path: suiteResult.artifactPaths.summaryPath },
  ];

  let captureError: unknown;
  let closedReferences: string[] = [];
  try {
    await assertSubjectEvalResult(suiteResult, intent.subject.checkout);
    assertSubjectCommit(summary, intent.subject.commit);
    closedReferences = await assertEvalEvidenceRefsClosed(suiteResult.runRoot, summary);
    if (baselineEligible) {
      const baseline = createEvalBaseline(summary, dependencies.now);
      const baselinePath = path.join(stagingRoot, "operator", "baseline.json");
      await writeEvidenceJson(baselinePath, baseline);
      publicArtifacts.push({ name: "baseline.json", path: baselinePath });
    }
    await writeEvidenceJson(path.join(stagingRoot, "operator", "eval-result.json"), {
      attemptCount: summary.attempts.length,
      baselineEligible,
      canonical: summary.canonical,
      hardViolation,
      infrastructureInvalid,
      role: options.role,
      sourceRunId: summary.runId,
      valid: summary.valid,
      verdict: publicReport.verdict,
    });
  } catch (error) {
    captureError = error;
  }

  let capture: EvidenceCaptureResult;
  if (captureError) {
    capture = await recordEvidenceCaptureFailure({
      intent,
      outputRoot: runsRoot,
      reasonCode: "eval_capture_failed",
      run,
    });
  } else {
    capture = await sealRunEvidence({
      intent,
      now: dependencies.now,
      outputRoot: runsRoot,
      publicArtifacts,
      rawReferences: closedReferences.map((reference) => ({
        relation: "evidenceRef" as const,
        source: "eval/summary.json",
        target: `eval/${reference}`,
      })),
      rawSources: [
        { prefix: "eval", root: suiteResult.runRoot },
        { prefix: "operator", root: path.join(stagingRoot, "operator") },
      ],
      requiredRawPaths: closedReferences.map((reference) => `eval/${reference}`),
      run,
      sourceAtStart,
    });
  }

  return {
    capture,
    exitCode: evalExitCode(capture, publicReport.verdict, hardViolation, infrastructureInvalid),
    stagingRoot,
  };
}

async function assertSubjectEvalResult(
  result: RunEvalSuiteResult,
  subjectRoot: string,
): Promise<void> {
  const runRoot = path.resolve(result.runRoot);
  const evalRoot = path.resolve(subjectRoot, ".forge", "evals");
  const relativeRun = path.relative(evalRoot, runRoot);
  const runStats = await fs.lstat(runRoot);
  if (!relativeRun
    || relativeRun.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeRun)
    || relativeRun.includes(path.sep)
    || !runStats.isDirectory()
    || runStats.isSymbolicLink()
    || await fs.realpath(runRoot) !== runRoot) {
    throw new Error("subject Eval run root is outside the allowed evidence root");
  }

  for (const artifactPath of [
    result.artifactPaths.summaryPath,
    result.artifactPaths.reportPath,
    result.artifactPaths.markdownPath,
  ]) {
    const resolved = path.resolve(artifactPath);
    const relative = path.relative(runRoot, resolved);
    const stats = await fs.lstat(resolved);
    if (!relative
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
      || relative.includes(path.sep)
      || !stats.isFile()
      || stats.isSymbolicLink()
      || await fs.realpath(resolved) !== resolved) {
      throw new Error("subject Eval public artifact escaped its run root");
    }
  }

  const diskSummary = parseEvalSuiteSummary(JSON.parse(await fs.readFile(
    result.artifactPaths.summaryPath,
    "utf8",
  )) as unknown);
  const diskReport = JSON.parse(await fs.readFile(result.artifactPaths.reportPath, "utf8")) as unknown;
  if (diskSummary.runId !== path.basename(runRoot)
    || canonicalJson(diskSummary) !== canonicalJson(result.summary)
    || canonicalJson(diskReport) !== canonicalJson(result.report)
    || result.report.candidateRunId !== diskSummary.runId) {
    throw new Error("subject Eval returned artifacts do not match its in-memory result");
  }
}

async function loadSealedExternalBaseline(options: {
  baselinePath: string;
  intentId: string;
  intentRoot: string;
}): Promise<EvalBaseline> {
  const baselinePath = path.resolve(options.baselinePath);
  const relative = path.relative(options.intentRoot, baselinePath);
  const segments = relative.split(path.sep);
  if (segments.length !== 4
    || segments[0] !== "runs"
    || segments[2] !== "public"
    || segments[3] !== "baseline.json"
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error("candidate baseline must be a prior sealed baseline from the same evidence intent");
  }
  const runId = segments[1] as string;
  const runRoot = path.join(options.intentRoot, "runs", runId);
  const [runStats, publicStats, baselineStats] = await Promise.all([
    fs.lstat(runRoot),
    fs.lstat(path.dirname(baselinePath)),
    fs.lstat(baselinePath),
  ]);
  if (!runStats.isDirectory()
    || runStats.isSymbolicLink()
    || !publicStats.isDirectory()
    || publicStats.isSymbolicLink()
    || await fs.realpath(runRoot) !== runRoot
    || await fs.realpath(path.dirname(baselinePath)) !== path.dirname(baselinePath)) {
    throw new Error("candidate baseline path cannot resolve through a symlink");
  }
  if (!baselineStats.isFile() || baselineStats.isSymbolicLink()) {
    throw new Error("candidate baseline must be a physical file");
  }
  if (await fs.realpath(baselinePath) !== baselinePath) {
    throw new Error("candidate baseline path cannot resolve through a symlink");
  }
  const capture = JSON.parse(await fs.readFile(
    path.join(runRoot, "capture-result.json"),
    "utf8",
  )) as {
    artifacts?: { archive?: string; manifest?: string; reports?: string[] };
    baselineEligible?: boolean;
    captureStatus?: string;
    intentId?: string;
    promotionEligible?: boolean;
    role?: string;
    runId?: string;
  };
  if (capture.intentId !== options.intentId
    || capture.runId !== runId
    || capture.role !== "baseline"
    || capture.captureStatus !== "sealed"
    || capture.baselineEligible !== true
    || capture.promotionEligible !== true
    || !capture.artifacts?.archive
    || !capture.artifacts.manifest
    || !capture.artifacts.reports?.includes("public/baseline.json")) {
    throw new Error("candidate baseline is not backed by an eligible sealed baseline capture");
  }
  await verifyRunEvidence({
    archivePath: resolveInsideRun(runRoot, capture.artifacts.archive),
    manifestPath: resolveInsideRun(runRoot, capture.artifacts.manifest),
  });
  return parseEvalBaseline(JSON.parse(await fs.readFile(baselinePath, "utf8")) as unknown);
}

function resolveInsideRun(runRoot: string, relativePath: string): string {
  if (!relativePath
    || relativePath.includes("\\")
    || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("sealed capture contains an unsafe artifact path");
  }
  const resolved = path.resolve(runRoot, ...relativePath.split("/"));
  const relative = path.relative(runRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("sealed capture artifact escaped its run root");
  }
  return resolved;
}

function assertSubjectCommit(summary: EvalSuiteSummary, expectedCommit: string): void {
  if (summary.diagnostics.commit !== expectedCommit) {
    throw new Error("Eval diagnostics commit does not match the evidence subject commit");
  }
}

function hasHardViolation(summary: EvalSuiteSummary): boolean {
  return summary.attempts.some((attempt) => attempt.assertions.some((assertion) => (
    assertion.kind === "hard" && assertion.status === "failed"
  )));
}

function isInfrastructureInvalid(summary: EvalSuiteSummary): boolean {
  return summary.attempts.some((attempt) => attempt.execution.status === "invalid")
    || (!summary.valid && !hasHardViolation(summary));
}

function isBaselineEligible(
  summary: EvalSuiteSummary,
  hardViolation: boolean,
  infrastructureInvalid: boolean,
): boolean {
  return summary.canonical
    && summary.scope === "suite"
    && summary.attempts.length === CANONICAL_ATTEMPT_COUNT
    && summary.valid
    && !hardViolation
    && !infrastructureInvalid
    && summary.attempts.every((attempt) => (
      attempt.execution.status === "completed"
      && attempt.outcome !== "unavailable"
      && attempt.assertions.every((assertion) => assertion.status !== "unavailable")
    ));
}

function evidenceLimitations(sameCollector: boolean): string[] {
  return [
    "Private raw archives require maintainer-controlled storage.",
    "Observation and baseline public reports intentionally ignore repository-local baselines; subject reports remain in the private raw archive.",
    ...(sameCollector
      ? []
      : ["The external collector records subject and collector commits separately."]),
  ];
}

function evalExitCode(
  capture: EvidenceCaptureResult,
  verdict: string,
  hardViolation: boolean,
  infrastructureInvalid: boolean,
): 0 | 1 | 2 {
  if (capture.captureStatus === "failed" || infrastructureInvalid || verdict === "INCOMPARABLE") {
    return 2;
  }
  if (hardViolation || verdict === "REGRESSED") {
    return 1;
  }
  return 0;
}

function assertEnvironmentMatchesIntent(
  expected: { endpointHash: string; model: string; providerId: string },
  environment: NodeJS.ProcessEnv,
): void {
  const endpoint = environment.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const providerId = environment.EVIDENCE_PROVIDER_ID?.trim()
    || environment.EVAL_PROVIDER_ID?.trim()
    || "my-gateway";
  const endpointHash = crypto.createHash("sha256").update(endpoint).digest("hex");
  if (endpointHash !== expected.endpointHash || providerId !== expected.providerId || !expected.model.trim()) {
    throw new Error("Eval environment identity does not match the evidence intent");
  }
}

function createEvalEvidenceRunId(
  role: RunEvalEvidenceOptions["role"],
  now: Date,
  suffixValue: string,
): string {
  const suffix = suffixValue.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!suffix) {
    throw new Error("Eval evidence random suffix must contain a letter or number");
  }
  return `eval-${role}-${formatEvidenceTimestamp(now)}-${suffix}`;
}

function defaultDependencies(): EvalEvidenceDependencies {
  return {
    buildSubject: (subjectRoot) => (
      runCapturedCommand("npm", ["run", "--silent", "build"], subjectRoot)
    ),
    environment: process.env,
    async loadSubjectModule(modulePath) {
      return await import(pathToFileURL(modulePath).href) as SubjectEvalModule;
    },
    now: () => new Date(),
    randomSuffix: () => crypto.randomBytes(4).toString("hex"),
  };
}
