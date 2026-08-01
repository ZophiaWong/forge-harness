import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The maintenance CLI is intentionally plain ESM so it runs before build.
import { runDocLinkCheck } from "../../scripts/check-doc-links.mjs";

const fixtureRoots: string[] = [];

async function createFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "forge-doc-links-"));
  fixtureRoots.push(root);
  return root;
}

async function runChecker(root: string) {
  let stdout = "";
  let stderr = "";
  const status = await runDocLinkCheck({
    args: ["--root", root],
    stderr: { write: (chunk: string) => (stderr += chunk) },
    stdout: { write: (chunk: string) => (stdout += chunk) },
  });
  return { status, stderr, stdout };
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("documentation link checker", () => {
  it("accepts an existing relative Markdown target", async () => {
    const root = await createFixture();
    await mkdir(resolve(root, "docs"));
    await writeFile(resolve(root, "README.md"), "Read the [guide](docs/guide.md).\n");
    await writeFile(resolve(root, "docs/guide.md"), "# Guide\n");

    const result = await runChecker(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Checked 2 Markdown files: all local links resolve.\n");
    expect(result.stderr).toBe("");
  });

  it("reports a missing local target with a stable source path", async () => {
    const root = await createFixture();
    await writeFile(resolve(root, "README.md"), "Read the [missing guide](docs/missing.md).\n");

    const result = await runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "README.md: missing local target docs/missing.md\n",
    );
  });

  it("accepts supported fragments, images, external URLs, and paths with spaces", async () => {
    const root = await createFixture();
    await mkdir(resolve(root, "assets"));
    await mkdir(resolve(root, "docs"));
    await writeFile(
      resolve(root, "README.md"),
      [
        "# Overview",
        "",
        "[Local section](#overview)",
        "[Guide section](docs/guide.md#details)",
        "![Diagram](assets/diagram.svg)",
        "[External](https://example.com/reference)",
        "[Spaced path](<docs/My Guide.md#notes>)",
        "",
      ].join("\n"),
    );
    await writeFile(resolve(root, "assets/diagram.svg"), "<svg></svg>\n");
    await writeFile(resolve(root, "docs/guide.md"), "# Details\n");
    await writeFile(resolve(root, "docs/My Guide.md"), "# Notes\n");

    const result = await runChecker(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Checked 3 Markdown files: all local links resolve.\n");
    expect(result.stderr).toBe("");
  });

  it("ignores generated worktrees and local tool state", async () => {
    const root = await createFixture();
    await mkdir(resolve(root, ".superpowers"));
    await mkdir(resolve(root, ".worktrees"));
    await writeFile(resolve(root, "README.md"), "# Current checkout\n");
    await writeFile(
      resolve(root, ".superpowers/plan.md"),
      "[stale](missing-plan-target.md)\n",
    );
    await writeFile(
      resolve(root, ".worktrees/other.md"),
      "[stale](missing-worktree-target.md)\n",
    );

    const result = await runChecker(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Checked 1 Markdown file: all local links resolve.\n");
    expect(result.stderr).toBe("");
  });

  it("ignores Markdown-shaped output inside fenced code blocks", async () => {
    const root = await createFixture();
    await writeFile(
      resolve(root, "README.md"),
      [
        "# Example output",
        "",
        "```text",
        "[Historical result](docs/not-a-current-link.md)",
        "```",
        "",
      ].join("\n"),
    );

    const result = await runChecker(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Checked 1 Markdown file: all local links resolve.\n");
    expect(result.stderr).toBe("");
  });
});
