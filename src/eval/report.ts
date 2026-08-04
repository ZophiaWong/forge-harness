import fs from "node:fs/promises";
import path from "node:path";

import { parseEvalSuiteSummary } from "./schema.js";
import type {
  EvalModelMetrics,
  EvalSuiteSummary,
  RegressionReport,
} from "./types.js";

export interface WriteEvalArtifactsOptions {
  report: RegressionReport;
  runRoot: string;
  summary: EvalSuiteSummary;
}

export interface EvalArtifactPaths {
  markdownPath: string;
  reportPath: string;
  summaryPath: string;
}

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "apiKey",
  "argumentsText",
  "outputText",
  "prompt",
  "rawPrompt",
  "rawTrace",
  "task",
  "tracePayload",
]);

export function renderRegressionReportMarkdown(report: RegressionReport): string {
  const lines = [
    "# Forge Offline Eval Regression Report",
    "",
    `- Verdict: \`${report.verdict}\``,
    `- Candidate run: \`${report.candidateRunId}\``,
    `- Baseline run: ${report.baselineSourceRunId ? `\`${report.baselineSourceRunId}\`` : "none"}`,
    `- Compatibility: \`${report.compatibility.status}\``,
  ];

  if (report.compatibility.differences.length > 0) {
    lines.push(`- Identity differences: ${report.compatibility.differences.map((field) => `\`${field}\``).join(", ")}`);
  }

  lines.push("", "## Behavioral differences", "");
  if (report.diffs.length === 0) {
    lines.push("No comparable baseline counts are available.");
  } else {
    lines.push(
      "| Scenario | Contract | Baseline | Candidate | Delta |",
      "| --- | --- | ---: | ---: | ---: |",
      ...report.diffs.map((diff) => (
        `| ${diff.scenarioId} | ${diff.assertionId ?? "scenario pass"} | ${diff.baseline} | ${diff.candidate} | ${formatDelta(diff.delta)} |`
      )),
    );
  }

  lines.push("", "## Findings", "");
  if (report.findings.length === 0) {
    lines.push("No hard-invariant or infrastructure findings.");
  } else {
    lines.push(
      "| Scenario | Attempt | Kind | Contract / reason |",
      "| --- | --- | --- | --- |",
      ...report.findings.map((finding) => (
        `| ${finding.scenarioId} | ${finding.attemptId} | ${finding.kind} | ${finding.assertionId ?? finding.reasonCode ?? "unavailable"} |`
      )),
    );
  }

  lines.push(
    "",
    "## Model usage (non-blocking)",
    "",
    ...formatMetrics("Candidate", report.metrics.candidate),
  );
  if (report.metrics.baseline) {
    lines.push(...formatMetrics("Baseline", report.metrics.baseline));
  }
  lines.push("", "Token totals are informational and do not affect the verdict.", "");

  return lines.join("\n");
}

export function assertPublicEvalArtifact(value: unknown, keyPath = "artifact"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicEvalArtifact(item, `${keyPath}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) {
        throw new Error(`public eval artifact cannot contain ${key} at ${keyPath}`);
      }
      assertPublicEvalArtifact(child, `${keyPath}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && isUnsafePath(value)) {
    throw new Error(`public eval artifact contains an absolute or unsafe path at ${keyPath}`);
  }
}

export async function writeEvalArtifacts(options: WriteEvalArtifactsOptions): Promise<EvalArtifactPaths> {
  parseEvalSuiteSummary(options.summary);
  assertPublicEvalArtifact(options.summary);
  assertPublicEvalArtifact(options.report);
  const markdown = renderRegressionReportMarkdown(options.report);
  assertPublicEvalArtifact(markdown);
  await fs.mkdir(options.runRoot, { recursive: true });

  const paths: EvalArtifactPaths = {
    markdownPath: path.join(options.runRoot, "report.md"),
    reportPath: path.join(options.runRoot, "report.json"),
    summaryPath: path.join(options.runRoot, "summary.json"),
  };
  await Promise.all([
    fs.writeFile(paths.summaryPath, `${JSON.stringify(options.summary, null, 2)}\n`, "utf8"),
    fs.writeFile(paths.reportPath, `${JSON.stringify(options.report, null, 2)}\n`, "utf8"),
    fs.writeFile(paths.markdownPath, markdown, "utf8"),
  ]);
  return paths;
}

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

function formatMetrics(label: string, metrics: EvalModelMetrics): string[] {
  const totalCalls = metrics.callCount;
  const tokenTotals = metrics.tokens.totals;
  return [
    `### ${label}`,
    "",
    `- Model calls: ${totalCalls}`,
    `- Token coverage: \`${metrics.tokens.status}\` (${metrics.tokens.knownCalls}/${totalCalls} calls)`,
    `- Known token total: ${tokenTotals?.totalTokens ?? "unavailable"}`,
    `- Measured model duration: ${metrics.duration.totalMs} ms (${metrics.duration.knownCalls}/${totalCalls} calls)`,
    "",
  ];
}

function isUnsafePath(value: string): boolean {
  return path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.includes("../")
    || value.includes("..\\");
}
