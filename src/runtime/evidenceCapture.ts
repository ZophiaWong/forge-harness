import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { beginEvidenceCapture } from "./evidenceIntent.js";
import {
  assertPublicEvidenceManifest,
  parsePrivateEvidenceInventory,
  parseRunEvidenceManifest,
  validateRunInput,
} from "./evidenceRunSchema.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceCaptureResult,
  type EvidenceGitIdentity,
  type EvidenceSourceSnapshot,
  type PrivateEvidenceInventory,
  type RecordEvidenceCaptureFailureOptions,
  type RunEvidenceManifest,
  type SealRunEvidenceOptions,
  type VerifyRunEvidenceOptions,
} from "./evidenceTypes.js";
import {
  EvidenceCaptureError,
  SHARED_EVIDENCE_LIMITATIONS,
  assertPhysicalFile,
  assertSafePublicArtifactFile,
  captureReasonCode,
  listTarEntries,
  pathExists,
  readTarEntry,
  requireSafeIdentifier,
  requireSafeRelativePath,
  sameSet,
  sha256,
  sha256File,
} from "./evidenceSafety.js";

const execFileAsync = promisify(execFile);

export async function recordEvidenceCaptureFailure(
  options: RecordEvidenceCaptureFailureOptions,
): Promise<EvidenceCaptureResult> {
  const runId = requireSafeIdentifier(options.run.runId, "run id");
  const reasonCode = requireSafeIdentifier(options.reasonCode, "capture failure reason");
  const outputRoot = path.resolve(options.outputRoot);
  await fs.mkdir(outputRoot, { recursive: true });
  const runRoot = path.join(outputRoot, runId);
  if (await pathExists(runRoot)) {
    throw new Error(`evidence run already exists at ${runRoot}`);
  }
  const failedOptions: SealRunEvidenceOptions = {
    intent: options.intent,
    outputRoot,
    rawSources: [],
    run: options.run,
    sourceAtStart: {
      collector: options.intent.collector,
      subject: options.intent.subject,
    },
  };
  validateRunInput(failedOptions);
  return writeFailedCapture(runRoot, failedOptions, reasonCode);
}

export async function sealRunEvidence(
  options: SealRunEvidenceOptions,
): Promise<EvidenceCaptureResult> {
  const runId = requireSafeIdentifier(options.run.runId, "run id");
  const outputRoot = path.resolve(options.outputRoot);
  await fs.mkdir(outputRoot, { recursive: true });
  const runRoot = path.join(outputRoot, runId);
  if (await pathExists(runRoot)) {
    throw new Error(`evidence run already exists at ${runRoot}`);
  }
  const temporaryRoot = await fs.mkdtemp(path.join(outputRoot, `.${runId}.`));

  try {
    validateRunInput(options);
    let sourceAtEnd: EvidenceSourceSnapshot;
    try {
      sourceAtEnd = await beginEvidenceCapture(options.intent);
    } catch (error) {
      throw new EvidenceCaptureError(
        "source_drift",
        "source changed during evidence capture",
        { cause: error },
      );
    }
    assertSameSourceSnapshot(sourceAtEnd, options.sourceAtStart);

    const archiveRoot = path.join(temporaryRoot, "archive");
    const privateRoot = path.join(temporaryRoot, "private");
    const publicRoot = path.join(temporaryRoot, "public");
    await Promise.all([
      fs.mkdir(path.join(archiveRoot, "raw"), { recursive: true }),
      fs.mkdir(privateRoot, { recursive: true }),
      fs.mkdir(publicRoot, { recursive: true }),
    ]);

    const files = await copyRawSources(options.rawSources, path.join(archiveRoot, "raw"));
    const inventoryPaths = new Set(files.map((file) => file.path));
    for (const requiredPath of options.requiredRawPaths ?? []) {
      const safePath = requireSafeRelativePath(requiredPath, "required raw evidence path");
      if (!inventoryPaths.has(safePath)) {
        throw new EvidenceCaptureError(
          "missing_raw_reference",
          `required raw evidence path ${safePath} was not copied into the private inventory`,
        );
      }
    }
    const references = [...options.rawReferences ?? []]
      .map((reference) => ({
        relation: reference.relation,
        source: requireSafeRelativePath(reference.source, "raw reference source"),
        target: requireSafeRelativePath(reference.target, "raw reference target"),
      }))
      .sort((left, right) => (
        left.source.localeCompare(right.source) || left.target.localeCompare(right.target)
      ));
    for (const reference of references) {
      if (reference.relation !== "evidenceRef"
        || !inventoryPaths.has(reference.source)
        || !inventoryPaths.has(reference.target)) {
        throw new EvidenceCaptureError(
          "missing_raw_reference",
          "private inventory references must resolve to copied raw files",
        );
      }
    }
    const inventory: PrivateEvidenceInventory = {
      artifactType: "forge-private-evidence-inventory",
      files,
      intentId: options.intent.intentId,
      references,
      runId,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
    };
    const inventoryText = `${JSON.stringify(inventory, null, 2)}\n`;
    await Promise.all([
      fs.writeFile(path.join(archiveRoot, "inventory.json"), inventoryText, "utf8"),
      fs.writeFile(path.join(privateRoot, "inventory.json"), inventoryText, "utf8"),
    ]);

    const reports = await copyPublicArtifacts(options.publicArtifacts ?? [], publicRoot);
    const archiveName = `${runId}.tgz`;
    const archivePath = path.join(privateRoot, archiveName);
    await execFileAsync("tar", ["-czf", archivePath, "-C", archiveRoot, "."]);
    const archiveStat = await fs.stat(archivePath);
    const archiveHash = await sha256File(archivePath);
    const { checkout: _collectorCheckout, ...collector } = options.intent.collector;
    const { checkout: _subjectCheckout, ...subject } = options.intent.subject;
    const manifest: RunEvidenceManifest = {
      archive: { fileName: archiveName, sha256: archiveHash, size: archiveStat.size },
      artifactType: "forge-run-evidence-manifest",
      baselineEligible: options.run.baselineEligible,
      behavior: options.run.behavior,
      capturedAt: (options.now?.() ?? new Date()).toISOString(),
      completedAt: options.run.completedAt,
      collector,
      environment: options.intent.environment,
      fileCount: files.length,
      intentId: options.intent.intentId,
      kind: options.run.kind,
      limitations: [...new Set([
        ...SHARED_EVIDENCE_LIMITATIONS,
        ...options.run.limitations,
      ])],
      mode: options.intent.mode,
      promotionEligible: options.run.promotionEligible,
      reports,
      ...(options.run.retryOf ? { retryOf: options.run.retryOf } : {}),
      role: options.run.role,
      runId,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      startedAt: options.run.startedAt,
      subject,
    };
    assertPublicEvidenceManifest(manifest);
    const manifestPath = path.join(publicRoot, "manifest.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await verifyRunEvidence({ archivePath, manifestPath });

    let sourceAfterSeal: EvidenceSourceSnapshot;
    try {
      sourceAfterSeal = await beginEvidenceCapture(options.intent);
    } catch (error) {
      throw new EvidenceCaptureError(
        "source_drift",
        "source changed while sealing evidence",
        { cause: error },
      );
    }
    assertSameSourceSnapshot(sourceAfterSeal, options.sourceAtStart);

    const result: EvidenceCaptureResult = {
      artifactType: "forge-evidence-capture-result",
      artifacts: {
        archive: `private/${archiveName}`,
        inventory: "private/inventory.json",
        manifest: "public/manifest.json",
        reports: reports.map((report) => `public/${report.fileName}`),
      },
      baselineEligible: options.run.baselineEligible,
      behavioralVerdict: options.run.behavior.verdict,
      captureStatus: "sealed",
      infrastructureInvalid: options.run.infrastructureInvalid,
      intentId: options.intent.intentId,
      kind: options.run.kind,
      promotionEligible: options.run.promotionEligible,
      ...(options.run.retryOf ? { retryOf: options.run.retryOf } : {}),
      role: options.run.role,
      runId,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
    };
    await fs.writeFile(
      path.join(temporaryRoot, "capture-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    await fs.rm(archiveRoot, { force: true, recursive: true });
    await fs.rename(temporaryRoot, runRoot);
    return result;
  } catch (error) {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
    return writeFailedCapture(runRoot, options, captureReasonCode(error));
  }
}

export async function verifyRunEvidence(
  options: VerifyRunEvidenceOptions,
): Promise<{ fileCount: number; runId: string }> {
  await assertPhysicalFile(path.resolve(options.manifestPath), "public evidence manifest");
  const manifest = parseRunEvidenceManifest(
    JSON.parse(await fs.readFile(options.manifestPath, "utf8")) as unknown,
  );
  const archivePath = path.resolve(options.archivePath);
  await assertPhysicalFile(archivePath, "private evidence archive");
  if (path.basename(archivePath) !== manifest.archive.fileName) {
    throw new Error("evidence archive name does not match the public manifest");
  }
  const archiveStat = await fs.stat(archivePath);
  if (archiveStat.size !== manifest.archive.size
    || await sha256File(archivePath) !== manifest.archive.sha256) {
    throw new Error("evidence archive SHA-256 or size does not match the public manifest");
  }

  const inventory = parsePrivateEvidenceInventory(JSON.parse(
    (await readTarEntry(archivePath, "./inventory.json")).toString("utf8"),
  ) as unknown);
  if (inventory.intentId !== manifest.intentId || inventory.runId !== manifest.runId) {
    throw new Error("private inventory identity does not match the public manifest");
  }
  if (inventory.files.length !== manifest.fileCount) {
    throw new Error("private inventory file count does not match the public manifest");
  }

  const listedEntries = await listTarEntries(archivePath);
  const expectedFiles = new Set([
    "inventory.json",
    ...inventory.files.map((file) => `raw/${file.path}`),
  ]);
  const actualFiles = new Set(listedEntries.filter((entry) => !entry.endsWith("/")));
  if (!sameSet(actualFiles, expectedFiles)) {
    throw new Error("evidence archive contents do not match the private inventory");
  }
  for (const file of inventory.files) {
    const content = await readTarEntry(archivePath, `./raw/${file.path}`);
    if (content.length !== file.size || sha256(content) !== file.sha256) {
      throw new Error(`archived evidence file ${file.path} failed SHA-256 verification`);
    }
  }

  const publicRoot = path.dirname(path.resolve(options.manifestPath));
  for (const report of manifest.reports) {
    const reportPath = path.join(publicRoot, report.fileName);
    await assertPhysicalFile(reportPath, `public evidence report ${report.fileName}`);
    await assertSafePublicArtifactFile(reportPath);
    const reportStat = await fs.stat(reportPath);
    if (reportStat.size !== report.size || await sha256File(reportPath) !== report.sha256) {
      throw new Error(`public evidence report ${report.fileName} failed SHA-256 verification`);
    }
  }
  return { fileCount: inventory.files.length, runId: manifest.runId };
}

async function copyRawSources(
  sources: SealRunEvidenceOptions["rawSources"],
  destinationRoot: string,
): Promise<PrivateEvidenceInventory["files"]> {
  const seen = new Set<string>();
  const collected: Array<{ archivePath: string; sourcePath: string }> = [];
  for (const source of sources) {
    const prefix = requireSafeRelativePath(source.prefix, "raw source prefix");
    const root = path.resolve(source.root);
    const stats = await fs.lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new EvidenceCaptureError("unsafe_raw_path", "raw evidence root must be a real directory");
    }
    if (await fs.realpath(root) !== root) {
      throw new EvidenceCaptureError(
        "unsafe_raw_path",
        "raw evidence root cannot resolve through a symlink",
      );
    }
    await collectRawFiles(root, root, prefix, collected);
  }
  collected.sort((left, right) => left.archivePath.localeCompare(right.archivePath));

  const files: PrivateEvidenceInventory["files"] = [];
  for (const file of collected) {
    if (seen.has(file.archivePath)) {
      throw new EvidenceCaptureError(
        "unsafe_raw_path",
        `duplicate raw evidence path ${file.archivePath}`,
      );
    }
    seen.add(file.archivePath);
    const destination = path.join(destinationRoot, ...file.archivePath.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(file.sourcePath, destination);
    const stats = await fs.stat(destination);
    files.push({ path: file.archivePath, sha256: await sha256File(destination), size: stats.size });
  }
  return files;
}

async function collectRawFiles(
  root: string,
  directory: string,
  prefix: string,
  output: Array<{ archivePath: string; sourcePath: string }>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const stats = await fs.lstat(candidate);
    if (stats.isSymbolicLink()) {
      throw new EvidenceCaptureError("unsafe_raw_path", "raw evidence cannot contain symlinks");
    }
    const relative = path.relative(root, candidate).split(path.sep).join("/");
    const archivePath = requireSafeRelativePath(`${prefix}/${relative}`, "raw evidence path");
    if (isCredentialPath(archivePath)) {
      throw new EvidenceCaptureError("credential_file", "raw evidence cannot include credential files");
    }
    if (stats.isDirectory()) {
      await collectRawFiles(root, candidate, prefix, output);
    } else if (stats.isFile()) {
      output.push({ archivePath, sourcePath: candidate });
    } else {
      throw new EvidenceCaptureError(
        "unsafe_raw_path",
        "raw evidence can contain only files and directories",
      );
    }
  }
}

async function copyPublicArtifacts(
  artifacts: NonNullable<SealRunEvidenceOptions["publicArtifacts"]>,
  publicRoot: string,
): Promise<RunEvidenceManifest["reports"]> {
  const seen = new Set<string>();
  const reports: RunEvidenceManifest["reports"] = [];
  for (const artifact of artifacts) {
    const name = requireSafeRelativePath(artifact.name, "public artifact name");
    if (name.includes("/") || seen.has(name)) {
      throw new EvidenceCaptureError(
        "unsafe_public_artifact",
        "public artifact names must be unique filenames",
      );
    }
    seen.add(name);
    const source = path.resolve(artifact.path);
    const stats = await fs.lstat(source);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new EvidenceCaptureError(
        "unsafe_public_artifact",
        "public evidence artifact must be a real file",
      );
    }
    await assertSafePublicArtifactFile(source);
    const destination = path.join(publicRoot, name);
    await fs.copyFile(source, destination);
    reports.push({ fileName: name, sha256: await sha256File(destination), size: stats.size });
  }
  return reports.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

async function writeFailedCapture(
  runRoot: string,
  options: SealRunEvidenceOptions,
  reasonCode: string,
): Promise<EvidenceCaptureResult> {
  const temporaryRoot = await fs.mkdtemp(
    path.join(path.dirname(runRoot), `.${path.basename(runRoot)}.failed.`),
  );
  const result: EvidenceCaptureResult = {
    artifactType: "forge-evidence-capture-result",
    baselineEligible: false,
    behavioralVerdict: options.run.behavior.verdict,
    captureStatus: "failed",
    infrastructureInvalid: true,
    intentId: options.intent.intentId,
    kind: options.run.kind,
    promotionEligible: false,
    reasonCode,
    ...(options.run.retryOf ? { retryOf: options.run.retryOf } : {}),
    role: options.run.role,
    runId: options.run.runId,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
  };
  await fs.writeFile(
    path.join(temporaryRoot, "capture-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryRoot, runRoot);
  return result;
}

function assertSameSourceSnapshot(
  current: EvidenceSourceSnapshot,
  started: EvidenceSourceSnapshot,
): void {
  assertSameGitIdentity(current.subject, started.subject, "subject source drifted during evidence capture");
  assertSameGitIdentity(
    current.collector,
    started.collector,
    "collector source drifted during evidence capture",
  );
}

function assertSameGitIdentity(
  current: EvidenceGitIdentity,
  expected: EvidenceGitIdentity,
  message: string,
): void {
  if (current.commit !== expected.commit || current.tree !== expected.tree) {
    throw new EvidenceCaptureError("source_drift", message);
  }
}

function isCredentialPath(relativePath: string): boolean {
  const name = relativePath.split("/").at(-1)?.toLowerCase() ?? "";
  return name === ".env"
    || name.startsWith(".env.")
    || [
      ".netrc",
      ".npmrc",
      ".pypirc",
      "auth.json",
      "credentials",
      "credentials.json",
      "id_ed25519",
      "id_rsa",
    ].includes(name)
    || name.endsWith(".key")
    || name.endsWith(".pem");
}
