import type { EvidenceReleaseManifest } from "./evidenceTypes.js";
import { EVIDENCE_SCHEMA_VERSION } from "./evidenceTypes.js";
import {
  assertPublicArtifact,
  hasSchemaKeys,
  isEvidenceEnvironment,
  isHashedFile,
  isIsoDate,
  isPublicGitIdentity,
  isPublicSubjectIdentity,
  isRecord,
  isSelectionPolicy,
  requireSafeIdentifier,
  requireSafeRelativePath,
  validateTagRef,
} from "./evidenceSafety.js";

export function parseEvidenceReleaseManifest(value: unknown): EvidenceReleaseManifest {
  if (!isRecord(value)
    || !hasSchemaKeys(value, [
      "artifactType",
      "collector",
      "createdAt",
      "environment",
      "failedCaptures",
      "intentCreatedAt",
      "intentId",
      "limitations",
      "mode",
      "runs",
      "schemaVersion",
      "selectionPolicy",
      "subject",
    ])
    || value.artifactType !== "forge-release-evidence-manifest"
    || value.schemaVersion !== EVIDENCE_SCHEMA_VERSION
    || typeof value.intentId !== "string"
    || (value.mode !== "observation" && value.mode !== "regression")
    || !isPublicGitIdentity(value.collector)
    || !isPublicSubjectIdentity(value.subject)
    || !isEvidenceEnvironment(value.environment)
    || !isIsoDate(value.createdAt)
    || !isIsoDate(value.intentCreatedAt)
    || !Array.isArray(value.limitations)
    || value.limitations.some((limitation) => typeof limitation !== "string")
    || !Array.isArray(value.runs)
    || !Array.isArray(value.failedCaptures)
    || value.runs.length === 0) {
    throw new Error("invalid release evidence manifest");
  }

  for (const capture of value.failedCaptures) {
    if (!isRecord(capture)
      || !hasSchemaKeys(capture, [
        "behavioralVerdict",
        "reasonCode",
        "role",
        "runId",
      ], ["retryOf"])
      || typeof capture.behavioralVerdict !== "string"
      || typeof capture.reasonCode !== "string"
      || !["baseline", "candidate", "live", "observation"].includes(capture.role as string)
      || typeof capture.runId !== "string"
      || (capture.retryOf !== undefined && typeof capture.retryOf !== "string")) {
      throw new Error("invalid failed release evidence capture");
    }
    requireSafeIdentifier(capture.runId, "failed capture run id");
    requireSafeIdentifier(capture.reasonCode, "failed capture reason");
    if (capture.retryOf !== undefined) {
      requireSafeIdentifier(capture.retryOf as string, "failed capture retry run id");
    }
  }
  if (!isSelectionPolicy(value.selectionPolicy, value.mode)) {
    throw new Error("invalid release evidence selection policy");
  }

  for (const run of value.runs) {
    if (!isRecord(run)
      || !hasSchemaKeys(run, [
        "archive",
        "baselineEligible",
        "inventory",
        "manifest",
        "promotionEligible",
        "role",
        "runId",
      ], ["retryOf"])
      || typeof run.runId !== "string"
      || !["baseline", "candidate", "live", "observation"].includes(run.role as string)
      || typeof run.promotionEligible !== "boolean"
      || typeof run.baselineEligible !== "boolean"
      || !isHashedFile(run.archive)
      || !isHashedFile(run.inventory)
      || !isRecord(run.manifest)
      || !hasSchemaKeys(run.manifest, ["path", "sha256", "size"])
      || typeof run.manifest.path !== "string"
      || typeof run.manifest.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(run.manifest.sha256)
      || !Number.isInteger(run.manifest.size)
      || (run.manifest.size as number) < 0
      || (run.retryOf !== undefined && typeof run.retryOf !== "string")) {
      throw new Error("invalid release evidence run entry");
    }
    requireSafeRelativePath(run.manifest.path, "release run manifest path");
    requireSafeIdentifier(run.runId as string, "run id");
    if (run.retryOf !== undefined) {
      requireSafeIdentifier(run.retryOf as string, "retry run id");
    }
    if ((run.baselineEligible === true && run.role !== "baseline")
      || (run.baselineEligible === true && run.promotionEligible !== true)
      || (value.mode === "observation" && (run.role === "baseline" || run.role === "candidate"))
      || (value.mode === "regression" && run.role === "observation")) {
      throw new Error("invalid release evidence run state");
    }
  }

  const releaseRunIds = value.runs.map((run) => (run as { runId: string }).runId);
  const failedRunIds = value.failedCaptures.map((capture) => (
    (capture as { runId: string }).runId
  ));
  const releaseArchiveNames = value.runs.map((run) => (
    (run as { archive: { fileName: string } }).archive.fileName
  ));
  const releaseInventoryNames = value.runs.map((run) => (
    (run as { inventory: { fileName: string } }).inventory.fileName
  ));
  const releaseManifestPaths = value.runs.map((run) => (
    (run as { manifest: { path: string } }).manifest.path
  ));
  if (new Set(releaseRunIds).size !== releaseRunIds.length
    || new Set(failedRunIds).size !== failedRunIds.length
    || releaseRunIds.some((runId) => failedRunIds.includes(runId))
    || new Set(releaseArchiveNames).size !== releaseArchiveNames.length
    || new Set(releaseInventoryNames).size !== releaseInventoryNames.length
    || releaseArchiveNames.some((name) => releaseInventoryNames.includes(name))
    || new Set(releaseManifestPaths).size !== releaseManifestPaths.length) {
    throw new Error("release evidence manifest contains duplicate run assets");
  }

  assertOneRetryPerRole(value);
  requireSafeIdentifier(value.intentId, "intent id");
  validateTagRef((value.subject as Record<string, unknown>).ref as string);
  assertPublicArtifact(value, "releaseManifest");
  return value as unknown as EvidenceReleaseManifest;
}

function assertOneRetryPerRole(value: Record<string, unknown>): void {
  const entries = [
    ...(value.runs as Array<Record<string, unknown>>),
    ...(value.failedCaptures as Array<Record<string, unknown>>),
  ];
  for (const role of ["live", "observation", "baseline", "candidate"] as const) {
    const sameRole = entries.filter((entry) => entry.role === role);
    if (sameRole.length === 0) {
      continue;
    }
    const originals = sameRole.filter((entry) => entry.retryOf === undefined);
    const retries = sameRole.filter((entry) => entry.retryOf !== undefined);
    if (originals.length !== 1 || retries.length > 1 || sameRole.length > 2) {
      throw new Error(`release evidence allows at most one linked infrastructure retry for role ${role}`);
    }
    if (retries.length === 1 && retries[0]?.retryOf !== originals[0]?.runId) {
      throw new Error("release evidence retry must point to its role's original run");
    }
  }
}
