import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertEvidenceRunMayStart,
  beginEvidenceCapture,
  prepareEvidenceIntent,
  promoteEvidenceIntent,
  readEvidenceIntent,
  recordEvidenceCaptureFailure,
  reserveEvidenceRun,
  sealRunEvidence,
  verifyPublishedEvidence,
  verifyRunEvidence,
  writeEvidenceIntent,
} from "../../src/runtime/evidenceBundle.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("release evidence bundle", () => {
  it("pre-registers a clean exact tag with subject and collector source identity", async () => {
    const repository = await createTaggedRepository();
    const commit = await git(repository, ["rev-parse", "HEAD"]);
    const tree = await git(repository, ["rev-parse", "HEAD^{tree}"]);

    const intent = await prepareEvidenceIntent({
      collectorRoot: repository,
      endpoint: "https://gateway.example/v1",
      mode: "observation",
      model: "gpt-5.4-mini",
      now: () => new Date("2026-08-28T01:02:03.000Z"),
      providerId: "my-gateway",
      randomSuffix: () => "abcd1234",
      ref: "v1.0.0",
      subjectRoot: repository,
    });

    expect(intent).toEqual({
      artifactType: "forge-evidence-intent",
      collector: { checkout: repository, clean: true, commit, tree },
      createdAt: "2026-08-28T01:02:03.000Z",
      environment: {
        endpointHash: "bdd462c5528f2d526905b7d1525bcc030f8f03593acbaf3ebe2c7879bb98a848",
        model: "gpt-5.4-mini",
        providerId: "my-gateway",
      },
      intentId: "v1.0.0-observation-20260828-010203-abcd1234",
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
        checkout: repository,
        clean: true,
        commit,
        ref: "v1.0.0",
        tree,
      },
    });
  });

  it("rejects a dirty subject or a checkout that is not at the requested tag", async () => {
    const dirty = await createTaggedRepository();
    await fs.writeFile(path.join(dirty, "source.txt"), "dirty source\n", "utf8");

    await expect(prepareEvidenceIntent({
      collectorRoot: dirty,
      endpoint: "https://gateway.example/v1",
      mode: "observation",
      model: "gpt-5.4-mini",
      providerId: "my-gateway",
      ref: "v1.0.0",
      subjectRoot: dirty,
    })).rejects.toThrow(/must be clean/);

    const moved = await createTaggedRepository();
    await fs.writeFile(path.join(moved, "second.txt"), "later source\n", "utf8");
    await git(moved, ["add", "second.txt"]);
    await git(moved, ["commit", "-qm", "later source"]);

    await expect(prepareEvidenceIntent({
      collectorRoot: moved,
      endpoint: "https://gateway.example/v1",
      mode: "observation",
      model: "gpt-5.4-mini",
      providerId: "my-gateway",
      ref: "v1.0.0",
      subjectRoot: moved,
    })).rejects.toThrow(/HEAD does not match tag/);
  });

  it("seals raw bytes behind a sanitized manifest and verifies every archived file", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const sourceAtStart = await beginEvidenceCapture(intent);
    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-raw-"));
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-output-"));
    tempRoots.push(rawRoot, outputRoot);
    await fs.mkdir(path.join(rawRoot, "session"), { recursive: true });
    await fs.writeFile(
      path.join(rawRoot, "session", "session.json"),
      "{\"prompt\":\"private prompt bytes\"}\n",
      "utf8",
    );
    await fs.writeFile(path.join(rawRoot, "session", "trace.jsonl"), "{\"type\":\"session_ended\"}\n", "utf8");
    const reportPath = path.join(rawRoot, "report.md");
    await fs.writeFile(reportPath, "# Sanitized report\n\n- Verdict: `PASS`\n", "utf8");

    const result = await sealRunEvidence({
      intent,
      now: () => new Date("2026-08-28T02:00:00.000Z"),
      outputRoot,
      publicArtifacts: [{ name: "report.md", path: reportPath }],
      rawSources: [{ prefix: "fixture", root: path.join(rawRoot, "session") }],
      run: {
        baselineEligible: false,
        behavior: { infrastructureInvalid: false, verdict: "PASS:verified_session_evidence" },
        completedAt: "2026-08-28T01:59:00.000Z",
        infrastructureInvalid: false,
        kind: "live",
        limitations: ["SHA-256 provides integrity, not signer identity."],
        promotionEligible: true,
        role: "live",
        runId: "live-001",
        startedAt: "2026-08-28T01:50:00.000Z",
      },
      sourceAtStart,
    });

    expect(result).toMatchObject({
      baselineEligible: false,
      behavioralVerdict: "PASS:verified_session_evidence",
      captureStatus: "sealed",
      infrastructureInvalid: false,
      promotionEligible: true,
      runId: "live-001",
    });
    const runRoot = path.join(outputRoot, "live-001");
    const manifestPath = path.join(runRoot, result.artifacts?.manifest ?? "missing");
    const archivePath = path.join(runRoot, result.artifacts?.archive ?? "missing");
    const inventoryPath = path.join(runRoot, result.artifacts?.inventory ?? "missing");
    const manifestText = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText) as {
      collector: { clean: boolean };
      environment: { endpointHash: string; model: string; providerId: string };
      subject: { clean: boolean; ref: string };
    };
    const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8")) as {
      files: Array<{ path: string; sha256: string; size: number }>;
    };

    expect(manifestText).not.toContain(repository);
    expect(manifestText).not.toContain(rawRoot);
    expect(manifestText).not.toContain("private prompt bytes");
    expect(manifest).toMatchObject({
      collector: { clean: true },
      environment: {
        endpointHash: "bdd462c5528f2d526905b7d1525bcc030f8f03593acbaf3ebe2c7879bb98a848",
        model: "gpt-5.4-mini",
        providerId: "my-gateway",
      },
      subject: { clean: true, ref: "v1.0.0" },
    });
    expect(inventory.files.map((file) => file.path)).toEqual([
      "fixture/session.json",
      "fixture/trace.jsonl",
    ]);
    await expect(verifyRunEvidence({ archivePath, manifestPath })).resolves.toEqual({
      fileCount: 2,
      runId: "live-001",
    });
    expect(await fs.readFile(path.join(runRoot, "public", "report.md"), "utf8"))
      .toBe("# Sanitized report\n\n- Verdict: `PASS`\n");
  });

  it("preserves the behavioral verdict but blocks promotion when source drifts", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const sourceAtStart = await beginEvidenceCapture(intent);
    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-drift-raw-"));
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-drift-output-"));
    tempRoots.push(rawRoot, outputRoot);
    await fs.writeFile(path.join(rawRoot, "trace.jsonl"), "{\"type\":\"session_ended\"}\n", "utf8");
    await fs.writeFile(path.join(repository, "source.txt"), "source changed during run\n", "utf8");

    const result = await sealRunEvidence({
      intent,
      outputRoot,
      rawSources: [{ prefix: "fixture", root: rawRoot }],
      run: {
        baselineEligible: false,
        behavior: { infrastructureInvalid: false, verdict: "FAIL:child_failed" },
        completedAt: "2026-08-28T01:59:00.000Z",
        infrastructureInvalid: false,
        kind: "live",
        limitations: [],
        promotionEligible: true,
        role: "live",
        runId: "live-drift",
        startedAt: "2026-08-28T01:50:00.000Z",
      },
      sourceAtStart,
    });

    expect(result).toMatchObject({
      behavioralVerdict: "FAIL:child_failed",
      captureStatus: "failed",
      promotionEligible: false,
      reasonCode: "source_drift",
    });
    await expect(fs.access(path.join(rawRoot, "trace.jsonl"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(outputRoot, "live-drift", "private", "live-drift.tgz")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["a symlink", "unsafe_raw_path", async (rawRoot: string) => {
      const external = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-external-"));
      tempRoots.push(external);
      await fs.writeFile(path.join(external, "trace.jsonl"), "external\n", "utf8");
      await fs.symlink(path.join(external, "trace.jsonl"), path.join(rawRoot, "trace.jsonl"));
    }],
    ["a credential file", "credential_file", async (rawRoot: string) => {
      await fs.writeFile(path.join(rawRoot, ".env"), "OPENAI_API_KEY=secret\n", "utf8");
    }],
  ])("rejects %s without deleting the source bytes", async (_label, reasonCode, arrange) => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const sourceAtStart = await beginEvidenceCapture(intent);
    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-unsafe-raw-"));
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-unsafe-output-"));
    tempRoots.push(rawRoot, outputRoot);
    await arrange(rawRoot);

    const result = await sealRunEvidence({
      intent,
      outputRoot,
      rawSources: [{ prefix: "fixture", root: rawRoot }],
      run: evidenceRun("unsafe-run"),
      sourceAtStart,
    });

    expect(result).toMatchObject({ captureStatus: "failed", promotionEligible: false, reasonCode });
    await expect(fs.access(rawRoot)).resolves.toBeUndefined();
  });

  it("rejects a public report carrying raw model output while retaining its raw source", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const sourceAtStart = await beginEvidenceCapture(intent);
    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-public-safety-"));
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-public-output-"));
    tempRoots.push(rawRoot, outputRoot);
    const reportPath = path.join(rawRoot, "report.json");
    await fs.writeFile(reportPath, '{"modelOutput":"private model text"}\n', "utf8");

    const result = await sealRunEvidence({
      intent,
      outputRoot,
      publicArtifacts: [{ name: "report.json", path: reportPath }],
      rawSources: [{ prefix: "operator", root: rawRoot }],
      run: evidenceRun("unsafe-public-run"),
      sourceAtStart,
    });

    expect(result).toMatchObject({
      behavioralVerdict: "PASS:verified_session_evidence",
      captureStatus: "failed",
      infrastructureInvalid: true,
      promotionEligible: false,
      reasonCode: "unsafe_public_artifact",
    });
    await expect(fs.access(reportPath)).resolves.toBeUndefined();
  });

  it("detects a damaged private archive before reading its inventory", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const sourceAtStart = await beginEvidenceCapture(intent);
    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-corrupt-raw-"));
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-corrupt-output-"));
    tempRoots.push(rawRoot, outputRoot);
    await fs.writeFile(path.join(rawRoot, "trace.jsonl"), "{\"type\":\"session_ended\"}\n", "utf8");
    const result = await sealRunEvidence({
      intent,
      outputRoot,
      rawSources: [{ prefix: "fixture", root: rawRoot }],
      run: evidenceRun("corrupt-run"),
      sourceAtStart,
    });
    const runRoot = path.join(outputRoot, "corrupt-run");
    const manifestPath = path.join(runRoot, result.artifacts?.manifest ?? "missing");
    const archivePath = path.join(runRoot, result.artifacts?.archive ?? "missing");
    await fs.appendFile(archivePath, "damaged", "utf8");

    await expect(verifyRunEvidence({ archivePath, manifestPath })).rejects.toThrow(/SHA-256 or size/);
  });

  it("rejects verification files reached through a symlinked ancestor", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const sourceAtStart = await beginEvidenceCapture(intent);
    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-link-raw-"));
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-link-output-"));
    tempRoots.push(rawRoot, outputRoot);
    await fs.writeFile(path.join(rawRoot, "trace.jsonl"), "{\"type\":\"session_ended\"}\n", "utf8");
    const result = await sealRunEvidence({
      intent,
      outputRoot,
      rawSources: [{ prefix: "fixture", root: rawRoot }],
      run: evidenceRun("linked-run"),
      sourceAtStart,
    });
    const runRoot = path.join(outputRoot, "linked-run");
    const linkedRoot = path.join(outputRoot, "linked-parent");
    await fs.symlink(runRoot, linkedRoot, "dir");

    await expect(verifyRunEvidence({
      archivePath: path.join(linkedRoot, result.artifacts?.archive ?? "missing"),
      manifestPath: path.join(linkedRoot, result.artifacts?.manifest ?? "missing"),
    })).rejects.toThrow(/physical file/);
  });

  it("writes an intent atomically and refuses to replace its preregistration", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);

    const results = await Promise.allSettled([
      writeEvidenceIntent(intent, undefined, repository),
      writeEvidenceIntent(intent, undefined, repository),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<string> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ message: expect.stringMatching(/already exists/) });
    await expect(readEvidenceIntent(fulfilled[0]?.value as string)).resolves.toEqual(intent);
  });

  it("atomically admits only one original reservation for a role", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const intentPath = await writeEvidenceIntent(intent, undefined, repository);

    const results = await Promise.allSettled([
      reserveEvidenceRun({
        intentPath,
        kind: "live",
        role: "live",
        runId: "live-concurrent-a",
        startedAt: "2026-08-28T02:00:00.000Z",
      }),
      reserveEvidenceRun({
        intentPath,
        kind: "live",
        role: "live",
        runId: "live-concurrent-b",
        startedAt: "2026-08-28T02:00:00.000Z",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("promotes a complete observation into public/private staging and verifies the round trip", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const intentPath = await writeEvidenceIntent(intent, undefined, repository);
    const intentRoot = path.dirname(intentPath);
    const runsRoot = path.join(intentRoot, "runs");
    const sourceAtStart = await beginEvidenceCapture(intent);
    const liveRaw = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-live-promotion-"));
    const evalRaw = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-eval-promotion-"));
    tempRoots.push(liveRaw, evalRaw);
    await fs.writeFile(path.join(liveRaw, "trace.jsonl"), "{\"type\":\"session_ended\"}\n", "utf8");
    await fs.writeFile(path.join(evalRaw, "summary.json"), "{\"valid\":true}\n", "utf8");

    const liveReleaseRun = evidenceRun("live-release");
    await reserveRun(intentPath, liveReleaseRun);
    await sealRunEvidence({
      intent,
      outputRoot: runsRoot,
      rawSources: [{ prefix: "live", root: liveRaw }],
      run: liveReleaseRun,
      sourceAtStart,
    });
    const observationRun = {
      baselineEligible: false,
      behavior: {
        attemptCount: 13,
        canonical: true,
        hardViolation: true,
        infrastructureInvalid: false,
        valid: true,
        verdict: "REGRESSED",
      },
      completedAt: "2026-08-28T02:59:00.000Z",
      infrastructureInvalid: false,
      kind: "eval" as const,
      limitations: [],
      promotionEligible: true,
      role: "observation" as const,
      runId: "eval-observation-release",
      startedAt: "2026-08-28T02:00:00.000Z",
    };
    await reserveRun(intentPath, observationRun);
    await sealRunEvidence({
      intent,
      outputRoot: runsRoot,
      rawSources: [{ prefix: "eval", root: evalRaw }],
      run: observationRun,
      sourceAtStart,
    });

    const promoted = await promoteEvidenceIntent({ intentPath });
    const releaseText = await fs.readFile(promoted.releaseManifestPath, "utf8");
    expect(releaseText).not.toContain(repository);
    expect(releaseText).not.toContain("session_ended");
    expect(promoted.runIds).toEqual(["eval-observation-release", "live-release"]);
    expect((await fs.readdir(promoted.publicRoot)).sort()).toEqual([
      "eval-observation-release-manifest.json",
      "live-release-manifest.json",
      "release-manifest.json",
    ]);
    const archivePaths = promoted.runIds.map((runId) => (
      path.join(promoted.privateRoot, `${runId}.tgz`)
    ));
    await expect(verifyPublishedEvidence({
      archivePaths,
      manifestPath: promoted.releaseManifestPath,
    })).resolves.toEqual({ runCount: 2 });
    const release = JSON.parse(releaseText) as {
      runs: Array<{ archive: { fileName: string }; role: string }>;
    };
    const incompleteManifestPath = path.join(promoted.publicRoot, "incomplete-release-manifest.json");
    const liveOnlyRelease = {
      ...release,
      runs: release.runs.filter((run) => run.role === "live"),
    };
    await fs.writeFile(
      incompleteManifestPath,
      `${JSON.stringify(liveOnlyRelease, null, 2)}\n`,
      "utf8",
    );
    await expect(verifyPublishedEvidence({
      archivePaths: [path.join(
        promoted.privateRoot,
        liveOnlyRelease.runs[0]?.archive.fileName ?? "missing.tgz",
      )],
      manifestPath: incompleteManifestPath,
    })).rejects.toThrow(/complete 13-attempt Eval run/);
    await expect(promoteEvidenceIntent({ intentPath })).rejects.toThrow(/already exists/);
    await fs.appendFile(
      path.join(promoted.privateRoot, "live-release-inventory.json"),
      "damaged",
      "utf8",
    );
    await expect(verifyPublishedEvidence({
      archivePaths,
      manifestPath: promoted.releaseManifestPath,
    })).rejects.toThrow(/private inventory.*SHA-256/);
  });

  it("allows only explicitly linked infrastructure retries and rejects behavioral resampling", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const intentPath = await writeEvidenceIntent(intent, undefined, repository);
    const runsRoot = path.join(path.dirname(intentPath), "runs");
    const sourceAtStart = await beginEvidenceCapture(intent);
    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-selection-"));
    tempRoots.push(rawRoot);
    await fs.writeFile(path.join(rawRoot, "trace.jsonl"), "{}\n", "utf8");
    const firstLiveRun = {
      ...evidenceRun("live-first"),
      behavior: { infrastructureInvalid: false, verdict: "FAIL:child_failed" },
    };
    await reserveRun(intentPath, firstLiveRun);
    await sealRunEvidence({
      intent,
      outputRoot: runsRoot,
      rawSources: [{ prefix: "live", root: rawRoot }],
      run: firstLiveRun,
      sourceAtStart,
    });

    await expect(assertEvidenceRunMayStart({
      intentPath,
      kind: "live",
      role: "live",
    })).rejects.toThrow(/already has a recorded run/);
    await expect(assertEvidenceRunMayStart({
      intentPath,
      kind: "live",
      retryOf: "live-first",
      role: "live",
    })).rejects.toThrow(/infrastructure-invalid/);

    const firstEvalRun = {
      baselineEligible: false,
      behavior: {
        attemptCount: 4,
        canonical: true,
        infrastructureInvalid: true,
        valid: false,
        verdict: "INVALID",
      },
      completedAt: "2026-08-28T03:00:00.000Z",
      infrastructureInvalid: true,
      kind: "eval" as const,
      limitations: [],
      promotionEligible: false,
      role: "observation" as const,
      runId: "eval-infra-first",
      startedAt: "2026-08-28T02:00:00.000Z",
    };
    await reserveRun(intentPath, firstEvalRun);
    await sealRunEvidence({
      intent,
      outputRoot: runsRoot,
      rawSources: [{ prefix: "eval", root: rawRoot }],
      run: firstEvalRun,
      sourceAtStart,
    });

    await expect(assertEvidenceRunMayStart({
      intentPath,
      kind: "eval",
      retryOf: "eval-infra-first",
      role: "observation",
    })).resolves.toMatchObject({ retryOf: "eval-infra-first" });
  });

  it("links an infrastructure retry across compatible intents after the collector advances", async () => {
    const subject = await createTaggedRepository();
    const collector = await createTaggedRepository();
    const firstIntent = await prepareEvidenceIntent({
      collectorRoot: collector,
      endpoint: "https://gateway.example/v1",
      mode: "observation",
      model: "gpt-5.4-mini",
      now: () => new Date("2026-08-28T01:00:00.000Z"),
      providerId: "my-gateway",
      randomSuffix: () => "firstint",
      ref: "v1.0.0",
      subjectRoot: subject,
    });
    const firstIntentPath = await writeEvidenceIntent(firstIntent, undefined, collector);
    const failedRun = evidenceRun("live-prior-collector-failure");
    await reserveRun(firstIntentPath, failedRun);
    await recordEvidenceCaptureFailure({
      intent: firstIntent,
      outputRoot: path.join(path.dirname(firstIntentPath), "runs"),
      reasonCode: "live_capture_failed",
      run: failedRun,
    });

    await fs.writeFile(path.join(collector, "collector-fix.txt"), "fixed\n", "utf8");
    await git(collector, ["add", "collector-fix.txt"]);
    await git(collector, ["commit", "-qm", "fix collector"]);
    const secondIntent = await prepareEvidenceIntent({
      collectorRoot: collector,
      endpoint: "https://gateway.example/v1",
      mode: "observation",
      model: "gpt-5.4-mini",
      now: () => new Date("2026-08-28T02:00:00.000Z"),
      providerId: "my-gateway",
      randomSuffix: () => "retryint",
      ref: "v1.0.0",
      subjectRoot: subject,
    });
    const secondIntentPath = await writeEvidenceIntent(secondIntent, undefined, collector);

    await expect(assertEvidenceRunMayStart({
      intentPath: secondIntentPath,
      kind: "live",
      retryOf: failedRun.runId,
      role: "live",
    })).resolves.toMatchObject({ retryOf: failedRun.runId });

    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-cross-intent-retry-"));
    tempRoots.push(rawRoot);
    await fs.writeFile(path.join(rawRoot, "evidence.json"), "{}\n", "utf8");
    const sourceAtStart = await beginEvidenceCapture(secondIntent);
    const retryRun = {
      ...evidenceRun("live-new-collector-retry"),
      retryOf: failedRun.runId,
    };
    await reserveRun(secondIntentPath, retryRun);
    await sealRunEvidence({
      intent: secondIntent,
      outputRoot: path.join(path.dirname(secondIntentPath), "runs"),
      rawSources: [{ prefix: "live", root: rawRoot }],
      run: retryRun,
      sourceAtStart,
    });
    const observationRun = {
      baselineEligible: false,
      behavior: {
        attemptCount: 13,
        canonical: true,
        hardViolation: false,
        infrastructureInvalid: false,
        valid: true,
        verdict: "NO_BASELINE",
      },
      completedAt: "2026-08-28T03:00:00.000Z",
      infrastructureInvalid: false,
      kind: "eval" as const,
      limitations: [],
      promotionEligible: true,
      role: "observation" as const,
      runId: "eval-new-collector-observation",
      startedAt: "2026-08-28T02:30:00.000Z",
    };
    await reserveRun(secondIntentPath, observationRun);
    await sealRunEvidence({
      intent: secondIntent,
      outputRoot: path.join(path.dirname(secondIntentPath), "runs"),
      rawSources: [{ prefix: "eval", root: rawRoot }],
      run: observationRun,
      sourceAtStart,
    });

    const promoted = await promoteEvidenceIntent({ intentPath: secondIntentPath });
    const release = JSON.parse(await fs.readFile(promoted.releaseManifestPath, "utf8")) as {
      collector: { commit: string };
      failedCaptures: Array<Record<string, unknown>>;
      runs: Array<{ retryOf?: string; runId: string }>;
    };
    expect(release.collector.commit).toBe(secondIntent.collector.commit);
    expect(release.failedCaptures).toEqual([expect.objectContaining({
      behavioralVerdict: "PASS:verified_session_evidence",
      collector: {
        clean: true,
        commit: firstIntent.collector.commit,
        tree: firstIntent.collector.tree,
      },
      infrastructureInvalid: true,
      intentId: firstIntent.intentId,
      reasonCode: "live_capture_failed",
      role: "live",
      runId: failedRun.runId,
    })]);
    expect(release.runs).toContainEqual(expect.objectContaining({
      retryOf: failedRun.runId,
      runId: retryRun.runId,
    }));
  });

  it("atomically admits only one cross-intent retry for an original run", async () => {
    const subject = await createTaggedRepository();
    const collector = await createTaggedRepository();
    const originalIntent = await prepareEvidenceIntent({
      collectorRoot: collector,
      endpoint: "https://gateway.example/v1",
      mode: "observation",
      model: "gpt-5.4-mini",
      now: () => new Date("2026-08-28T01:00:00.000Z"),
      providerId: "my-gateway",
      randomSuffix: () => "original",
      ref: "v1.0.0",
      subjectRoot: subject,
    });
    const originalIntentPath = await writeEvidenceIntent(originalIntent, undefined, collector);
    const originalRun = evidenceRun("live-global-retry-target");
    await reserveRun(originalIntentPath, originalRun);
    await recordEvidenceCaptureFailure({
      intent: originalIntent,
      outputRoot: path.join(path.dirname(originalIntentPath), "runs"),
      reasonCode: "live_capture_failed",
      run: originalRun,
    });

    await fs.writeFile(path.join(collector, "collector-fix.txt"), "fixed\n", "utf8");
    await git(collector, ["add", "collector-fix.txt"]);
    await git(collector, ["commit", "-qm", "fix collector"]);
    const retryIntents = await Promise.all([
      ["2026-08-28T02:00:00.000Z", "retryone"],
      ["2026-08-28T02:01:00.000Z", "retrytwo"],
    ].map(async ([createdAt, suffix]) => {
      const intent = await prepareEvidenceIntent({
        collectorRoot: collector,
        endpoint: "https://gateway.example/v1",
        mode: "observation",
        model: "gpt-5.4-mini",
        now: () => new Date(createdAt as string),
        providerId: "my-gateway",
        randomSuffix: () => suffix as string,
        ref: "v1.0.0",
        subjectRoot: subject,
      });
      return {
        intent,
        intentPath: await writeEvidenceIntent(intent, undefined, collector),
      };
    }));

    const reservations = await Promise.allSettled(retryIntents.map(
      ({ intentPath }, index) => reserveEvidenceRun({
        intentPath,
        kind: "live",
        retryOf: originalRun.runId,
        role: "live",
        runId: `live-concurrent-retry-${index + 1}`,
        startedAt: `2026-08-28T02:1${index}:00.000Z`,
      }),
    ));

    expect(reservations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(reservations.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("turns an orphaned preregistration into a linked failed capture before the only retry", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const intentPath = await writeEvidenceIntent(intent, undefined, repository);
    const intentRoot = path.dirname(intentPath);
    const orphanRunId = "live-orphaned-original";
    await reserveEvidenceRun({
      intentPath,
      kind: "live",
      role: "live",
      runId: orphanRunId,
      startedAt: "2026-08-28T02:00:00.000Z",
    });
    const orphanStaging = path.join(intentRoot, "staging", orphanRunId);
    await fs.mkdir(orphanStaging, { recursive: true });
    await fs.writeFile(path.join(orphanStaging, "partial-output.json"), "{}\n", "utf8");

    await expect(assertEvidenceRunMayStart({
      intentPath,
      kind: "live",
      role: "live",
    })).rejects.toThrow(/recorded run reservation/);
    const retry = await reserveEvidenceRun({
      intentPath,
      kind: "live",
      retryOf: orphanRunId,
      role: "live",
      runId: "live-only-retry",
      startedAt: "2026-08-28T02:10:00.000Z",
    });

    expect(retry.reservation.retryOf).toBe(orphanRunId);
    expect(JSON.parse(await fs.readFile(
      path.join(intentRoot, "runs", orphanRunId, "capture-result.json"),
      "utf8",
    ))).toMatchObject({
      behavioralVerdict: "UNKNOWN:capture_interrupted",
      captureStatus: "failed",
      infrastructureInvalid: true,
      reasonCode: "capture_interrupted",
    });
    await expect(fs.access(orphanStaging)).resolves.toBeUndefined();
    await expect(reserveEvidenceRun({
      intentPath,
      kind: "live",
      retryOf: "live-only-retry",
      role: "live",
      runId: "live-forbidden-third",
      startedAt: "2026-08-28T02:20:00.000Z",
    })).rejects.toThrow(/cannot itself be retried|one allowed retry/);
    await expect(promoteEvidenceIntent({ intentPath })).rejects.toThrow(/every preregistered/);
  });

  it("promotes an honestly blocked regression baseline and forbids a candidate", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository, "regression");
    const intentPath = await writeEvidenceIntent(intent, undefined, repository);
    const runsRoot = path.join(path.dirname(intentPath), "runs");
    const sourceAtStart = await beginEvidenceCapture(intent);
    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-blocked-baseline-"));
    tempRoots.push(rawRoot);
    await fs.writeFile(path.join(rawRoot, "evidence.json"), "{}\n", "utf8");

    const regressionLiveRun = evidenceRun("live-regression-release");
    await reserveRun(intentPath, regressionLiveRun);
    await sealRunEvidence({
      intent,
      outputRoot: runsRoot,
      rawSources: [{ prefix: "live", root: rawRoot }],
      run: regressionLiveRun,
      sourceAtStart,
    });
    const blockedBaselineRun = {
      baselineEligible: false,
      behavior: {
        attemptCount: 13,
        canonical: true,
        hardViolation: true,
        infrastructureInvalid: false,
        valid: false,
        verdict: "REGRESSED",
      },
      completedAt: "2026-08-28T03:00:00.000Z",
      infrastructureInvalid: false,
      kind: "eval" as const,
      limitations: [],
      promotionEligible: true,
      role: "baseline" as const,
      runId: "eval-blocked-baseline",
      startedAt: "2026-08-28T02:00:00.000Z",
    };
    await reserveRun(intentPath, blockedBaselineRun);
    await sealRunEvidence({
      intent,
      outputRoot: runsRoot,
      rawSources: [{ prefix: "eval", root: rawRoot }],
      run: blockedBaselineRun,
      sourceAtStart,
    });

    await expect(assertEvidenceRunMayStart({
      intentPath,
      kind: "eval",
      role: "candidate",
    })).rejects.toThrow(/promotion-eligible baseline/);
    await expect(promoteEvidenceIntent({ intentPath })).resolves.toMatchObject({
      runIds: ["eval-blocked-baseline", "live-regression-release"],
    });
  });

  it("publishes a failed capture record beside its explicitly linked sealed retry", async () => {
    const repository = await createTaggedRepository();
    const intent = await prepareIntent(repository);
    const intentPath = await writeEvidenceIntent(intent, undefined, repository);
    const runsRoot = path.join(path.dirname(intentPath), "runs");
    const sourceAtStart = await beginEvidenceCapture(intent);
    const rawRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-failed-retry-"));
    tempRoots.push(rawRoot);
    await fs.writeFile(path.join(rawRoot, "evidence.json"), "{}\n", "utf8");

    const failedRun = evidenceRun("live-capture-failed");
    await reserveRun(intentPath, failedRun);
    const failed = await recordEvidenceCaptureFailure({
      intent,
      outputRoot: runsRoot,
      reasonCode: "capture_failed",
      run: failedRun,
    });
    await expect(assertEvidenceRunMayStart({
      intentPath,
      kind: "live",
      retryOf: failed.runId,
      role: "live",
    })).resolves.toMatchObject({ retryOf: failed.runId });
    const retryRun = { ...evidenceRun("live-capture-retry"), retryOf: failed.runId };
    await reserveRun(intentPath, retryRun);
    await sealRunEvidence({
      intent,
      outputRoot: runsRoot,
      rawSources: [{ prefix: "live", root: rawRoot }],
      run: retryRun,
      sourceAtStart,
    });
    const observationRun = {
      baselineEligible: false,
      behavior: {
        attemptCount: 13,
        canonical: true,
        hardViolation: false,
        infrastructureInvalid: false,
        valid: true,
        verdict: "NO_BASELINE",
      },
      completedAt: "2026-08-28T03:00:00.000Z",
      infrastructureInvalid: false,
      kind: "eval" as const,
      limitations: [],
      promotionEligible: true,
      role: "observation" as const,
      runId: "eval-after-live-retry",
      startedAt: "2026-08-28T02:00:00.000Z",
    };
    await reserveRun(intentPath, observationRun);
    await sealRunEvidence({
      intent,
      outputRoot: runsRoot,
      rawSources: [{ prefix: "eval", root: rawRoot }],
      run: observationRun,
      sourceAtStart,
    });

    const promoted = await promoteEvidenceIntent({ intentPath });
    const release = JSON.parse(await fs.readFile(promoted.releaseManifestPath, "utf8")) as {
      failedCaptures: Array<Record<string, unknown>>;
      runs: Array<{ retryOf?: string; runId: string }>;
    };
    expect(release.failedCaptures).toEqual([expect.objectContaining({
      behavioralVerdict: "PASS:verified_session_evidence",
      reasonCode: "capture_failed",
      runId: failed.runId,
    })]);
    expect(release.runs).toContainEqual(expect.objectContaining({
      retryOf: failed.runId,
      runId: "live-capture-retry",
    }));
  });
});

function evidenceRun(runId: string) {
  return {
    baselineEligible: false,
    behavior: { infrastructureInvalid: false, verdict: "PASS:verified_session_evidence" },
    completedAt: "2026-08-28T01:59:00.000Z",
    infrastructureInvalid: false,
    kind: "live" as const,
    limitations: [],
    promotionEligible: true,
    role: "live" as const,
    runId,
    startedAt: "2026-08-28T01:50:00.000Z",
  };
}

async function reserveRun(
  intentPath: string,
  run: {
    kind: "eval" | "live";
    retryOf?: string;
    role: "baseline" | "candidate" | "live" | "observation";
    runId: string;
    startedAt: string;
  },
): Promise<void> {
  await reserveEvidenceRun({
    intentPath,
    kind: run.kind,
    ...(run.retryOf ? { retryOf: run.retryOf } : {}),
    role: run.role,
    runId: run.runId,
    startedAt: run.startedAt,
  });
}

async function prepareIntent(
  repository: string,
  mode: "observation" | "regression" = "observation",
) {
  return prepareEvidenceIntent({
    collectorRoot: repository,
    endpoint: "https://gateway.example/v1",
    mode,
    model: "gpt-5.4-mini",
    now: () => new Date("2026-08-28T01:02:03.000Z"),
    providerId: "my-gateway",
    randomSuffix: () => "abcd1234",
    ref: "v1.0.0",
    subjectRoot: repository,
  });
}

async function createTaggedRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-evidence-source-"));
  tempRoots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Forge Evidence Test"]);
  await git(root, ["config", "user.email", "evidence@example.invalid"]);
  await fs.writeFile(path.join(root, ".gitignore"), ".forge/\n", "utf8");
  await fs.writeFile(path.join(root, "source.txt"), "subject source\n", "utf8");
  await git(root, ["add", ".gitignore", "source.txt"]);
  await git(root, ["commit", "-qm", "subject source"]);
  await git(root, ["tag", "v1.0.0"]);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}
