import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceGitIdentity,
  type EvidenceIntent,
  type EvidenceSourceSnapshot,
  type PrepareEvidenceIntentOptions,
} from "./evidenceTypes.js";
import {
  formatUtcTimestamp,
  hasExactKeys,
  isEvidenceEnvironment,
  isGitObjectId,
  isIsoDate,
  isRecord,
  isSelectionPolicy,
  requireSafeIdentifier,
  safeSlug,
  sha256,
  validateTagRef,
  writeJsonExclusive,
} from "./evidenceSafety.js";

const execFileAsync = promisify(execFile);

export async function writeEvidenceIntent(
  intent: EvidenceIntent,
  requestedOutput: string | undefined,
  repositoryRoot: string,
): Promise<string> {
  const resolvedRepositoryRoot = await fs.realpath(path.resolve(repositoryRoot));
  if (resolvedRepositoryRoot !== intent.collector.checkout) {
    throw new Error("evidence intent must be written under its registered collector checkout");
  }
  const evidenceRoot = path.join(resolvedRepositoryRoot, ".forge", "evidence");
  const outputPath = requestedOutput
    ? path.resolve(resolvedRepositoryRoot, requestedOutput)
    : path.join(evidenceRoot, intent.intentId, "intent.json");
  const outputRelative = path.relative(evidenceRoot, outputPath);
  if (!outputRelative
    || outputRelative === ".."
    || outputRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(outputRelative)) {
    throw new Error("evidence intent output must stay under .forge/evidence");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (await fs.realpath(evidenceRoot) !== evidenceRoot
    || await fs.realpath(path.dirname(outputPath)) !== path.dirname(outputPath)) {
    throw new Error("evidence intent output path cannot resolve through a symlink");
  }
  await writeJsonExclusive(
    outputPath,
    intent,
    `evidence intent already exists at ${outputPath}`,
  );
  return outputPath;
}

export async function readEvidenceIntent(intentPath: string): Promise<EvidenceIntent> {
  const value = JSON.parse(await fs.readFile(path.resolve(intentPath), "utf8")) as unknown;
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "artifactType",
      "collector",
      "createdAt",
      "environment",
      "intentId",
      "mode",
      "schemaVersion",
      "selectionPolicy",
      "subject",
    ])
    || value.artifactType !== "forge-evidence-intent"
    || value.schemaVersion !== EVIDENCE_SCHEMA_VERSION
    || (value.mode !== "observation" && value.mode !== "regression")
    || !isIsoDate(value.createdAt)
    || typeof value.intentId !== "string") {
    throw new Error("invalid evidence intent");
  }
  requireSafeIdentifier(value.intentId, "intent id");
  if (!isRecord(value.collector)
    || !hasExactKeys(value.collector, ["checkout", "clean", "commit", "tree"])
    || typeof value.collector.checkout !== "string"
    || !path.isAbsolute(value.collector.checkout)
    || value.collector.clean !== true
    || !isGitObjectId(value.collector.commit)
    || !isGitObjectId(value.collector.tree)) {
    throw new Error("invalid evidence intent collector identity");
  }
  if (!isRecord(value.subject)
    || !hasExactKeys(value.subject, ["checkout", "clean", "commit", "ref", "tree"])
    || typeof value.subject.checkout !== "string"
    || !path.isAbsolute(value.subject.checkout)
    || value.subject.clean !== true
    || !isGitObjectId(value.subject.commit)
    || typeof value.subject.ref !== "string"
    || !isGitObjectId(value.subject.tree)) {
    throw new Error("invalid evidence intent subject identity");
  }
  validateTagRef(value.subject.ref);
  if (!isEvidenceEnvironment(value.environment)) {
    throw new Error("invalid evidence intent environment identity");
  }
  if (!isSelectionPolicy(value.selectionPolicy, value.mode)) {
    throw new Error("invalid evidence intent selection policy");
  }
  return value as unknown as EvidenceIntent;
}

export async function prepareEvidenceIntent(
  options: PrepareEvidenceIntentOptions,
): Promise<EvidenceIntent> {
  const subjectRoot = await fs.realpath(path.resolve(options.subjectRoot));
  const collectorRoot = await fs.realpath(path.resolve(options.collectorRoot));
  const ref = validateTagRef(options.ref);
  const [subject, collector] = await Promise.all([
    inspectTaggedCheckout(subjectRoot, ref),
    inspectCleanCheckout(collectorRoot),
  ]);
  const now = options.now?.() ?? new Date();
  const suffix = safeSlug(options.randomSuffix?.() ?? crypto.randomBytes(4).toString("hex"));
  const model = options.model.trim();
  const providerId = options.providerId.trim();
  const endpoint = options.endpoint.trim();
  if (!model) {
    throw new Error("evidence model must be non-empty");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new Error(
      "evidence provider id must use lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  if (!endpoint) {
    throw new Error("evidence endpoint must be non-empty");
  }

  return {
    artifactType: "forge-evidence-intent",
    collector: { ...collector, checkout: collectorRoot, clean: true },
    createdAt: now.toISOString(),
    environment: { endpointHash: sha256(Buffer.from(endpoint)), model, providerId },
    intentId: `${safeSlug(ref)}-${options.mode}-${formatUtcTimestamp(now)}-${suffix}`,
    mode: options.mode,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    selectionPolicy: {
      evalAttemptsPerBatch: 13,
      evalBatchLimit: options.mode === "regression" ? 2 : 1,
      keepEveryRun: true,
      retry: "infrastructure-invalid-only",
      selection: "first-preregistered-run",
    },
    subject: { ...subject, checkout: subjectRoot, clean: true, ref },
  };
}

export async function beginEvidenceCapture(intent: EvidenceIntent): Promise<EvidenceSourceSnapshot> {
  const [subject, collector] = await Promise.all([
    inspectTaggedCheckout(intent.subject.checkout, intent.subject.ref),
    inspectCleanCheckout(intent.collector.checkout),
  ]);
  assertSameGitIdentity(subject, intent.subject, "subject source no longer matches the evidence intent");
  assertSameGitIdentity(
    collector,
    intent.collector,
    "collector source no longer matches the evidence intent",
  );
  return { collector, subject };
}

async function inspectTaggedCheckout(root: string, ref: string): Promise<EvidenceGitIdentity> {
  const tagRef = `refs/tags/${ref}`;
  await git(root, ["show-ref", "--verify", tagRef]);
  const [head, taggedCommit, tree] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["rev-parse", `${tagRef}^{commit}`]),
    git(root, ["rev-parse", `${tagRef}^{tree}`]),
  ]);
  if (head !== taggedCommit) {
    throw new Error(`subject checkout HEAD does not match tag ${ref}`);
  }
  await assertClean(root, "subject checkout");
  return { commit: taggedCommit, tree };
}

async function inspectCleanCheckout(root: string): Promise<EvidenceGitIdentity> {
  const [commit, tree] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["rev-parse", "HEAD^{tree}"]),
  ]);
  await assertClean(root, "collector checkout");
  return { commit, tree };
}

async function assertClean(root: string, label: string): Promise<void> {
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) {
    throw new Error(`${label} must be clean before evidence capture`);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

function assertSameGitIdentity(
  current: EvidenceGitIdentity,
  expected: EvidenceGitIdentity,
  message: string,
): void {
  if (current.commit !== expected.commit || current.tree !== expected.tree) {
    throw new Error(message);
  }
}

export async function assertIntentPathInsideCollector(
  intentPath: string,
  intent: EvidenceIntent,
): Promise<void> {
  const evidenceRoot = path.join(intent.collector.checkout, ".forge", "evidence");
  const resolvedIntentPath = path.resolve(intentPath);
  const relative = path.relative(evidenceRoot, resolvedIntentPath);
  if (!relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error("evidence intent must stay under the collector .forge/evidence root");
  }
  const stats = await fs.lstat(resolvedIntentPath);
  if (!stats.isFile()
    || stats.isSymbolicLink()
    || await fs.realpath(evidenceRoot) !== evidenceRoot
    || await fs.realpath(resolvedIntentPath) !== resolvedIntentPath) {
    throw new Error("evidence intent path cannot resolve through a symlink");
  }
}
