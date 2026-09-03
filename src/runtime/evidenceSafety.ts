import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  EvidenceGitIdentity,
  EvidenceIntent,
} from "./evidenceTypes.js";

const execFileAsync = promisify(execFile);

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "apikey",
  "arguments",
  "argumentstext",
  "authorization",
  "checkout",
  "credential",
  "credentials",
  "environmentvariables",
  "headers",
  "modeloutput",
  "outputtext",
  "prompt",
  "rawprompt",
  "rawtrace",
  "task",
  "toolarguments",
  "tracepayload",
]);

export const SHARED_EVIDENCE_LIMITATIONS = [
  "SHA-256 provides integrity, not signer identity; this schema has no signature, SLSA, or third-party attestation.",
  "Clean source checks occur before and after capture and cannot detect a transient modification that is fully restored between checks.",
];

export class EvidenceCaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function captureReasonCode(error: unknown): string {
  return error instanceof EvidenceCaptureError ? error.code : "capture_failed";
}

export function safeSlug(value: string): string {
  const slug = value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!slug || slug === "." || slug === "..") {
    throw new Error(`cannot derive a safe evidence identifier from ${JSON.stringify(value)}`);
  }
  return slug;
}

export function formatUtcTimestamp(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    "-",
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}

export function validateTagRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("-") || trimmed.includes("..") || trimmed.includes("@{")) {
    throw new Error("evidence ref must name a safe Git tag");
  }
  return trimmed;
}

export function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function writeJsonExclusive(
  filePath: string,
  value: unknown,
  existsMessage: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.link(temporaryPath, filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(existsMessage);
    }
    throw error;
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export function requireSafeIdentifier(
  value: string,
  label: string,
  pattern = /[a-z0-9][a-z0-9._-]*/,
): string {
  if (!value || !new RegExp(`^(?:${pattern.source})$`).test(value)) {
    throw new EvidenceCaptureError("unsafe_identifier", `${label} is not safe`);
  }
  return value;
}

export function requireSafeRelativePath(value: string, label: string): string {
  if (!value
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new EvidenceCaptureError("unsafe_raw_path", `${label} must be a safe relative path`);
  }
  return value;
}

export function containsAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /(?:^|\s)\/(?:etc|home|mnt|opt|private|repo|root|tmp|Users|var|workspace)\//.test(value)
    || /[a-zA-Z]:[\\/]/.test(value);
}

export function assertPublicArtifact(value: unknown, keyPath: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicArtifact(item, `${keyPath}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (FORBIDDEN_PUBLIC_KEYS.has(normalizedKey)) {
        throw new EvidenceCaptureError(
          "unsafe_public_artifact",
          `public evidence artifact cannot contain ${key}`,
        );
      }
      assertPublicArtifact(child, `${keyPath}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && containsAbsolutePath(value)) {
    throw new EvidenceCaptureError(
      "unsafe_public_artifact",
      `public evidence artifact contains an absolute path at ${keyPath}`,
    );
  }
}

export async function assertSafePublicArtifactFile(filePath: string): Promise<void> {
  const bytes = await fs.readFile(filePath);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new EvidenceCaptureError(
      "unsafe_public_artifact",
      "public evidence artifacts must be UTF-8 text",
      { cause: error },
    );
  }
  if (text.includes("\0") || containsAbsolutePath(text)) {
    throw new EvidenceCaptureError(
      "unsafe_public_artifact",
      "public evidence artifact contains unsafe text",
    );
  }
  if (path.extname(filePath).toLowerCase() === ".json") {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new EvidenceCaptureError(
        "unsafe_public_artifact",
        "public JSON evidence artifact is malformed",
        { cause: error },
      );
    }
    assertPublicArtifact(value, "publicArtifact");
    return;
  }
  assertPublicArtifact(text, "publicArtifact");
}

export function resolveInside(root: string, relativePath: string, label: string): string {
  requireSafeRelativePath(relativePath, label);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relative = path.relative(resolvedRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped its evidence root`);
  }
  return candidate;
}

export function requireArchiveSet(paths: string[], expectedNames: string[]): Map<string, string> {
  const expected = new Set(expectedNames);
  if (expected.size !== expectedNames.length) {
    throw new Error("evidence manifest contains duplicate archive names");
  }
  const byName = new Map<string, string>();
  for (const archivePath of paths) {
    const resolved = path.resolve(archivePath);
    const name = path.basename(resolved);
    if (byName.has(name)) {
      throw new Error(`duplicate evidence archive ${name}`);
    }
    byName.set(name, resolved);
  }
  if (!sameSet(new Set(byName.keys()), expected)) {
    throw new Error("provided evidence archives do not match the manifest archive set");
  }
  return byName;
}

export function isHashedFile(value: unknown): value is { fileName: string; sha256: string; size: number } {
  return isRecord(value)
    && hasExactKeys(value, ["fileName", "sha256", "size"])
    && typeof value.fileName === "string"
    && path.basename(value.fileName) === value.fileName
    && typeof value.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isInteger(value.size)
    && (value.size as number) >= 0;
}

export function isPublicGitIdentity(value: unknown): value is EvidenceGitIdentity & { clean: true } {
  return isRecord(value)
    && hasExactKeys(value, ["clean", "commit", "tree"])
    && value.clean === true
    && isGitObjectId(value.commit)
    && isGitObjectId(value.tree);
}

export function isPublicSubjectIdentity(
  value: unknown,
): value is Omit<EvidenceIntent["subject"], "checkout"> {
  return isRecord(value)
    && hasExactKeys(value, ["clean", "commit", "ref", "tree"])
    && value.clean === true
    && isGitObjectId(value.commit)
    && typeof value.ref === "string"
    && isGitObjectId(value.tree);
}

export function isEvidenceEnvironment(value: unknown): value is EvidenceIntent["environment"] {
  return isRecord(value)
    && hasExactKeys(value, ["endpointHash", "model", "providerId"])
    && typeof value.endpointHash === "string"
    && /^[a-f0-9]{64}$/.test(value.endpointHash)
    && typeof value.model === "string"
    && value.model.trim().length > 0
    && typeof value.providerId === "string"
    && /^[a-z0-9][a-z0-9._-]*$/.test(value.providerId);
}

export function isSelectionPolicy(
  value: unknown,
  mode: unknown,
): value is EvidenceIntent["selectionPolicy"] {
  return isRecord(value)
    && hasExactKeys(value, [
      "evalAttemptsPerBatch",
      "evalBatchLimit",
      "keepEveryRun",
      "retry",
      "selection",
    ])
    && value.evalAttemptsPerBatch === 13
    && value.evalBatchLimit === (mode === "regression" ? 2 : 1)
    && value.keepEveryRun === true
    && value.retry === "infrastructure-invalid-only"
    && value.selection === "first-preregistered-run";
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

export function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function assertPhysicalFile(candidate: string, label: string): Promise<void> {
  const resolved = path.resolve(candidate);
  const stats = await fs.lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || await fs.realpath(resolved) !== resolved) {
    throw new Error(`${label} must be a physical file`);
  }
}

export async function listTarEntries(archivePath: string): Promise<string[]> {
  const output = (await execFileAsync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })).stdout;
  return output.split("\n").filter(Boolean).map((entry) => {
    const normalized = entry.startsWith("./") ? entry.slice(2) : entry;
    const withoutDirectorySuffix = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    if (withoutDirectorySuffix) {
      requireSafeRelativePath(withoutDirectorySuffix, "archive entry");
    }
    return normalized;
  }).filter(Boolean);
}

export async function readTarEntry(archivePath: string, entry: string): Promise<Buffer> {
  const output = (await execFileAsync("tar", ["-xOzf", archivePath, entry], {
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
  })).stdout;
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const orderedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  return actual.length === orderedExpected.length
    && actual.every((key, index) => key === orderedExpected[index]);
}

export function hasSchemaKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every((key) => allowed.has(key));
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
