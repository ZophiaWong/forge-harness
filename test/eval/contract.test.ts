import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadEvalContractSources,
  loadEvalContractSourcesFrom,
} from "../../src/eval/contract.js";

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
    const sources = await loadEvalContractSources();
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

    expect(Object.keys(sources)).toEqual(expectedRepositoryKeys);
    expect(sources["eval/scenarios"])
      .toBe(await fs.readFile(path.join(repositoryRoot, "src", "eval", "scenarios.ts"), "utf8"));
    expect(sources["fixture/issue-workflow/skills/triage/SKILL.md"])
      .toBe(await fs.readFile(
        path.join(repositoryRoot, "examples", "plugins", "issue-workflow", "skills", "triage", "SKILL.md"),
        "utf8",
      ));
  });

  it.each(executableExtensions)("selects only the executing module's %s siblings", async (extension) => {
    const tree = await createSyntheticContractTree(extension);
    const otherExtension = extension === ".ts" ? ".js" : ".ts";
    await writeSyntheticModules(tree.evalDirectory, otherExtension, "wrong-extension");

    const sources = await loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href);

    expect(Object.keys(sources)).toEqual(expectedSyntheticKeys);
    expect(sources["eval/bootstrap"]).toBe(`selected:${extension}:eval/bootstrap\n`);
    expect(sources["runtime/traceSchema"]).toBe(`selected:${extension}:runtime/traceSchema\n`);
    expect(Object.values(sources).join("\n")).not.toContain("wrong-extension");
  });

  it("rejects a symlinked fixture root before reading it", async () => {
    const tree = await createSyntheticContractTree(".ts");
    const external = path.join(tree.root, "external-fixture");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "secret.txt"), "must-not-read\n", "utf8");
    await fs.rm(tree.fixtureRoot, { recursive: true });
    await fs.symlink(external, tree.fixtureRoot, "dir");

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href))
      .rejects.toThrow(/fixture root.*symbolic link/i);
  });

  it("rejects symlinked fixture directories before traversal", async () => {
    const tree = await createSyntheticContractTree(".ts");
    const external = path.join(tree.root, "external-directory");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "secret.txt"), "must-not-read\n", "utf8");
    await fs.symlink(external, path.join(tree.fixtureRoot, "linked-directory"), "dir");

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href))
      .rejects.toThrow(/fixture entry.*symbolic link/i);
  });

  it("rejects symlinked fixture files before reading them", async () => {
    const tree = await createSyntheticContractTree(".ts");
    const external = path.join(tree.root, "external-file.txt");
    await fs.writeFile(external, "must-not-read\n", "utf8");
    await fs.symlink(external, path.join(tree.fixtureRoot, "linked-file.txt"), "file");

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href))
      .rejects.toThrow(/fixture entry.*symbolic link/i);
  });

  it("rejects a missing expected contract module", async () => {
    const tree = await createSyntheticContractTree(".ts");
    await fs.rm(path.join(tree.evalDirectory, "runner.ts"));

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href))
      .rejects.toThrow(/eval\/runner.*regular file/i);
  });

  it("rejects a non-regular expected contract module", async () => {
    const tree = await createSyntheticContractTree(".ts");
    const policyPath = path.join(tree.evalDirectory, "policy.ts");
    await fs.rm(policyPath);
    await fs.mkdir(policyPath);

    await expect(loadEvalContractSourcesFrom(pathToFileURL(tree.modulePath).href))
      .rejects.toThrow(/eval\/policy.*regular file/i);
  });
});

interface SyntheticContractTree {
  evalDirectory: string;
  fixtureRoot: string;
  modulePath: string;
  root: string;
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
