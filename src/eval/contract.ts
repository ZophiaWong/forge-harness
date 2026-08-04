import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_MODULES = [
  ["eval/bootstrap", "bootstrap"],
  ["eval/c17c", "c17c"],
  ["eval/canonicalSuite", "canonicalSuite"],
  ["eval/contract", "contract"],
  ["eval/evidence", "evidence"],
  ["eval/fixture", "fixture"],
  ["eval/policy", "policy"],
  ["eval/runner", "runner"],
  ["eval/scenarios", "scenarios"],
  ["runtime/traceSchema", "../runtime/traceSchema"],
] as const;
const FIXTURE_KEY_ROOT = "fixture/issue-workflow";
const MAX_BUFFER_SIZE = BigInt(Number.MAX_SAFE_INTEGER);

type EntryType = "directory" | "file" | "other" | "symbolic-link";
type FileObservationPhase =
  | "descriptor-after"
  | "descriptor-before"
  | "path-after"
  | "path-after-open"
  | "path-before";

interface ObservedMetadata {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  size: bigint;
  type: EntryType;
}

interface DirectoryGuard {
  label: string;
  metadata: ObservedMetadata;
  pathname: string;
}

interface DirectoryEntrySnapshot {
  name: string;
  type: EntryType;
}

interface EvalContractLoadTestHooks {
  adjustFileMetadata?: (context: {
    key: string;
    metadata: ObservedMetadata;
    phase: FileObservationPhase;
  }) => ObservedMetadata;
  afterDirectorySnapshot?: (context: { pathname: string }) => Promise<void>;
  afterFileOpen?: (context: { key: string; pathname: string }) => Promise<void>;
  afterFirstFileRead?: (context: { key: string; pathname: string }) => Promise<void>;
}

export async function loadEvalContractSources(
  runtimeRepositoryRoot: string,
): Promise<Record<string, string>> {
  return loadEvalContractSourcesFrom(import.meta.url, runtimeRepositoryRoot);
}

export async function loadEvalContractSourcesFrom(
  contractModuleUrl: string,
  runtimeRepositoryRoot: string,
  hooks: EvalContractLoadTestHooks = {},
): Promise<Record<string, string>> {
  if (!runtimeRepositoryRoot.trim()) {
    throw new Error("eval runtime repository root must be non-empty");
  }
  const modulePath = fileURLToPath(contractModuleUrl);
  const evalDirectory = path.dirname(modulePath);
  const extension = path.extname(modulePath);
  if (extension !== ".js" && extension !== ".ts") {
    throw new Error(`eval contract module must execute as .ts or .js, received ${extension || "no extension"}`);
  }

  const moduleLayout = await validateModuleLayout(evalDirectory);
  const entries = await readContractModules(moduleLayout, extension, hooks);
  entries.push(...await readFixtureTree(path.resolve(runtimeRepositoryRoot), hooks));
  return sourceRecord(entries);
}

async function validateModuleLayout(evalDirectory: string) {
  const repositoryRoot = path.resolve(evalDirectory, "../..");
  const outputRoot = path.dirname(evalDirectory);
  const repository = await inspectPhysicalDirectory(
    repositoryRoot,
    "eval contract module repository root",
  );
  const output = await inspectPhysicalDirectory(
    outputRoot,
    "eval contract module output ancestor",
  );
  const evaluation = await inspectPhysicalDirectory(
    evalDirectory,
    "eval contract module eval ancestor",
  );
  const runtime = await inspectPhysicalDirectory(
    path.join(outputRoot, "runtime"),
    "eval contract module runtime ancestor",
  );
  return { evaluation, output, repository, runtime };
}

async function readContractModules(
  layout: Awaited<ReturnType<typeof validateModuleLayout>>,
  extension: ".js" | ".ts",
  hooks: EvalContractLoadTestHooks,
): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  for (const [key, relativePath] of CONTRACT_MODULES) {
    const directory = key.startsWith("runtime/") ? layout.runtime : layout.evaluation;
    const guards = [layout.repository, layout.output, directory];
    const pathname = path.resolve(layout.evaluation.pathname, `${relativePath}${extension}`);
    entries.push([key, encodeBytes(await readStableRegularFile(
      pathname,
      key,
      guards,
      hooks,
      `eval contract module ${key} must be an existing regular file`,
    ))]);
  }
  return entries;
}

async function readFixtureTree(
  runtimeRepositoryRoot: string,
  hooks: EvalContractLoadTestHooks,
): Promise<Array<[string, string]>> {
  let repository: DirectoryGuard;
  let examples: DirectoryGuard;
  let plugins: DirectoryGuard;
  let fixture: DirectoryGuard;
  try {
    repository = await inspectPhysicalDirectory(
      runtimeRepositoryRoot,
      "eval runtime repository root",
    );
    examples = await inspectPhysicalDirectory(
      path.join(runtimeRepositoryRoot, "examples"),
      "eval fixture ancestor examples",
    );
    plugins = await inspectPhysicalDirectory(
      path.join(runtimeRepositoryRoot, "examples", "plugins"),
      "eval fixture ancestor plugins",
    );
    fixture = await inspectPhysicalDirectory(
      path.join(runtimeRepositoryRoot, "examples", "plugins", "issue-workflow"),
      "eval contract fixture root",
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `eval runtime repository must contain a physical examples/plugins/issue-workflow fixture tree: ${detail}`,
    );
  }

  const entries: Array<[string, string]> = [];
  await visitFixtureDirectory(
    fixture,
    [repository, examples, plugins, fixture],
    entries,
    hooks,
  );
  return entries;
}

async function visitFixtureDirectory(
  directory: DirectoryGuard,
  guards: DirectoryGuard[],
  output: Array<[string, string]>,
  hooks: EvalContractLoadTestHooks,
): Promise<void> {
  // Portable Node has no openat or filesystem-snapshot primitive. These paired
  // descriptor/path observations assume a cooperatively quiescent repository;
  // a change completed and restored wholly between observations is unobservable.
  await assertDirectoryGuards(guards);
  const handle = await fs.open(directory.pathname, directoryOpenFlags());
  try {
    const descriptorBefore = metadata(await handle.stat({ bigint: true }));
    assertMetadataType(descriptorBefore, "directory", `${directory.label} changed before traversal`);
    assertMetadata(
      descriptorBefore,
      directory.metadata,
      `${directory.label} metadata mismatch after descriptor open`,
    );
    const pathBefore = (await inspectPhysicalDirectory(directory.pathname, directory.label)).metadata;
    assertMetadata(pathBefore, directory.metadata, `${directory.label} metadata changed before traversal`);
    const entriesBefore = await snapshotDirectoryEntries(directory.pathname);
    await hooks.afterDirectorySnapshot?.({ pathname: directory.pathname });

    for (const entry of entriesBefore) {
      await assertDirectoryGuards(guards);
      const pathname = path.join(directory.pathname, entry.name);
      const stats = await lstatOrReject(pathname, "eval contract fixture entry disappeared");
      const currentType = entryType(stats);
      if (currentType !== entry.type) {
        throw new Error(`eval contract fixture entry snapshot changed: ${entry.name}`);
      }
      const key = fixtureKey(guards[3].pathname, pathname);
      if (entry.type === "symbolic-link") {
        throw new Error(`eval contract fixture entry must not be a symbolic link: ${key}`);
      }
      if (entry.type === "directory") {
        const child = await inspectPhysicalDirectory(
          pathname,
          `eval contract fixture directory ${key}`,
        );
        await visitFixtureDirectory(child, [...guards, child], output, hooks);
        continue;
      }
      if (entry.type !== "file") {
        throw new Error(`eval contract fixture entry must be a regular file: ${key}`);
      }
      output.push([key, encodeBytes(await readStableRegularFile(
        pathname,
        key,
        guards,
        hooks,
        `eval contract fixture entry must be a regular file: ${key}`,
      ))]);
    }

    const entriesAfter = await snapshotDirectoryEntries(directory.pathname);
    assertDirectorySnapshot(entriesAfter, entriesBefore, `${directory.label} entry snapshot changed`);
    const descriptorAfter = metadata(await handle.stat({ bigint: true }));
    assertMetadata(
      descriptorAfter,
      descriptorBefore,
      `${directory.label} directory metadata changed during traversal`,
    );
    const pathAfter = (await inspectPhysicalDirectory(directory.pathname, directory.label)).metadata;
    assertMetadata(
      pathAfter,
      pathBefore,
      `${directory.label} directory path metadata changed during traversal`,
    );
    assertMetadata(
      pathAfter,
      descriptorAfter,
      `${directory.label} directory descriptor identity mismatch after traversal`,
    );
    await assertDirectoryGuards(guards);
  } finally {
    await handle.close();
  }
}

async function snapshotDirectoryEntries(pathname: string): Promise<DirectoryEntrySnapshot[]> {
  const names = await fs.readdir(pathname);
  names.sort(compareStableStrings);
  const snapshot: DirectoryEntrySnapshot[] = [];
  for (const name of names) {
    snapshot.push({
      name,
      type: entryType(await lstatOrReject(
        path.join(pathname, name),
        `eval contract fixture entry disappeared during snapshot: ${name}`,
      )),
    });
  }
  return snapshot;
}

async function readStableRegularFile(
  pathname: string,
  key: string,
  guards: DirectoryGuard[],
  hooks: EvalContractLoadTestHooks,
  missingMessage: string,
): Promise<Buffer> {
  await assertDirectoryGuards(guards);
  const pathBefore = adjustFileMetadata(
    await inspectPhysicalRegularFile(pathname, missingMessage),
    key,
    "path-before",
    hooks,
  );
  const handle = await fs.open(pathname, fileOpenFlags());
  try {
    const descriptorBefore = adjustFileMetadata(
      metadata(await handle.stat({ bigint: true })),
      key,
      "descriptor-before",
      hooks,
    );
    assertMetadataType(descriptorBefore, "file", missingMessage);
    assertMetadata(
      descriptorBefore,
      pathBefore,
      `${key} identity or metadata mismatch after descriptor open`,
    );
    await hooks.afterFileOpen?.({ key, pathname });
    const pathAfterOpen = await observedFilePath(
      pathname,
      key,
      pathBefore,
      "path-after-open",
      hooks,
    );
    assertMetadata(
      pathAfterOpen,
      descriptorBefore,
      `${key} identity or metadata changed after descriptor open`,
    );
    await assertDirectoryGuards(guards);

    const firstBytes = await readExactDescriptorBytes(handle, pathBefore.size, key);
    await hooks.afterFirstFileRead?.({ key, pathname });
    const secondBytes = await readExactDescriptorBytes(handle, pathBefore.size, key);

    const descriptorAfter = adjustFileMetadata(
      metadata(await handle.stat({ bigint: true })),
      key,
      "descriptor-after",
      hooks,
    );
    const pathAfter = await observedFilePath(
      pathname,
      key,
      pathBefore,
      "path-after",
      hooks,
    );
    if (!firstBytes.equals(secondBytes)) {
      throw new Error(`${key} content changed between descriptor reads`);
    }
    assertMetadata(
      descriptorAfter,
      descriptorBefore,
      `${key} descriptor metadata changed while reading`,
    );
    assertMetadata(pathAfter, pathBefore, `${key} path metadata changed while reading`);
    assertMetadata(
      pathAfter,
      descriptorAfter,
      `${key} descriptor and path metadata mismatch after reading`,
    );
    await assertDirectoryGuards(guards);
    return firstBytes;
  } finally {
    await handle.close();
  }
}

async function readExactDescriptorBytes(
  handle: Awaited<ReturnType<typeof fs.open>>,
  expectedSize: bigint,
  key: string,
): Promise<Buffer> {
  if (expectedSize < 0n || expectedSize > MAX_BUFFER_SIZE) {
    throw new Error(`${key} size cannot be represented safely for contract fingerprinting`);
  }
  const length = Number(expectedSize);
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, offset);
    if (result.bytesRead === 0) {
      throw new Error(`${key} content became shorter while reading`);
    }
    offset += result.bytesRead;
  }
  const extra = Buffer.alloc(1);
  if ((await handle.read(extra, 0, 1, length)).bytesRead !== 0) {
    throw new Error(`${key} content became longer while reading`);
  }
  return bytes;
}

async function observedFilePath(
  pathname: string,
  key: string,
  expected: ObservedMetadata,
  phase: FileObservationPhase,
  hooks: EvalContractLoadTestHooks,
): Promise<ObservedMetadata> {
  let current: ObservedMetadata;
  try {
    current = adjustFileMetadata(
      await inspectPhysicalRegularFile(pathname, `${key} changed while reading`),
      key,
      phase,
      hooks,
    );
  } catch {
    throw new Error(`${key} changed while reading`);
  }
  assertMetadata(current, expected, `${key} identity or metadata changed while reading`);
  return current;
}

async function inspectPhysicalRegularFile(
  pathname: string,
  errorMessage: string,
): Promise<ObservedMetadata> {
  const stats = await lstatOrReject(pathname, errorMessage);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(errorMessage);
  }
  await assertCanonicalPath(pathname, errorMessage);
  const canonicalStats = await fs.stat(pathname, { bigint: true });
  if (!canonicalStats.isFile()) {
    throw new Error(errorMessage);
  }
  const observed = metadata(canonicalStats);
  assertMetadata(observed, metadata(stats), errorMessage);
  return observed;
}

async function inspectPhysicalDirectory(
  pathname: string,
  label: string,
): Promise<DirectoryGuard> {
  const resolved = path.resolve(pathname);
  const stats = await lstatOrReject(
    resolved,
    `${label} must be an existing physical directory`,
  );
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} must be an existing physical directory`);
  }
  await assertCanonicalPath(
    resolved,
    `${label} must be a physical directory without symbolic-link ancestors`,
  );
  const canonicalStats = await fs.stat(resolved, { bigint: true });
  if (!canonicalStats.isDirectory()) {
    throw new Error(`${label} must be an existing physical directory`);
  }
  const observed = metadata(canonicalStats);
  assertMetadata(observed, metadata(stats), `${label} path metadata mismatch`);
  return { label, metadata: observed, pathname: resolved };
}

async function assertCanonicalPath(pathname: string, errorMessage: string): Promise<void> {
  let canonical: string;
  try {
    canonical = await fs.realpath(pathname);
  } catch {
    throw new Error(errorMessage);
  }
  if (path.resolve(canonical) !== path.resolve(pathname)) {
    throw new Error(errorMessage);
  }
}

async function assertDirectoryGuards(guards: DirectoryGuard[]): Promise<void> {
  for (const guard of guards) {
    const current = await inspectPhysicalDirectory(guard.pathname, guard.label);
    assertMetadata(
      current.metadata,
      guard.metadata,
      `${guard.label} directory metadata changed during eval contract loading`,
    );
  }
}

function fixtureKey(fixtureRoot: string, pathname: string): string {
  const relative = path.relative(fixtureRoot, pathname);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("eval contract fixture entry must stay inside the fixture root");
  }
  return `${FIXTURE_KEY_ROOT}/${relative.split(path.sep).join("/")}`;
}

function sourceRecord(entries: Array<[string, string]>): Record<string, string> {
  const sorted = entries.sort(([left], [right]) => compareStableStrings(left, right));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1][0] === sorted[index][0]) {
      throw new Error(`duplicate eval contract source key: ${sorted[index][0]}`);
    }
  }
  return Object.fromEntries(sorted);
}

function encodeBytes(bytes: Buffer): string {
  return `base64:${bytes.toString("base64")}`;
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function metadata(stats: BigIntStats): ObservedMetadata {
  return {
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    mtimeNs: stats.mtimeNs,
    size: stats.size,
    type: entryType(stats),
  };
}

function entryType(stats: BigIntStats): EntryType {
  if (stats.isSymbolicLink()) {
    return "symbolic-link";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
}

function adjustFileMetadata(
  value: ObservedMetadata,
  key: string,
  phase: FileObservationPhase,
  hooks: EvalContractLoadTestHooks,
): ObservedMetadata {
  return hooks.adjustFileMetadata?.({ key, metadata: value, phase }) ?? value;
}

function assertMetadata(
  actual: ObservedMetadata,
  expected: ObservedMetadata,
  message: string,
): void {
  if (
    actual.ctimeNs !== expected.ctimeNs
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.mode !== expected.mode
    || actual.mtimeNs !== expected.mtimeNs
    || actual.size !== expected.size
    || actual.type !== expected.type
  ) {
    throw new Error(message);
  }
}

function assertMetadataType(
  value: ObservedMetadata,
  expected: EntryType,
  message: string,
): void {
  if (value.type !== expected) {
    throw new Error(message);
  }
}

function assertDirectorySnapshot(
  actual: DirectoryEntrySnapshot[],
  expected: DirectoryEntrySnapshot[],
  message: string,
): void {
  if (
    actual.length !== expected.length
    || actual.some((entry, index) => (
      entry.name !== expected[index]?.name || entry.type !== expected[index]?.type
    ))
  ) {
    throw new Error(message);
  }
}

function fileOpenFlags(): number {
  return constants.O_RDONLY | supportedFlag(constants.O_NOFOLLOW);
}

function directoryOpenFlags(): number {
  return fileOpenFlags() | supportedFlag(constants.O_DIRECTORY);
}

function supportedFlag(flag: number | undefined): number {
  return typeof flag === "number" ? flag : 0;
}

async function lstatOrReject(pathname: string, errorMessage: string): Promise<BigIntStats> {
  try {
    return await fs.lstat(pathname, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(errorMessage);
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
