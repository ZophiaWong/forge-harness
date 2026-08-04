import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadEvalContractSources,
  loadEvalContractSourcesFrom,
} from "../../src/eval/contract.js";
import { buildExperimentIdentity } from "../../src/eval/fingerprint.js";

const tempRoots: string[] = [];
const executableExtensions: Array<".js" | ".ts"> = [".ts", ".js"];
const expectedRepositoryKeys = [
  "eval/bootstrap",
  "eval/c17c",
  "eval/canonicalSuite",
  "eval/contract",
  "eval/evidence",
  "eval/fixture",
  "eval/policy",
  "eval/runner",
  "eval/scenarios",
  "fixture/issue-workflow/.forge-plugin/plugin.json",
  "fixture/issue-workflow/hooks/audit.mjs",
  "fixture/issue-workflow/hooks/hooks.json",
  "fixture/issue-workflow/mcp/mcp.json",
  "fixture/issue-workflow/mcp/server.mjs",
  "fixture/issue-workflow/skills/triage/SKILL.md",
  "runtime/traceSchema",
];
const expectedSyntheticKeys = [
  "eval/bootstrap",
  "eval/c17c",
  "eval/canonicalSuite",
  "eval/contract",
  "eval/evidence",
  "eval/fixture",
  "eval/policy",
  "eval/runner",
  "eval/scenarios",
  "fixture/issue-workflow/nested/data.txt",
  "fixture/issue-workflow/plugin.json",
  "runtime/traceSchema",
];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("eval contract source loader", () => {
  it("loads the explicit executable module and recursive fixture key set in sorted order", async () => {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const sources = await loadEvalContractSources(repositoryRoot);

    expect(Object.keys(sources)).toEqual(expectedRepositoryKeys);
    expect(sources["eval/scenarios"])
      .toBe(`base64:${(await fs.readFile(
        path.join(repositoryRoot, "src", "eval", "scenarios.ts"),
      )).toString("base64")}`);
    expect(sources["fixture/issue-workflow/skills/triage/SKILL.md"])
      .toBe(`base64:${(await fs.readFile(
        path.join(repositoryRoot, "examples", "plugins", "issue-workflow", "skills", "triage", "SKILL.md"),
      )).toString("base64")}`);
  });

  it.each(executableExtensions)("selects only the executing module's %s siblings", async (extension) => {
    const tree = await createSyntheticContractTree(extension);
    const otherExtension = extension === ".ts" ? ".js" : ".ts";
    await writeSyntheticModules(tree.evalDirectory, otherExtension, "wrong-extension");

    const sources = await loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href, tree.root);

    expect(Object.keys(sources)).toEqual(expectedSyntheticKeys);
    expect(sources["eval/bootstrap"])
      .toBe(`base64:${Buffer.from(`selected:${extension}:eval/bootstrap\n`).toString("base64")}`);
    expect(sources["runtime/traceSchema"])
      .toBe(`base64:${Buffer.from(`selected:${extension}:runtime/traceSchema\n`).toString("base64")}`);
    expect(Object.values(sources).join("\n")).not.toContain("wrong-extension");
  });

  it("uses fixture bytes from the runtime repository rather than the executable module repository", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository("runtime-v1\n");
    const moduleUrl = pathToFileURL(codeTree.modulePath).href;

    const initial = identity(await loadEvalContractSourcesFrom(moduleUrl, runtimeTree.root));
    await fs.writeFile(path.join(codeTree.fixtureRoot, "plugin.json"), "code-tree-mutated\n", "utf8");
    const codeFixtureChanged = identity(await loadEvalContractSourcesFrom(moduleUrl, runtimeTree.root));
    await fs.writeFile(path.join(runtimeTree.fixtureRoot, "plugin.json"), "runtime-v2\n", "utf8");
    const runtimeFixtureChanged = identity(await loadEvalContractSourcesFrom(moduleUrl, runtimeTree.root));

    expect(codeFixtureChanged).toEqual(initial);
    expect(runtimeFixtureChanged.suiteFingerprint).not.toBe(initial.suiteFingerprint);
  });

  it("rejects a runtime repository that does not contain the expected fixture tree", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const invalidRuntimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-invalid-runtime-"));
    tempRoots.push(invalidRuntimeRoot);

    await expect(loadEvalContractSourcesFrom(pathToFileURL(codeTree.modulePath).href, invalidRuntimeRoot))
      .rejects.toThrow(/runtime repository.*issue-workflow|fixture root.*directory/i);
  });

  it("preserves invalid UTF-8 bytes without replacement-character collisions", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository(Buffer.from([0x80]));
    const moduleUrl = pathToFileURL(codeTree.modulePath).href;

    const firstSources = await loadEvalContractSourcesFrom(moduleUrl, runtimeTree.root);
    await fs.writeFile(path.join(runtimeTree.fixtureRoot, "plugin.json"), Buffer.from([0x81]));
    const secondSources = await loadEvalContractSourcesFrom(moduleUrl, runtimeTree.root);

    expect(firstSources["fixture/issue-workflow/plugin.json"]).toBe("base64:gA==");
    expect(secondSources["fixture/issue-workflow/plugin.json"]).toBe("base64:gQ==");
    expect(identity(secondSources).suiteFingerprint).not.toBe(identity(firstSources).suiteFingerprint);
  });

  it("rejects a symlinked fixture root before reading it", async () => {
    const tree = await createSyntheticContractTree(".ts");
    const external = path.join(tree.root, "external-fixture");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "secret.txt"), "must-not-read\n", "utf8");
    await fs.rm(tree.fixtureRoot, { recursive: true });
    await fs.symlink(external, tree.fixtureRoot, "dir");

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href, tree.root))
      .rejects.toThrow(/fixture root.*symbolic link/i);
  });

  it("rejects symlinked fixture directories before traversal", async () => {
    const tree = await createSyntheticContractTree(".ts");
    const external = path.join(tree.root, "external-directory");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "secret.txt"), "must-not-read\n", "utf8");
    await fs.symlink(external, path.join(tree.fixtureRoot, "linked-directory"), "dir");

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href, tree.root))
      .rejects.toThrow(/fixture entry.*symbolic link/i);
  });

  it("rejects symlinked fixture files before reading them", async () => {
    const tree = await createSyntheticContractTree(".ts");
    const external = path.join(tree.root, "external-file.txt");
    await fs.writeFile(external, "must-not-read\n", "utf8");
    await fs.symlink(external, path.join(tree.fixtureRoot, "linked-file.txt"), "file");

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href, tree.root))
      .rejects.toThrow(/fixture entry.*symbolic link/i);
  });

  it("rejects a symlinked ancestor in the runtime fixture path", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository("runtime fixture\n");
    const externalPlugins = path.join(runtimeTree.root, "external-plugins");
    await fs.rename(path.join(runtimeTree.root, "examples", "plugins"), externalPlugins);
    await fs.symlink(externalPlugins, path.join(runtimeTree.root, "examples", "plugins"), "dir");

    await expect(loadEvalContractSourcesFrom(pathToFileURL(codeTree.modulePath).href, runtimeTree.root))
      .rejects.toThrow(/fixture.*ancestor|physical directory|symbolic link/i);
  });

  it("rejects a symlinked ancestor in the executable module path", async () => {
    const tree = await createSyntheticContractTree(".ts");
    const runtimeDirectory = path.join(tree.evalDirectory, "..", "runtime");
    const externalRuntime = path.join(tree.root, "external-runtime");
    await fs.rename(runtimeDirectory, externalRuntime);
    await fs.symlink(externalRuntime, runtimeDirectory, "dir");

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href, tree.root))
      .rejects.toThrow(/module.*ancestor|physical directory|symbolic link/i);
  });

  it("rejects a file whose pathname identity changes after descriptor open", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository("runtime fixture\n");
    const external = path.join(runtimeTree.root, "external-file.txt");
    await fs.writeFile(external, "outside bytes\n", "utf8");
    let swapped = false;

    await expect(loadEvalContractSourcesFrom(
      pathToFileURL(codeTree.modulePath).href,
      runtimeTree.root,
      {
        async afterFileOpen({ key, pathname }) {
          if (key !== "fixture/issue-workflow/plugin.json" || swapped) {
            return;
          }
          swapped = true;
          await fs.rename(pathname, `${pathname}.original`);
          await fs.symlink(external, pathname, "file");
        },
      },
    )).rejects.toThrow(/changed while reading|identity mismatch/i);
    expect(swapped).toBe(true);
  });

  it("rejects an in-place same-inode overwrite after the first descriptor read", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository("runtime fixture\n");
    const pluginPath = path.join(runtimeTree.fixtureRoot, "plugin.json");
    const before = await fs.stat(pluginPath, { bigint: true });
    let overwritten = false;

    await expect(loadEvalContractSourcesFrom(
      pathToFileURL(codeTree.modulePath).href,
      runtimeTree.root,
      {
        async afterFirstFileRead({ key, pathname }) {
          if (key !== "fixture/issue-workflow/plugin.json" || overwritten) {
            return;
          }
          overwritten = true;
          await fs.writeFile(pathname, "mutated fixture\n", "utf8");
        },
      },
    )).rejects.toThrow(/content|metadata|unstable|changed while reading/i);

    expect(overwritten).toBe(true);
    expect((await fs.stat(pluginPath, { bigint: true })).ino).toBe(before.ino);
  });

  it("rejects metadata drift even when descriptor bytes stay unchanged", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository("runtime fixture\n");
    let metadataChanged = false;

    await expect(loadEvalContractSourcesFrom(
      pathToFileURL(codeTree.modulePath).href,
      runtimeTree.root,
      {
        async afterFirstFileRead({ key, pathname }) {
          if (key !== "fixture/issue-workflow/plugin.json" || metadataChanged) {
            return;
          }
          metadataChanged = true;
          await fs.utimes(pathname, new Date(1_000), new Date(2_000));
        },
      },
    )).rejects.toThrow(/metadata|unstable|changed while reading/i);
    expect(metadataChanged).toBe(true);
  });

  it("rejects fixture additions made after the initial directory snapshot", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository("runtime fixture\n");
    const emptyDirectory = path.join(runtimeTree.fixtureRoot, "empty");
    await fs.mkdir(emptyDirectory);
    let added = false;

    await expect(loadEvalContractSourcesFrom(
      pathToFileURL(codeTree.modulePath).href,
      runtimeTree.root,
      {
        async afterDirectorySnapshot({ pathname }) {
          if (pathname !== emptyDirectory || added) {
            return;
          }
          added = true;
          await fs.writeFile(path.join(pathname, "added.txt"), "late addition\n", "utf8");
        },
      },
    )).rejects.toThrow(/directory.*changed|entry snapshot|unstable/i);
    expect(added).toBe(true);
  });

  it("compares unsafe filesystem identities as bigint without precision loss", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository("runtime fixture\n");
    const unsafe = 9_007_199_254_740_992n;

    await expect(loadEvalContractSourcesFrom(
      pathToFileURL(codeTree.modulePath).href,
      runtimeTree.root,
      {
        adjustFileMetadata({ key, metadata, phase }) {
          if (key !== "fixture/issue-workflow/plugin.json") {
            return metadata;
          }
          if (phase.startsWith("descriptor")) {
            return { ...metadata, dev: unsafe + 1n };
          }
          return { ...metadata, dev: unsafe };
        },
      },
    )).rejects.toThrow(/identity|metadata/i);
  });

  it("includes legal hidden fixture names beginning with two dots", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository("runtime fixture\n");
    await fs.writeFile(path.join(runtimeTree.fixtureRoot, "..config"), "hidden config\n", "utf8");

    const sources = await loadEvalContractSourcesFrom(
      pathToFileURL(codeTree.modulePath).href,
      runtimeTree.root,
    );

    expect(sources["fixture/issue-workflow/..config"])
      .toBe(`base64:${Buffer.from("hidden config\n").toString("base64")}`);
  });

  it("sorts Unicode fixture keys locale-independently without collapsing equivalent names", async () => {
    const codeTree = await createSyntheticContractTree(".ts");
    const runtimeTree = await createRuntimeRepository("runtime fixture\n");
    await fs.writeFile(path.join(runtimeTree.fixtureRoot, "z.txt"), "z\n", "utf8");
    await fs.writeFile(path.join(runtimeTree.fixtureRoot, "ä.txt"), "precomposed\n", "utf8");
    await fs.writeFile(path.join(runtimeTree.fixtureRoot, "a\u0308.txt"), "decomposed\n", "utf8");

    const sources = await loadEvalContractSourcesFrom(
      pathToFileURL(codeTree.modulePath).href,
      runtimeTree.root,
    );

    expect(Object.keys(sources).filter((key) => key.startsWith("fixture/"))).toEqual([
      "fixture/issue-workflow/a\u0308.txt",
      "fixture/issue-workflow/nested/data.txt",
      "fixture/issue-workflow/plugin.json",
      "fixture/issue-workflow/z.txt",
      "fixture/issue-workflow/ä.txt",
    ]);
  });

  it("rejects a missing expected contract module", async () => {
    const tree = await createSyntheticContractTree(".ts");
    await fs.rm(path.join(tree.evalDirectory, "runner.ts"));

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href, tree.root))
      .rejects.toThrow(/eval\/runner.*regular file/i);
  });

  it("rejects a non-regular expected contract module", async () => {
    const tree = await createSyntheticContractTree(".ts");
    const policyPath = path.join(tree.evalDirectory, "policy.ts");
    await fs.rm(policyPath);
    await fs.mkdir(policyPath);

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href, tree.root))
      .rejects.toThrow(/eval\/policy.*regular file/i);
  });
});

interface SyntheticContractTree {
  evalDirectory: string;
  fixtureRoot: string;
  modulePath: string;
  root: string;
}

interface RuntimeRepository {
  fixtureRoot: string;
  root: string;
}

async function createRuntimeRepository(pluginBytes: Buffer | string): Promise<RuntimeRepository> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-runtime-root-"));
  tempRoots.push(root);
  const fixtureRoot = path.join(root, "examples", "plugins", "issue-workflow");
  await fs.mkdir(path.join(fixtureRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "plugin.json"), pluginBytes);
  await fs.writeFile(path.join(fixtureRoot, "nested", "data.txt"), "recursive fixture\n", "utf8");
  return { fixtureRoot, root };
}

function identity(contractSources: Record<string, string>) {
  return buildExperimentIdentity({
    contractSources,
    endpoint: "https://api.openai.com/v1",
    model: "gpt-test",
    providerId: "openai",
    requestSettings: { reasoning: { effort: "low" } },
    scenarios: [{ id: "governed-read-only", manifest: { graderVersion: 1 } }],
  });
}

async function createSyntheticContractTree(extension: ".js" | ".ts"): Promise<SyntheticContractTree> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-contract-loader-"));
  tempRoots.push(root);
  const outputDirectory = extension === ".ts" ? "src" : "dist";
  const evalDirectory = path.join(root, outputDirectory, "eval");
  const fixtureRoot = path.join(root, "examples", "plugins", "issue-workflow");
  await writeSyntheticModules(evalDirectory, extension, "selected");
  await fs.mkdir(path.join(fixtureRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "plugin.json"), "{\"enabled\":true}\n", "utf8");
  await fs.writeFile(path.join(fixtureRoot, "nested", "data.txt"), "recursive fixture\n", "utf8");
  return {
    evalDirectory,
    fixtureRoot,
    modulePath: path.join(evalDirectory, `contract${extension}`),
    root,
  };
}

async function writeSyntheticModules(
  evalDirectory: string,
  extension: ".js" | ".ts",
  prefix: string,
): Promise<void> {
  const modulePaths = [
    ["bootstrap", "eval/bootstrap"],
    ["c17c", "eval/c17c"],
    ["canonicalSuite", "eval/canonicalSuite"],
    ["contract", "eval/contract"],
    ["evidence", "eval/evidence"],
    ["fixture", "eval/fixture"],
    ["policy", "eval/policy"],
    ["runner", "eval/runner"],
    ["scenarios", "eval/scenarios"],
  ] as const;
  await fs.mkdir(evalDirectory, { recursive: true });
  await fs.mkdir(path.join(evalDirectory, "..", "runtime"), { recursive: true });
  await Promise.all([
    ...modulePaths.map(([basename, key]) => fs.writeFile(
      path.join(evalDirectory, `${basename}${extension}`),
      `${prefix}:${extension}:${key}\n`,
      "utf8",
    )),
    fs.writeFile(
      path.join(evalDirectory, "..", "runtime", `traceSchema${extension}`),
      `${prefix}:${extension}:runtime/traceSchema\n`,
      "utf8",
    ),
  ]);
}
