import { describe, expect, it, vi } from "vitest";

import {
  parseEvidenceCliArgs,
  runEvidenceCli,
  type EvidenceCliDependencies,
} from "../../src/cli/evidence.js";
import type { EvidenceIntent } from "../../src/runtime/evidenceBundle.js";

describe("release evidence CLI", () => {
  it("parses prepare, live, eval, promote, and multi-archive verify commands strictly", () => {
    expect(parseEvidenceCliArgs([
      "prepare",
      "--subject",
      "/subject",
      "--ref",
      "v1.0.0",
      "--mode",
      "observation",
    ])).toEqual({ command: "prepare", mode: "observation", ref: "v1.0.0", subject: "/subject" });
    expect(parseEvidenceCliArgs(["live", "--intent", "intent.json"]))
      .toEqual({ command: "live", intent: "intent.json" });
    expect(parseEvidenceCliArgs([
      "eval",
      "--intent",
      "intent.json",
      "--role",
      "candidate",
      "--baseline",
      "baseline.json",
    ])).toEqual({
      baseline: "baseline.json",
      command: "eval",
      intent: "intent.json",
      role: "candidate",
    });
    expect(parseEvidenceCliArgs(["promote", "--intent", "intent.json"]))
      .toEqual({ command: "promote", intent: "intent.json" });
    expect(parseEvidenceCliArgs([
      "verify",
      "--manifest",
      "manifest.json",
      "--archive",
      "live.tgz",
      "--archive",
      "eval.tgz",
    ])).toEqual({
      archives: ["live.tgz", "eval.tgz"],
      command: "verify",
      manifest: "manifest.json",
    });
    expect(() => parseEvidenceCliArgs([
      "eval",
      "--intent",
      "intent.json",
      "--role",
      "candidate",
    ])).toThrow(/candidate.*--baseline/);
    expect(() => parseEvidenceCliArgs(["live", "--intent", "a", "--wat"]))
      .toThrow(/unknown option/);
  });

  it("prepares an intent from environment-backed model identity and writes the returned path", async () => {
    const intent = fakeIntent();
    const prepareIntent = vi.fn(async () => intent);
    const writeIntent = vi.fn(async () => "/repo/.forge/evidence/intent/intent.json");
    const log = vi.fn();

    const exitCode = await runEvidenceCli([
      "prepare",
      "--subject",
      "subject",
      "--ref",
      "v1.0.0",
      "--mode",
      "observation",
    ], dependencies({ log, prepareIntent, writeIntent }));

    expect(exitCode).toBe(0);
    expect(prepareIntent).toHaveBeenCalledWith(expect.objectContaining({
      collectorRoot: "/repo",
      endpoint: "https://gateway.example/v1",
      mode: "observation",
      model: "gpt-5.4-mini",
      providerId: "my-gateway",
      ref: "v1.0.0",
      subjectRoot: "/repo/subject",
    }));
    expect(writeIntent).toHaveBeenCalledWith(intent, undefined, "/repo");
    expect(log).toHaveBeenCalledWith("Evidence intent: .forge/evidence/intent/intent.json");
  });

  it("dispatches live, eval, promote, and verify with repository-relative paths", async () => {
    const log = vi.fn();
    const runLive = vi.fn(async () => ({ capture: fakeCapture("live", "live"), exitCode: 1 as const }));
    const runEval = vi.fn(async () => ({ capture: fakeCapture("eval", "candidate"), exitCode: 0 as const }));
    const promote = vi.fn(async () => ({ releaseManifestPath: "/repo/promotion/public/release-manifest.json" }));
    const verify = vi.fn(async () => ({ runCount: 2 }));
    const deps = dependencies({ log, promote, runEval, runLive, verify });

    await expect(runEvidenceCli(["live", "--intent", "intent.json"], deps)).resolves.toBe(1);
    await expect(runEvidenceCli([
      "eval",
      "--intent",
      "intent.json",
      "--role",
      "candidate",
      "--baseline",
      "baseline.json",
    ], deps)).resolves.toBe(0);
    await expect(runEvidenceCli(["promote", "--intent", "intent.json"], deps)).resolves.toBe(0);
    await expect(runEvidenceCli([
      "verify",
      "--manifest",
      "promotion/public/release-manifest.json",
      "--archive",
      "promotion/private/live.tgz",
      "--archive",
      "promotion/private/eval.tgz",
    ], deps)).resolves.toBe(0);

    expect(runLive).toHaveBeenCalledWith({ intentPath: "/repo/intent.json" });
    expect(runEval).toHaveBeenCalledWith({
      baselinePath: "/repo/baseline.json",
      intentPath: "/repo/intent.json",
      role: "candidate",
    });
    expect(promote).toHaveBeenCalledWith({ intentPath: "/repo/intent.json" });
    expect(verify).toHaveBeenCalledWith({
      archivePaths: ["/repo/promotion/private/live.tgz", "/repo/promotion/private/eval.tgz"],
      manifestPath: "/repo/promotion/public/release-manifest.json",
    });
    expect(log).toHaveBeenCalledWith("Verified 2 evidence run(s).");
  });
});

function fakeCapture(kind: "eval" | "live", role: "candidate" | "live") {
  return {
    artifactType: "forge-evidence-capture-result" as const,
    baselineEligible: false,
    behavioralVerdict: kind === "live" ? "FAIL:child_failed" : "UNCHANGED",
    captureStatus: "sealed" as const,
    infrastructureInvalid: false,
    intentId: "intent",
    kind,
    promotionEligible: true,
    role,
    runId: `${kind}-run`,
    schemaVersion: 1 as const,
  };
}

function dependencies(
  overrides: Partial<EvidenceCliDependencies> = {},
): EvidenceCliDependencies {
  return {
    env: {
      EVIDENCE_MODEL: "gpt-5.4-mini",
      EVIDENCE_PROVIDER_ID: "my-gateway",
      OPENAI_BASE_URL: "https://gateway.example/v1",
    },
    error: vi.fn(),
    log: vi.fn(),
    prepareIntent: vi.fn(),
    promote: vi.fn(),
    repositoryRoot: "/repo",
    runEval: vi.fn(),
    runLive: vi.fn(),
    verify: vi.fn(),
    writeIntent: vi.fn(),
    ...overrides,
  };
}

function fakeIntent(): EvidenceIntent {
  return {
    artifactType: "forge-evidence-intent",
    collector: { checkout: "/repo", clean: true, commit: "collector", tree: "collector-tree" },
    createdAt: "2026-08-28T01:00:00.000Z",
    environment: {
      endpointHash: "endpoint",
      model: "gpt-5.4-mini",
      providerId: "my-gateway",
    },
    intentId: "intent",
    mode: "observation",
    schemaVersion: 1,
    selectionPolicy: {
      evalAttemptsPerBatch: 13,
      evalBatchLimit: 1,
      keepEveryRun: true,
      retry: "infrastructure-invalid-only",
      selection: "first-preregistered-run",
    },
    subject: {
      checkout: "/repo/subject",
      clean: true,
      commit: "subject",
      ref: "v1.0.0",
      tree: "subject-tree",
    },
  };
}
