import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEvalFixture,
  readEvalGitSnapshot,
} from "../../src/eval/fixture.js";
import { getEvalScenario } from "../../src/eval/scenarios.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("eval Git fixtures", () => {
  it("creates an independent committed repository with ignored runtime state", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-fixture-"));
    tempRoots.push(attemptRoot);

    const fixture = await createEvalFixture({
      attemptRoot,
      repositoryRoot: process.cwd(),
      scenario: getEvalScenario("governed-read-only"),
    });

    expect(await fs.readFile(path.join(fixture.cwd, "facts.txt"), "utf8")).toContain(
      "RELEASE_CHANNEL=stable",
    );
    expect(await fs.readFile(path.join(fixture.cwd, "facts.txt"), "utf8")).toContain(
      "write owned.txt",
    );
    expect((await readEvalGitSnapshot(fixture.cwd)).statusEntries).toEqual([]);
    await fs.mkdir(path.join(fixture.cwd, ".forge", "sessions", "private"), { recursive: true });
    await fs.writeFile(path.join(fixture.cwd, ".forge", "sessions", "private", "trace.jsonl"), "raw");
    expect((await readEvalGitSnapshot(fixture.cwd)).statusEntries).toEqual([]);
  });

  it("binds only the c17c fixture to the repository's local issue-workflow plugin", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-c17c-"));
    tempRoots.push(attemptRoot);

    const fixture = await createEvalFixture({
      attemptRoot,
      repositoryRoot: process.cwd(),
      scenario: getEvalScenario("c17c-team-completion"),
    });
    const config = JSON.parse(
      await fs.readFile(path.join(fixture.cwd, ".forge", "plugins.json"), "utf8"),
    ) as { plugins: Array<{ path: string }> };

    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0]?.path).toBe(path.join(process.cwd(), "examples", "plugins", "issue-workflow"));
    expect((await readEvalGitSnapshot(fixture.cwd)).statusEntries).toEqual([]);
  });
});
