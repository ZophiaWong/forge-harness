import { constants, type Stats } from "node:fs";
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

interface FileIdentity {
  dev: number;
  ino: number;
}

interface DirectoryGuard {
  identity: FileIdentity;
  label: string;
  pathname: string;
}

interface EvalContractLoadTestHooks {
  afterFileOpen?: (context: { key: string; pathname: string }) => Promise<void>;
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
  const entries = await readStableDirectoryEntries(directory, guards);
  for (const entry of entries) {
    await assertDirectoryGuards(guards);
    const pathname = path.join(directory.pathname, entry.name);
    const stats = await lstatOrReject(pathname, "eval contract fixture entry disappeared");
    const key = fixtureKey(guards[3].pathname, pathname);
    if (stats.isSymbolicLink()) {
      throw new Error(`eval contract fixture entry must not be a symbolic link: ${key}`);
    }
    if (stats.isDirectory()) {
      const child = await inspectPhysicalDirectory(
        pathname,
        `eval contract fixture directory ${key}`,
      );
      await visitFixtureDirectory(child, [...guards, child], output, hooks);
      continue;
    }
    if (!stats.isFile()) {
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
  await assertDirectoryGuards(guards);
}

async function readStableDirectoryEntries(
  directory: DirectoryGuard,
  guards: DirectoryGuard[],
) {
  await assertDirectoryGuards(guards);
  const handle = await fs.open(directory.pathname, directoryOpenFlags());
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()) {
      throw new Error(`${directory.label} changed before traversal`);
    }
    assertIdentity(
      identity(opened),
      directory.identity,
      `${directory.label} identity mismatch after descriptor open`,
    );
    // Node has no portable openat/readdir-by-descriptor primitive. The pathname
    // read is therefore fenced by descriptor and canonical-path identity checks;
    // detected replacement always aborts before any collected bytes are returned.
    // A swap-and-restore completed wholly between observation points is the
    // residual attacker model that portable Node pathname APIs cannot observe.
    const entries = await fs.readdir(directory.pathname, { withFileTypes: true });
    assertIdentity(
      identity(await handle.stat()),
      directory.identity,
      `${directory.label} identity changed during traversal`,
    );
    await assertDirectoryGuards(guards);
    return entries.sort((left, right) => compareStableStrings(left.name, right.name));
  } finally {
    await handle.close();
  }
}

async function readStableRegularFile(
  pathname: string,
  key: string,
  guards: DirectoryGuard[],
  hooks: EvalContractLoadTestHooks,
  missingMessage: string,
): Promise<Buffer> {
  await assertDirectoryGuards(guards);
  const before = await inspectPhysicalRegularFile(pathname, missingMessage);
  const handle = await fs.open(pathname, fileOpenFlags());
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error(missingMessage);
    }
    assertIdentity(identity(opened), before, `${key} identity mismatch after descriptor open`);
    await hooks.afterFileOpen?.({ key, pathname });
    await assertOpenedPathIdentity(pathname, key, before);
    await assertDirectoryGuards(guards);

    const bytes = await handle.readFile();

    assertIdentity(
      identity(await handle.stat()),
      before,
      `${key} identity changed while reading`,
    );
    await assertOpenedPathIdentity(pathname, key, before);
    await assertDirectoryGuards(guards);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertOpenedPathIdentity(
  pathname: string,
  key: string,
  expected: FileIdentity,
): Promise<void> {
  let current: FileIdentity;
  try {
    current = await inspectPhysicalRegularFile(pathname, `${key} changed while reading`);
  } catch {
    throw new Error(`${key} changed while reading`);
  }
  assertIdentity(current, expected, `${key} identity changed while reading`);
}

async function inspectPhysicalRegularFile(
  pathname: string,
  errorMessage: string,
): Promise<FileIdentity> {
  const stats = await lstatOrReject(pathname, errorMessage);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(errorMessage);
  }
  await assertCanonicalPath(pathname, errorMessage);
  const canonicalStats = await fs.stat(pathname);
  if (!canonicalStats.isFile()) {
    throw new Error(errorMessage);
  }
  assertIdentity(identity(canonicalStats), identity(stats), errorMessage);
  return identity(canonicalStats);
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
  const canonicalStats = await fs.stat(resolved);
  if (!canonicalStats.isDirectory()) {
    throw new Error(`${label} must be an existing physical directory`);
  }
  assertIdentity(
    identity(canonicalStats),
    identity(stats),
    `${label} path identity mismatch`,
  );
  return { identity: identity(canonicalStats), label, pathname: resolved };
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
    assertIdentity(
      current.identity,
      guard.identity,
      `${guard.label} identity changed during eval contract loading`,
    );
  }
}

function fixtureKey(fixtureRoot: string, pathname: string): string {
  const relative = path.relative(fixtureRoot, pathname);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
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

function identity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function assertIdentity(actual: FileIdentity, expected: FileIdentity, message: string): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
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

async function lstatOrReject(pathname: string, errorMessage: string): Promise<Stats> {
  try {
    return await fs.lstat(pathname);
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
