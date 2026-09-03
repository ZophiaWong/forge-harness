/**
 * Public seam for release evidence. Intent registration, capture/sealing, and
 * release promotion stay in separate internal modules so callers learn one
 * compact interface without concentrating every implementation concern here.
 */
export {
  beginEvidenceCapture,
  prepareEvidenceIntent,
  readEvidenceIntent,
  writeEvidenceIntent,
} from "./evidenceIntent.js";
export {
  assertEvidenceLedgerClosed,
  assertEvidenceRunMayStart,
  readEvidenceCaptureResults,
  reserveEvidenceRun,
} from "./evidenceRunLedger.js";
export type {
  EvidenceRunReservation,
  ReserveEvidenceRunOptions,
} from "./evidenceRunLedger.js";
export {
  recordEvidenceCaptureFailure,
  sealRunEvidence,
  verifyRunEvidence,
} from "./evidenceCapture.js";
export {
  promoteEvidenceIntent,
  verifyPublishedEvidence,
} from "./evidencePromotion.js";

export { EVIDENCE_SCHEMA_VERSION } from "./evidenceTypes.js";
export type {
  AssertEvidenceRunMayStartOptions,
  EvidenceCaptureResult,
  EvidenceGitIdentity,
  EvidenceIntent,
  EvidenceMode,
  EvidenceReleaseManifest,
  EvidenceRunKind,
  EvidenceRunRole,
  EvidenceSourceSnapshot,
  PrepareEvidenceIntentOptions,
  PrivateEvidenceInventory,
  PromoteEvidenceIntentOptions,
  PromoteEvidenceIntentResult,
  RecordEvidenceCaptureFailureOptions,
  RunEvidenceManifest,
  SealRunEvidenceOptions,
  VerifyRunEvidenceOptions,
} from "./evidenceTypes.js";
