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

export async function loadEvalContractSources(): Promise<Record<string, string>> {
  return loadEvalContractSourcesFrom(import.meta.url);
}

export async function loadEvalContractSourcesFrom(
  contractModuleUrl: string,
): Promise<Record<string, string>> {
  const modulePath = fileURLToPath(contractModuleUrl);
  const evalDirectory = path.dirname(modulePath);
  const extension = path.extname(modulePath);
  if (extension !== ".js" && extension !== ".ts") {
    throw new Error(`eval contract module must execute as .ts or .js, received ${extension || "no extension"}`);
  }
  const repositoryRoot = path.resolve(evalDirectory, "../..");
  const entries = await readContractModules(evalDirectory, extension);
  entries.push(...await readFixtureTree(
    path.join(repositoryRoot, "examples", "plugins", "issue-workflow"),
  ));
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

async function readContractModules(
  evalDirectory: string,
  extension: ".js" | ".ts",
): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  for (const [key, relativePath] of CONTRACT_MODULES) {
    const pathname = path.resolve(evalDirectory, `${relativePath}${extension}`);
    entries.push([key, await readRegularFile(
      pathname,
      `eval contract module ${key} must be an existing regular file`,
    )]);
  }
  return entries;
}

async function readFixtureTree(fixtureRoot: string): Promise<Array<[string, string]>> {
  const rootStats = await lstatOrReject(
    fixtureRoot,
    "eval contract fixture root must be an existing directory",
  );
  if (rootStats.isSymbolicLink()) {
    throw new Error("eval contract fixture root must not be a symbolic link");
  }
  if (!rootStats.isDirectory()) {
    throw new Error("eval contract fixture root must be an existing directory");
  }

  const entries: Array<[string, string]> = [];
  await visitFixtureDirectory(fixtureRoot, fixtureRoot, entries);
  return entries;
}

async function visitFixtureDirectory(
  fixtureRoot: string,
  directory: string,
  output: Array<[string, string]>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const pathname = path.join(directory, entry.name);
    const stats = await lstatOrReject(pathname, "eval contract fixture entry disappeared");
    if (stats.isSymbolicLink()) {
      throw new Error(`eval contract fixture entry must not be a symbolic link: ${fixtureKey(fixtureRoot, pathname)}`);
    }
    if (stats.isDirectory()) {
      await visitFixtureDirectory(fixtureRoot, pathname, output);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`eval contract fixture entry must be a regular file: ${fixtureKey(fixtureRoot, pathname)}`);
    }
    output.push([
      fixtureKey(fixtureRoot, pathname),
      await fs.readFile(pathname, "utf8"),
    ]);
  }
}

function fixtureKey(fixtureRoot: string, pathname: string): string {
  const relative = path.relative(fixtureRoot, pathname);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("eval contract fixture entry must stay inside the fixture root");
  }
  return `${FIXTURE_KEY_ROOT}/${relative.split(path.sep).join("/")}`;
}

async function readRegularFile(pathname: string, errorMessage: string): Promise<string> {
  const stats = await lstatOrReject(pathname, errorMessage);
  if (!stats.isFile()) {
    throw new Error(errorMessage);
  }
  return fs.readFile(pathname, "utf8");
}

async function lstatOrReject(pathname: string, errorMessage: string) {
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
