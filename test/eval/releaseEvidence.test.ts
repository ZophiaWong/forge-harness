import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertEvalEvidenceRefsClosed } from "../../src/eval/evidence.js";
import type { EvalSuiteSummary } from "../../src/eval/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("eval release evidence", () => {
  it("closes every attempt and assertion reference inside the run root", async () => {
    const runRoot = await createRunRoot();
    const summary = evalSummary();

    await expect(assertEvalEvidenceRefsClosed(runRoot, summary)).resolves.toEqual([
      "attempts/example/1/grade.json",
      "attempts/example/1/root-trace.jsonl",
    ]);
  });

  it("rejects missing, escaping, and symlinked evidence references", async () => {
    const missingRoot = await createRunRoot();
    await fs.rm(path.join(missingRoot, "attempts", "example", "1", "root-trace.jsonl"));
    await expect(assertEvalEvidenceRefsClosed(missingRoot, evalSummary()))
      .rejects.toThrow(/does not exist/);

    const escapingRoot = await createRunRoot();
    const escaping = evalSummary();
    escaping.attempts[0].evidenceRefs = ["../outside.json"];
    await expect(assertEvalEvidenceRefsClosed(escapingRoot, escaping))
      .rejects.toThrow(/safe relative/);

    const symlinkRoot = await createRunRoot();
    const external = path.join(symlinkRoot, "external.jsonl");
    await fs.writeFile(external, "external\n", "utf8");
    const tracePath = path.join(symlinkRoot, "attempts", "example", "1", "root-trace.jsonl");
    await fs.rm(tracePath);
    await fs.symlink(external, tracePath);
    await expect(assertEvalEvidenceRefsClosed(symlinkRoot, evalSummary()))
      .rejects.toThrow(/symlink/);
  });
});

async function createRunRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-release-"));
  tempRoots.push(root);
  const attemptRoot = path.join(root, "attempts", "example", "1");
  await fs.mkdir(attemptRoot, { recursive: true });
  await fs.writeFile(path.join(attemptRoot, "grade.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(attemptRoot, "root-trace.jsonl"), "{\"sequence\":1}\n", "utf8");
  return root;
}

function evalSummary(): EvalSuiteSummary {
  const metrics = {
    callCount: 1,
    duration: { knownCalls: 1, status: "complete" as const, totalMs: 1 },
    tokens: {
      knownCalls: 1,
      status: "complete" as const,
      totals: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  };
  return {
    aggregates: [{ assertionPassCounts: { contract: 1 }, attemptCount: 1, passCount: 1, scenarioId: "example" }],
    artifactType: "forge-eval-suite-summary",
    attempts: [{
      assertions: [{
        evidenceRefs: [
          "attempts/example/1/grade.json",
          "attempts/example/1/root-trace.jsonl",
        ],
        id: "contract",
        kind: "outcome",
        status: "passed",
      }],
      attemptId: "example-1",
      evidenceRefs: [
        "attempts/example/1/grade.json",
        "attempts/example/1/root-trace.jsonl",
      ],
      execution: { status: "completed" },
      metrics,
      ordinal: 1,
      outcome: "passed",
      scenarioId: "example",
    }],
    canonical: false,
    diagnostics: { commit: "abc123" },
    generatedAt: "2026-08-28T01:00:00.000Z",
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
    runId: "run-001",
    schemaVersion: 1,
    scope: "scenario",
    valid: true,
  };
}
