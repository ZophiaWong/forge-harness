import type {
  EvidenceCaptureResult,
  EvidenceIntent,
  PrivateEvidenceInventory,
  RunEvidenceManifest,
  SealRunEvidenceOptions,
} from "./evidenceTypes.js";
import {
  EvidenceCaptureError,
  assertPublicArtifact,
  containsAbsolutePath,
  hasExactKeys,
  hasSchemaKeys,
  isEvidenceEnvironment,
  isHashedFile,
  isIsoDate,
  isPublicGitIdentity,
  isPublicSubjectIdentity,
  isRecord,
  requireSafeIdentifier,
  requireSafeRelativePath,
  sameSet,
  validateTagRef,
} from "./evidenceSafety.js";
import { EVIDENCE_SCHEMA_VERSION } from "./evidenceTypes.js";

export function validateRunInput(options: SealRunEvidenceOptions): void {
  requireSafeIdentifier(options.run.runId, "run id");
  requireSafeIdentifier(
    options.run.behavior.verdict,
    "behavioral verdict",
    /[a-zA-Z0-9][a-zA-Z0-9._:-]*/,
  );
  if (options.run.kind === "live" && options.run.role !== "live") {
    throw new EvidenceCaptureError("invalid_run_role", "live evidence must use the live role");
  }
  if (options.run.kind === "eval" && options.run.role === "live") {
    throw new EvidenceCaptureError("invalid_run_role", "eval evidence cannot use the live role");
  }
  if (options.run.baselineEligible && options.run.role !== "baseline") {
    throw new EvidenceCaptureError("invalid_run_role", "only baseline evidence can be baseline eligible");
  }
  if (options.run.infrastructureInvalid && options.run.promotionEligible) {
    throw new EvidenceCaptureError(
      "invalid_promotion_state",
      "infrastructure-invalid evidence cannot be promotion eligible",
    );
  }
  if (options.run.baselineEligible
    && (!options.run.promotionEligible || options.run.infrastructureInvalid)) {
    throw new EvidenceCaptureError(
      "invalid_promotion_state",
      "baseline-eligible evidence must also be promotion eligible and infrastructure valid",
    );
  }
  if (options.run.behavior.infrastructureInvalid !== undefined
    && options.run.behavior.infrastructureInvalid !== options.run.infrastructureInvalid) {
    throw new EvidenceCaptureError(
      "invalid_behavior_state",
      "behavior and capture infrastructure validity must agree",
    );
  }
  if (!Number.isFinite(Date.parse(options.run.startedAt))
    || !Number.isFinite(Date.parse(options.run.completedAt))) {
    throw new EvidenceCaptureError("invalid_timestamp", "evidence run timestamps must be ISO dates");
  }
  if (Date.parse(options.run.completedAt) < Date.parse(options.run.startedAt)) {
    throw new EvidenceCaptureError("invalid_timestamp", "evidence completion cannot precede its start");
  }
  for (const limitation of options.run.limitations) {
    if (!limitation.trim() || containsAbsolutePath(limitation)) {
      throw new EvidenceCaptureError(
        "unsafe_public_artifact",
        "evidence limitations cannot contain absolute paths",
      );
    }
  }
}

export function assertPublicEvidenceManifest(manifest: RunEvidenceManifest): void {
  assertPublicArtifact(manifest, "manifest");
}

export function parseRunEvidenceManifest(value: unknown): RunEvidenceManifest {
  if (!isRecord(value)
    || !hasSchemaKeys(value, [
      "archive",
      "artifactType",
      "baselineEligible",
      "behavior",
      "capturedAt",
      "completedAt",
      "collector",
      "environment",
      "fileCount",
      "intentId",
      "kind",
      "limitations",
      "mode",
      "promotionEligible",
      "reports",
      "role",
      "runId",
      "schemaVersion",
      "startedAt",
      "subject",
    ], ["retryOf"])
    || value.artifactType !== "forge-run-evidence-manifest"
    || value.schemaVersion !== EVIDENCE_SCHEMA_VERSION
    || typeof value.runId !== "string"
    || typeof value.intentId !== "string"
    || !Number.isInteger(value.fileCount)
    || (value.fileCount as number) < 0
    || !isHashedFile(value.archive)
    || typeof value.baselineEligible !== "boolean"
    || typeof value.promotionEligible !== "boolean"
    || (value.kind !== "eval" && value.kind !== "live")
    || !["baseline", "candidate", "live", "observation"].includes(value.role as string)
    || (value.mode !== "observation" && value.mode !== "regression")
    || !isRecord(value.behavior)
    || !hasSchemaKeys(value.behavior, ["infrastructureInvalid", "verdict"], [
      "attemptCount",
      "canonical",
      "hardViolation",
      "sourceRunId",
      "valid",
    ])
    || typeof value.behavior.infrastructureInvalid !== "boolean"
    || typeof value.behavior.verdict !== "string"
    || (value.behavior.attemptCount !== undefined
      && (!Number.isInteger(value.behavior.attemptCount) || (value.behavior.attemptCount as number) < 0))
    || (value.behavior.canonical !== undefined && typeof value.behavior.canonical !== "boolean")
    || (value.behavior.hardViolation !== undefined && typeof value.behavior.hardViolation !== "boolean")
    || (value.behavior.sourceRunId !== undefined && typeof value.behavior.sourceRunId !== "string")
    || (value.behavior.valid !== undefined && typeof value.behavior.valid !== "boolean")
    || !isPublicGitIdentity(value.collector)
    || !isPublicSubjectIdentity(value.subject)
    || !isEvidenceEnvironment(value.environment)
    || !isIsoDate(value.startedAt)
    || !isIsoDate(value.completedAt)
    || !isIsoDate(value.capturedAt)
    || !Array.isArray(value.limitations)
    || value.limitations.some((limitation) => typeof limitation !== "string")
    || !Array.isArray(value.reports)
    || value.reports.some((report) => !isHashedFile(report))
    || new Set(value.reports.map((report) => (report as { fileName: string }).fileName)).size
      !== value.reports.length
    || (value.retryOf !== undefined && typeof value.retryOf !== "string")) {
    throw new Error("invalid public evidence manifest");
  }
  requireSafeIdentifier(value.runId, "run id");
  requireSafeIdentifier(value.intentId, "intent id");
  if (value.retryOf !== undefined) {
    requireSafeIdentifier(value.retryOf as string, "retry run id");
  }
  if (value.behavior.sourceRunId !== undefined) {
    requireSafeIdentifier(value.behavior.sourceRunId as string, "source run id");
  }
  validateTagRef((value.subject as Record<string, unknown>).ref as string);
  if ((value.kind === "live") !== (value.role === "live")
    || (value.baselineEligible === true && value.role !== "baseline")
    || (value.behavior.infrastructureInvalid === true && value.promotionEligible === true)
    || (value.baselineEligible === true && value.promotionEligible !== true)
    || (value.kind === "eval" && value.mode === "observation" && value.role !== "observation")
    || (value.kind === "eval" && value.mode === "regression" && value.role === "observation")
    || Date.parse(value.completedAt as string) < Date.parse(value.startedAt as string)
    || Date.parse(value.capturedAt as string) < Date.parse(value.completedAt as string)) {
    throw new Error("invalid public evidence manifest run role");
  }
  assertPublicEvidenceManifest(value as unknown as RunEvidenceManifest);
  return value as unknown as RunEvidenceManifest;
}

export function parseEvidenceCaptureResult(value: unknown): EvidenceCaptureResult {
  if (!isRecord(value)
    || !hasSchemaKeys(value, [
      "artifactType",
      "baselineEligible",
      "behavioralVerdict",
      "captureStatus",
      "infrastructureInvalid",
      "intentId",
      "kind",
      "promotionEligible",
      "role",
      "runId",
      "schemaVersion",
    ], ["artifacts", "reasonCode", "retryOf"])
    || value.artifactType !== "forge-evidence-capture-result"
    || value.schemaVersion !== EVIDENCE_SCHEMA_VERSION
    || typeof value.intentId !== "string"
    || typeof value.runId !== "string"
    || (value.captureStatus !== "failed" && value.captureStatus !== "sealed")
    || typeof value.promotionEligible !== "boolean"
    || typeof value.baselineEligible !== "boolean"
    || typeof value.infrastructureInvalid !== "boolean"
    || typeof value.behavioralVerdict !== "string"
    || (value.kind !== "eval" && value.kind !== "live")
    || !["baseline", "candidate", "live", "observation"].includes(value.role as string)
    || (value.reasonCode !== undefined && typeof value.reasonCode !== "string")
    || (value.retryOf !== undefined && typeof value.retryOf !== "string")) {
    throw new Error("invalid evidence capture result");
  }
  requireSafeIdentifier(value.intentId, "intent id");
  requireSafeIdentifier(value.runId, "run id");
  if (value.reasonCode !== undefined) {
    requireSafeIdentifier(value.reasonCode as string, "capture failure reason");
  }
  if (value.retryOf !== undefined) {
    requireSafeIdentifier(value.retryOf as string, "retry run id");
  }
  if ((value.kind === "live") !== (value.role === "live")
    || (value.baselineEligible === true && value.role !== "baseline")
    || (value.infrastructureInvalid === true && value.promotionEligible === true)
    || (value.captureStatus === "failed" && value.promotionEligible === true)
    || (value.captureStatus === "failed" && value.artifacts !== undefined)
    || (value.captureStatus === "failed" && value.reasonCode === undefined)
    || (value.captureStatus === "sealed" && value.reasonCode !== undefined)) {
    throw new Error("invalid evidence capture result state");
  }
  if (value.captureStatus === "sealed") {
    if (!isRecord(value.artifacts)
      || !hasExactKeys(value.artifacts, ["archive", "inventory", "manifest", "reports"])
      || typeof value.artifacts.archive !== "string"
      || typeof value.artifacts.inventory !== "string"
      || typeof value.artifacts.manifest !== "string"
      || !Array.isArray(value.artifacts.reports)
      || value.artifacts.reports.some((report) => typeof report !== "string")) {
      throw new Error("sealed evidence capture is missing its artifacts");
    }
    requireSafeRelativePath(value.artifacts.archive, "capture archive path");
    requireSafeRelativePath(value.artifacts.inventory, "capture inventory path");
    requireSafeRelativePath(value.artifacts.manifest, "capture manifest path");
    value.artifacts.reports.forEach((report) => (
      requireSafeRelativePath(report as string, "capture report path")
    ));
  }
  return value as unknown as EvidenceCaptureResult;
}

export function parsePrivateEvidenceInventory(value: unknown): PrivateEvidenceInventory {
  if (!isRecord(value)
    || !hasSchemaKeys(value, [
      "artifactType",
      "files",
      "intentId",
      "references",
      "runId",
      "schemaVersion",
    ])
    || value.artifactType !== "forge-private-evidence-inventory"
    || value.schemaVersion !== EVIDENCE_SCHEMA_VERSION
    || typeof value.runId !== "string"
    || typeof value.intentId !== "string"
    || !Array.isArray(value.files)
    || !Array.isArray(value.references)) {
    throw new Error("invalid private evidence inventory");
  }
  const files = value.files.map((file) => {
    if (!isRecord(file)
      || !hasSchemaKeys(file, ["path", "sha256", "size"])
      || typeof file.path !== "string"
      || typeof file.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(file.sha256)
      || typeof file.size !== "number"
      || !Number.isInteger(file.size)
      || file.size < 0) {
      throw new Error("invalid private evidence inventory file");
    }
    requireSafeRelativePath(file.path, "private inventory path");
    return file as unknown as PrivateEvidenceInventory["files"][number];
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("private evidence inventory contains duplicate paths");
  }
  const filePaths = new Set(files.map((file) => file.path));
  const references = value.references.map((reference) => {
    if (!isRecord(reference)
      || !hasSchemaKeys(reference, ["relation", "source", "target"])
      || reference.relation !== "evidenceRef"
      || typeof reference.source !== "string"
      || typeof reference.target !== "string") {
      throw new Error("invalid private evidence inventory reference");
    }
    const source = requireSafeRelativePath(reference.source, "private inventory reference source");
    const target = requireSafeRelativePath(reference.target, "private inventory reference target");
    if (!filePaths.has(source) || !filePaths.has(target)) {
      throw new Error("private inventory reference does not resolve to archived files");
    }
    return { relation: "evidenceRef" as const, source, target };
  });
  const referenceKeys = references.map((reference) => (
    `${reference.relation}\0${reference.source}\0${reference.target}`
  ));
  if (new Set(referenceKeys).size !== references.length) {
    throw new Error("private evidence inventory contains duplicate references");
  }
  requireSafeIdentifier(value.intentId, "intent id");
  requireSafeIdentifier(value.runId, "run id");
  return { ...value, files, references } as unknown as PrivateEvidenceInventory;
}

export function assertCaptureMatchesManifest(
  capture: EvidenceCaptureResult,
  manifest: RunEvidenceManifest,
  intent: EvidenceIntent,
): void {
  const expectedReports = new Set(manifest.reports.map((report) => `public/${report.fileName}`));
  const captureReports = new Set(capture.artifacts?.reports ?? []);
  if (!capture.artifacts
    || capture.artifacts.archive !== `private/${manifest.archive.fileName}`
    || capture.artifacts.inventory !== "private/inventory.json"
    || capture.artifacts.manifest !== "public/manifest.json"
    || !sameSet(captureReports, expectedReports)
    || manifest.intentId !== intent.intentId
    || manifest.mode !== intent.mode
    || manifest.runId !== capture.runId
    || manifest.kind !== capture.kind
    || manifest.role !== capture.role
    || manifest.promotionEligible !== capture.promotionEligible
    || manifest.baselineEligible !== capture.baselineEligible
    || manifest.behavior.verdict !== capture.behavioralVerdict
    || manifest.behavior.infrastructureInvalid !== capture.infrastructureInvalid
    || manifest.subject.commit !== intent.subject.commit
    || manifest.subject.tree !== intent.subject.tree
    || manifest.subject.ref !== intent.subject.ref
    || manifest.subject.clean !== true
    || manifest.collector.commit !== intent.collector.commit
    || manifest.collector.tree !== intent.collector.tree
    || manifest.collector.clean !== true
    || manifest.environment.endpointHash !== intent.environment.endpointHash
    || manifest.environment.model !== intent.environment.model
    || manifest.environment.providerId !== intent.environment.providerId) {
    throw new Error(`evidence capture ${capture.runId} does not match its public manifest or intent`);
  }
}
