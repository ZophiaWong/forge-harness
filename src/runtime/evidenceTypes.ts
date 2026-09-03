export const EVIDENCE_SCHEMA_VERSION = 1;

export type EvidenceMode = "observation" | "regression";
export type EvidenceRunKind = "eval" | "live";
export type EvidenceRunRole = "baseline" | "candidate" | "live" | "observation";

export interface EvidenceGitIdentity {
  commit: string;
  tree: string;
}

export interface EvidenceIntent {
  artifactType: "forge-evidence-intent";
  collector: EvidenceGitIdentity & {
    checkout: string;
    clean: true;
  };
  createdAt: string;
  environment: {
    endpointHash: string;
    model: string;
    providerId: string;
  };
  intentId: string;
  mode: EvidenceMode;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  selectionPolicy: {
    evalAttemptsPerBatch: 13;
    evalBatchLimit: 1 | 2;
    keepEveryRun: true;
    retry: "infrastructure-invalid-only";
    selection: "first-preregistered-run";
  };
  subject: EvidenceGitIdentity & {
    checkout: string;
    clean: true;
    ref: string;
  };
}

export interface RunEvidenceManifest {
  archive: {
    fileName: string;
    sha256: string;
    size: number;
  };
  artifactType: "forge-run-evidence-manifest";
  baselineEligible: boolean;
  behavior: {
    attemptCount?: number;
    canonical?: boolean;
    hardViolation?: boolean;
    infrastructureInvalid: boolean;
    sourceRunId?: string;
    valid?: boolean;
    verdict: string;
  };
  capturedAt: string;
  completedAt: string;
  collector: EvidenceGitIdentity & { clean: true };
  environment: EvidenceIntent["environment"];
  fileCount: number;
  intentId: string;
  kind: EvidenceRunKind;
  limitations: string[];
  mode: EvidenceMode;
  promotionEligible: boolean;
  reports: Array<{
    fileName: string;
    sha256: string;
    size: number;
  }>;
  retryOf?: string;
  role: EvidenceRunRole;
  runId: string;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  startedAt: string;
  subject: Omit<EvidenceIntent["subject"], "checkout">;
}

export interface PrivateEvidenceInventory {
  artifactType: "forge-private-evidence-inventory";
  files: Array<{
    path: string;
    sha256: string;
    size: number;
  }>;
  intentId: string;
  references: Array<{
    relation: "evidenceRef";
    source: string;
    target: string;
  }>;
  runId: string;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
}

export interface EvidenceReleaseManifest {
  artifactType: "forge-release-evidence-manifest";
  collector: EvidenceGitIdentity & { clean: true };
  createdAt: string;
  environment: EvidenceIntent["environment"];
  failedCaptures: Array<{
    behavioralVerdict: string;
    reasonCode: string;
    retryOf?: string;
    role: EvidenceRunRole;
    runId: string;
  }>;
  intentCreatedAt: string;
  intentId: string;
  limitations: string[];
  mode: EvidenceMode;
  runs: Array<{
    archive: RunEvidenceManifest["archive"];
    baselineEligible: boolean;
    inventory: {
      fileName: string;
      sha256: string;
      size: number;
    };
    manifest: {
      path: string;
      sha256: string;
      size: number;
    };
    promotionEligible: boolean;
    retryOf?: string;
    role: EvidenceRunRole;
    runId: string;
  }>;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  selectionPolicy: EvidenceIntent["selectionPolicy"];
  subject: Omit<EvidenceIntent["subject"], "checkout">;
}

export interface EvidenceCaptureResult {
  artifactType: "forge-evidence-capture-result";
  artifacts?: {
    archive: string;
    inventory: string;
    manifest: string;
    reports: string[];
  };
  baselineEligible: boolean;
  behavioralVerdict: string;
  captureStatus: "failed" | "sealed";
  infrastructureInvalid: boolean;
  intentId: string;
  kind: EvidenceRunKind;
  promotionEligible: boolean;
  reasonCode?: string;
  retryOf?: string;
  role: EvidenceRunRole;
  runId: string;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
}

export interface EvidenceSourceSnapshot {
  collector: EvidenceGitIdentity;
  subject: EvidenceGitIdentity;
}

export interface SealRunEvidenceOptions {
  intent: EvidenceIntent;
  now?: () => Date;
  outputRoot: string;
  publicArtifacts?: Array<{
    name: string;
    path: string;
  }>;
  rawReferences?: PrivateEvidenceInventory["references"];
  requiredRawPaths?: string[];
  rawSources: Array<{
    prefix: string;
    root: string;
  }>;
  run: {
    baselineEligible: boolean;
    behavior: RunEvidenceManifest["behavior"];
    completedAt: string;
    infrastructureInvalid: boolean;
    kind: EvidenceRunKind;
    limitations: string[];
    promotionEligible: boolean;
    retryOf?: string;
    role: EvidenceRunRole;
    runId: string;
    startedAt: string;
  };
  sourceAtStart: EvidenceSourceSnapshot;
}

export interface VerifyRunEvidenceOptions {
  archivePath: string;
  manifestPath: string;
}

export interface PromoteEvidenceIntentOptions {
  intentPath: string;
  now?: () => Date;
  outputRoot?: string;
}

export interface PromoteEvidenceIntentResult {
  privateRoot: string;
  publicRoot: string;
  releaseManifestPath: string;
  runIds: string[];
}

export interface AssertEvidenceRunMayStartOptions {
  intentPath: string;
  kind: EvidenceRunKind;
  retryOf?: string;
  role: EvidenceRunRole;
}

export interface RecordEvidenceCaptureFailureOptions {
  intent: EvidenceIntent;
  outputRoot: string;
  reasonCode: string;
  run: SealRunEvidenceOptions["run"];
}

export interface PrepareEvidenceIntentOptions {
  collectorRoot: string;
  endpoint: string;
  mode: EvidenceMode;
  model: string;
  now?: () => Date;
  providerId: string;
  randomSuffix?: () => string;
  ref: string;
  subjectRoot: string;
}
