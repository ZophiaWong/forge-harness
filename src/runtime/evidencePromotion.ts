import fs from "node:fs/promises";
import path from "node:path";

import { verifyRunEvidence } from "./evidenceCapture.js";
import {
  beginEvidenceCapture,
  readEvidenceIntent,
} from "./evidenceIntent.js";
import {
  assertEvidenceLedgerClosed,
  readEvidenceCaptureResults,
  readExternalRetryTargets,
} from "./evidenceRunLedger.js";
import { parseEvidenceReleaseManifest } from "./evidenceReleaseSchema.js";
import {
  assertCaptureMatchesManifest,
  assertPublicEvidenceManifest,
  parsePrivateEvidenceInventory,
  parseRunEvidenceManifest,
} from "./evidenceRunSchema.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceCaptureResult,
  type EvidenceIntent,
  type EvidenceReleaseManifest,
  type PromoteEvidenceIntentOptions,
  type PromoteEvidenceIntentResult,
  type RunEvidenceManifest,
} from "./evidenceTypes.js";
import {
  SHARED_EVIDENCE_LIMITATIONS,
  assertPhysicalFile,
  assertPublicArtifact,
  isRecord,
  pathExists,
  readTarEntry,
  requireArchiveSet,
  resolveInside,
  sha256,
  sha256File,
} from "./evidenceSafety.js";

export async function promoteEvidenceIntent(
  options: PromoteEvidenceIntentOptions,
): Promise<PromoteEvidenceIntentResult> {
  const intentPath = path.resolve(options.intentPath);
  const intent = await readEvidenceIntent(intentPath);
  await beginEvidenceCapture(intent);
  const intentRoot = path.dirname(intentPath);
  const runsRoot = path.join(intentRoot, "runs");
  const captures = await readEvidenceCaptureResults(intentPath);
  await assertEvidenceLedgerClosed(intentPath, captures);
  const externalRetryTargets = await readExternalRetryTargets(intentPath, captures);

  const sealedRuns: Array<{
    archivePath: string;
    capture: EvidenceCaptureResult & { artifacts: NonNullable<EvidenceCaptureResult["artifacts"]> };
    inventoryPath: string;
    manifest: RunEvidenceManifest;
    manifestPath: string;
    reports: string[];
  }> = [];
  const failedCaptures: EvidenceReleaseManifest["failedCaptures"] = [];

  for (const target of externalRetryTargets) {
    failedCaptures.push(toFailedReleaseCapture(target.capture, target.intent));
  }

  for (const capture of captures.sort((left, right) => left.runId.localeCompare(right.runId))) {
    const runRoot = path.join(runsRoot, capture.runId);
    if (capture.intentId !== intent.intentId) {
      throw new Error(`evidence capture ${capture.runId} does not match its intent`);
    }
    if (capture.captureStatus !== "sealed" || !capture.artifacts) {
      failedCaptures.push(toFailedReleaseCapture(capture, intent));
      continue;
    }
    const artifacts = capture.artifacts;
    const manifestPath = resolveInside(runRoot, artifacts.manifest, "capture manifest");
    const archivePath = resolveInside(runRoot, artifacts.archive, "capture archive");
    const inventoryPath = resolveInside(runRoot, artifacts.inventory, "capture inventory");
    const reports = artifacts.reports.map((report) => (
      resolveInside(runRoot, report, "capture report")
    ));
    await verifyRunEvidence({ archivePath, manifestPath });
    await assertPhysicalFile(inventoryPath, "capture private inventory");
    const manifest = parseRunEvidenceManifest(
      JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown,
    );
    assertCaptureMatchesManifest(capture, manifest, intent);
    sealedRuns.push({
      archivePath,
      capture: capture as typeof sealedRuns[number]["capture"],
      inventoryPath,
      manifest,
      manifestPath,
      reports,
    });
  }

  failedCaptures.sort((left, right) => left.runId.localeCompare(right.runId));

  validatePromotionSelection(intent, sealedRuns.map((run) => run.manifest));
  const outputRoot = path.resolve(options.outputRoot ?? path.join(intentRoot, "promotion"));
  if (await pathExists(outputRoot)) {
    throw new Error(`evidence promotion already exists at ${outputRoot}`);
  }
  await fs.mkdir(path.dirname(outputRoot), { recursive: true });
  const temporaryRoot = await fs.mkdtemp(
    path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}.`),
  );
  try {
    const publicRoot = path.join(temporaryRoot, "public");
    const privateRoot = path.join(temporaryRoot, "private");
    await Promise.all([
      fs.mkdir(publicRoot, { recursive: true }),
      fs.mkdir(privateRoot, { recursive: true }),
    ]);
    const releaseRuns: EvidenceReleaseManifest["runs"] = [];
    for (const run of sealedRuns) {
      const promotedReports: RunEvidenceManifest["reports"] = [];
      const reportSources = new Map(run.reports.map((report) => [path.basename(report), report]));
      for (const report of run.manifest.reports) {
        const source = reportSources.get(report.fileName);
        if (!source) {
          throw new Error(`capture report ${report.fileName} is missing during promotion`);
        }
        const promotedName = `${run.manifest.runId}-${report.fileName}`;
        await fs.copyFile(source, path.join(publicRoot, promotedName));
        promotedReports.push({ ...report, fileName: promotedName });
      }
      const promotedManifest: RunEvidenceManifest = { ...run.manifest, reports: promotedReports };
      assertPublicEvidenceManifest(promotedManifest);
      const promotedManifestName = `${run.manifest.runId}-manifest.json`;
      const promotedManifestPath = path.join(publicRoot, promotedManifestName);
      await fs.writeFile(
        promotedManifestPath,
        `${JSON.stringify(promotedManifest, null, 2)}\n`,
        "utf8",
      );
      await fs.copyFile(run.archivePath, path.join(privateRoot, run.manifest.archive.fileName));
      const promotedInventoryName = `${run.manifest.runId}-inventory.json`;
      const promotedInventoryPath = path.join(privateRoot, promotedInventoryName);
      await fs.copyFile(run.inventoryPath, promotedInventoryPath);
      const promotedManifestStat = await fs.stat(promotedManifestPath);
      const promotedInventoryStat = await fs.stat(promotedInventoryPath);
      releaseRuns.push({
        archive: run.manifest.archive,
        baselineEligible: run.manifest.baselineEligible,
        inventory: {
          fileName: promotedInventoryName,
          sha256: await sha256File(promotedInventoryPath),
          size: promotedInventoryStat.size,
        },
        manifest: {
          path: promotedManifestName,
          sha256: await sha256File(promotedManifestPath),
          size: promotedManifestStat.size,
        },
        promotionEligible: run.manifest.promotionEligible,
        ...(run.manifest.retryOf ? { retryOf: run.manifest.retryOf } : {}),
        role: run.manifest.role,
        runId: run.manifest.runId,
      });
    }
    const { checkout: _collectorCheckout, ...collector } = intent.collector;
    const { checkout: _subjectCheckout, ...subject } = intent.subject;
    const releaseManifest: EvidenceReleaseManifest = {
      artifactType: "forge-release-evidence-manifest",
      collector,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      environment: intent.environment,
      failedCaptures,
      intentCreatedAt: intent.createdAt,
      intentId: intent.intentId,
      limitations: [
        ...SHARED_EVIDENCE_LIMITATIONS,
        "Private raw archives require maintainer-controlled storage.",
      ],
      mode: intent.mode,
      runs: releaseRuns,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      selectionPolicy: intent.selectionPolicy,
      subject,
    };
    assertPublicArtifact(releaseManifest, "releaseManifest");
    const releaseManifestPath = path.join(publicRoot, "release-manifest.json");
    await fs.writeFile(
      releaseManifestPath,
      `${JSON.stringify(releaseManifest, null, 2)}\n`,
      "utf8",
    );
    await verifyPublishedEvidence({
      archivePaths: releaseRuns.map((run) => path.join(privateRoot, run.archive.fileName)),
      manifestPath: releaseManifestPath,
    });
    const sourceAfterPromotion = await beginEvidenceCapture(intent);
    assertGitIdentity(
      sourceAfterPromotion.subject,
      intent.subject,
      "subject source drifted during evidence promotion",
    );
    assertGitIdentity(
      sourceAfterPromotion.collector,
      intent.collector,
      "collector source drifted during evidence promotion",
    );
    await fs.rename(temporaryRoot, outputRoot);
    return {
      privateRoot: path.join(outputRoot, "private"),
      publicRoot: path.join(outputRoot, "public"),
      releaseManifestPath: path.join(outputRoot, "public", "release-manifest.json"),
      runIds: releaseRuns.map((run) => run.runId),
    };
  } catch (error) {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
}

function toFailedReleaseCapture(
  capture: EvidenceCaptureResult,
  intent: EvidenceIntent,
): EvidenceReleaseManifest["failedCaptures"][number] {
  if (capture.captureStatus !== "failed"
    || !capture.infrastructureInvalid
    || !capture.reasonCode) {
    throw new Error(`evidence capture ${capture.runId} is not a failed infrastructure capture`);
  }
  const { checkout: _collectorCheckout, ...collector } = intent.collector;
  return {
    behavioralVerdict: capture.behavioralVerdict,
    collector,
    infrastructureInvalid: true,
    intentId: intent.intentId,
    reasonCode: capture.reasonCode,
    ...(capture.retryOf ? { retryOf: capture.retryOf } : {}),
    role: capture.role,
    runId: capture.runId,
  };
}

export async function verifyPublishedEvidence(options: {
  archivePaths: string[];
  manifestPath: string;
}): Promise<{ runCount: number }> {
  const manifestPath = path.resolve(options.manifestPath);
  await assertPhysicalFile(manifestPath, "published evidence manifest");
  const value = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
  if (isRecord(value) && value.artifactType === "forge-run-evidence-manifest") {
    const manifest = parseRunEvidenceManifest(value);
    const archive = requireArchiveSet(options.archivePaths, [manifest.archive.fileName]).get(
      manifest.archive.fileName,
    ) as string;
    await verifyRunEvidence({ archivePath: archive, manifestPath });
    return { runCount: 1 };
  }

  const release = parseEvidenceReleaseManifest(value);
  const archives = requireArchiveSet(
    options.archivePaths,
    release.runs.map((run) => run.archive.fileName),
  );
  const publicRoot = path.dirname(manifestPath);
  const runManifests: RunEvidenceManifest[] = [];
  for (const run of release.runs) {
    const archivePath = archives.get(run.archive.fileName) as string;
    const inventoryPath = path.join(path.dirname(archivePath), run.inventory.fileName);
    await assertPhysicalFile(inventoryPath, `private inventory ${run.runId}`);
    const inventoryStats = await fs.stat(inventoryPath);
    const inventoryBytes = await fs.readFile(inventoryPath);
    if (inventoryStats.size !== run.inventory.size
      || sha256(inventoryBytes) !== run.inventory.sha256) {
      throw new Error(`private inventory ${run.runId} failed SHA-256 verification`);
    }
    const archivedInventoryBytes = await readTarEntry(archivePath, "./inventory.json");
    if (!inventoryBytes.equals(archivedInventoryBytes)) {
      throw new Error(`private inventory ${run.runId} does not match its archive`);
    }
    const inventory = parsePrivateEvidenceInventory(
      JSON.parse(inventoryBytes.toString("utf8")) as unknown,
    );
    if (inventory.intentId !== release.intentId || inventory.runId !== run.runId) {
      throw new Error(`private inventory ${run.runId} does not match the release identity`);
    }
    const runManifestPath = resolveInside(publicRoot, run.manifest.path, "release run manifest");
    await assertPhysicalFile(runManifestPath, `release run manifest ${run.runId}`);
    const stats = await fs.stat(runManifestPath);
    if (stats.size !== run.manifest.size
      || await sha256File(runManifestPath) !== run.manifest.sha256) {
      throw new Error(`release run manifest ${run.runId} failed SHA-256 verification`);
    }
    const runManifest = parseRunEvidenceManifest(
      JSON.parse(await fs.readFile(runManifestPath, "utf8")) as unknown,
    );
    if (runManifest.runId !== run.runId
      || runManifest.archive.fileName !== run.archive.fileName
      || runManifest.archive.sha256 !== run.archive.sha256
      || runManifest.archive.size !== run.archive.size
      || runManifest.role !== run.role
      || runManifest.baselineEligible !== run.baselineEligible
      || runManifest.promotionEligible !== run.promotionEligible
      || runManifest.retryOf !== run.retryOf
      || runManifest.intentId !== release.intentId
      || runManifest.mode !== release.mode
      || runManifest.subject.commit !== release.subject.commit
      || runManifest.subject.tree !== release.subject.tree
      || runManifest.subject.ref !== release.subject.ref
      || runManifest.collector.commit !== release.collector.commit
      || runManifest.collector.tree !== release.collector.tree
      || runManifest.environment.endpointHash !== release.environment.endpointHash
      || runManifest.environment.model !== release.environment.model
      || runManifest.environment.providerId !== release.environment.providerId) {
      throw new Error(`release run ${run.runId} does not match its manifest`);
    }
    await verifyRunEvidence({ archivePath, manifestPath: runManifestPath });
    runManifests.push(runManifest);
  }
  validatePublishedRetryEligibility(release, runManifests);
  validatePromotionSelection(release, runManifests);
  return { runCount: release.runs.length };
}

function validatePublishedRetryEligibility(
  release: EvidenceReleaseManifest,
  manifests: RunEvidenceManifest[],
): void {
  const manifestsById = new Map(manifests.map((manifest) => [manifest.runId, manifest]));
  const failedIds = new Set(release.failedCaptures.map((capture) => capture.runId));
  for (const entry of [...release.runs, ...release.failedCaptures]) {
    if (!entry.retryOf || failedIds.has(entry.retryOf)) {
      continue;
    }
    const original = manifestsById.get(entry.retryOf);
    if (!original
      || !original.behavior.infrastructureInvalid
      || original.promotionEligible) {
      throw new Error("published evidence retry target is not infrastructure-invalid");
    }
  }
}

export function validatePromotionSelection(
  intent: Pick<EvidenceIntent, "mode" | "selectionPolicy">,
  manifests: RunEvidenceManifest[],
): void {
  const eligibleLive = manifests.filter((manifest) => (
    manifest.kind === "live" && manifest.role === "live" && manifest.promotionEligible
  ));
  if (eligibleLive.length !== 1) {
    throw new Error("evidence promotion requires exactly one promotion-eligible Live run");
  }
  if (intent.mode === "observation") {
    const eligibleObservation = manifests.filter((manifest) => (
      manifest.kind === "eval"
      && manifest.role === "observation"
      && manifest.promotionEligible
      && manifest.behavior.canonical === true
      && manifest.behavior.attemptCount === intent.selectionPolicy.evalAttemptsPerBatch
      && manifest.behavior.infrastructureInvalid !== true
    ));
    if (eligibleObservation.length !== 1) {
      throw new Error("observation evidence promotion requires exactly one complete 13-attempt Eval run");
    }
    if (manifests.some((manifest) => manifest.role === "baseline" || manifest.role === "candidate")) {
      throw new Error("observation evidence cannot promote baseline or candidate runs");
    }
    return;
  }

  const baselines = manifests.filter((manifest) => (
    manifest.kind === "eval" && manifest.role === "baseline" && manifest.promotionEligible
  ));
  if (baselines.length !== 1) {
    throw new Error("regression evidence promotion requires exactly one completed baseline sample");
  }
  const baseline = baselines[0] as RunEvidenceManifest;
  if (baseline.behavior.canonical !== true
    || baseline.behavior.attemptCount !== intent.selectionPolicy.evalAttemptsPerBatch
    || baseline.behavior.infrastructureInvalid) {
    throw new Error("regression evidence promotion requires one complete 13-attempt baseline sample");
  }
  if (baseline.baselineEligible
    && (baseline.behavior.valid !== true || baseline.behavior.hardViolation === true)) {
    throw new Error("baseline eligibility requires one complete valid 13-attempt Eval run");
  }
  const candidates = manifests.filter((manifest) => (
    manifest.kind === "eval" && manifest.role === "candidate" && manifest.promotionEligible
  ));
  if (baseline.baselineEligible) {
    if (candidates.length !== 1) {
      throw new Error("an eligible baseline requires exactly one independent candidate run");
    }
    const candidate = candidates[0] as RunEvidenceManifest;
    if (candidate.behavior.canonical !== true
      || candidate.behavior.attemptCount !== intent.selectionPolicy.evalAttemptsPerBatch
      || candidate.behavior.infrastructureInvalid) {
      throw new Error("candidate evidence promotion requires one complete 13-attempt Eval run");
    }
  } else if (candidates.length !== 0) {
    throw new Error("a blocked baseline cannot have a candidate run");
  }
  if (manifests.some((manifest) => manifest.role === "observation")) {
    throw new Error("regression evidence cannot promote observational Eval runs");
  }
}

function assertGitIdentity(
  current: { commit: string; tree: string },
  expected: { commit: string; tree: string },
  message: string,
): void {
  if (current.commit !== expected.commit || current.tree !== expected.tree) {
    throw new Error(message);
  }
}
