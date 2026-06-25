import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDefaultToolRuntime } from "../../src/tools/defaultRuntime.js";

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-search-tools-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("grep tool", () => {
  it("finds literal case-sensitive text matches with path and line numbers", async () => {
    const cwd = await createTempProject();
    await fs.mkdir(path.join(cwd, "docs"));
    await fs.writeFile(path.join(cwd, "docs", "guide.md"), "Context Projection\ncontext projection\n", "utf8");
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({ path: "docs", query: "Context Projection" }),
      name: "grep",
    });

    expect(result.status).toBe("completed");
    expect(result.toolName).toBe("grep");
    expect(result.metadata?.observationSummary).toBe('grep found 1 match for "Context Projection"');
    expect(result.content).toContain('query: "Context Projection"');
    expect(result.content).toContain("matches_returned: 1");
    expect(result.content).toContain("matches_total: 1");
    expect(result.content).toContain("docs/guide.md:1 | Context Projection");
    expect(result.content).not.toContain("docs/guide.md:2 | context projection");
  });

  it("caps projected matches at 20 and reports omitted matches", async () => {
    const cwd = await createTempProject();
    const lines = Array.from({ length: 25 }, (_, index) => `needle ${index + 1}`).join("\n");
    await fs.writeFile(path.join(cwd, "many.txt"), `${lines}\n`, "utf8");
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({ query: "needle" }),
      name: "grep",
    });

    expect(result.status).toBe("completed");
    expect(result.content).toContain("matches_returned: 20");
    expect(result.content).toContain("matches_total: 25");
    expect(result.content).toContain("omitted_matches: 5");
    expect(result.content).toContain("many.txt:20 | needle 20");
    expect(result.content).not.toContain("many.txt:21 | needle 21");
  });

  it("skips generated directories and non-UTF-8 files during recursive search", async () => {
    const cwd = await createTempProject();
    await fs.mkdir(path.join(cwd, "node_modules"));
    await fs.writeFile(path.join(cwd, "node_modules", "noise.txt"), "needle from dependency\n", "utf8");
    await fs.writeFile(path.join(cwd, "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    await fs.writeFile(path.join(cwd, "source.txt"), "needle from source\n", "utf8");
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({ query: "needle" }),
      name: "grep",
    });

    expect(result.status).toBe("completed");
    expect(result.content).toContain("source.txt:1 | needle from source");
    expect(result.content).not.toContain("node_modules/noise.txt");
    expect(result.content).toContain("skipped_binary_files: 1");
  });

  it("blocks paths outside cwd", async () => {
    const cwd = await createTempProject();
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({ path: "../outside", query: "needle" }),
      name: "grep",
    });

    expect(result).toEqual({
      content: 'blocked_reason: path "../outside" is outside the current working directory',
      metadata: {
        observationSummary: "grep blocked",
      },
      status: "blocked",
      toolName: "grep",
    });
  });

  it("reports malformed arguments without throwing", async () => {
    const cwd = await createTempProject();
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: "{bad json",
      name: "grep",
    });

    expect(result).toEqual({
      content: "failed_reason: grep arguments must be JSON with a non-empty string query field and optional string path field",
      metadata: {
        observationSummary: "grep failed",
      },
      status: "failed",
      toolName: "grep",
    });
  });
});

describe("find tool", () => {
  it("finds matching files by case-sensitive filename substring", async () => {
    const cwd = await createTempProject();
    await fs.mkdir(path.join(cwd, "docs"));
    await fs.writeFile(path.join(cwd, "docs", "c05-context-projection.md"), "# c05\n", "utf8");
    await fs.writeFile(path.join(cwd, "docs", "C05-notes.md"), "# uppercase\n", "utf8");
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({ path: "docs", query: "c05" }),
      name: "find",
    });

    expect(result.status).toBe("completed");
    expect(result.toolName).toBe("find");
    expect(result.metadata?.observationSummary).toBe('find found 1 file for "c05"');
    expect(result.content).toContain('query: "c05"');
    expect(result.content).toContain("matches_returned: 1");
    expect(result.content).toContain("matches_total: 1");
    expect(result.content).toContain("docs/c05-context-projection.md");
    expect(result.content).not.toContain("docs/C05-notes.md");
  });

  it("caps projected files at 20 and reports omitted files", async () => {
    const cwd = await createTempProject();
    await fs.mkdir(path.join(cwd, "docs"));
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        fs.writeFile(path.join(cwd, "docs", `c05-${String(index + 1).padStart(2, "0")}.md`), "# c05\n", "utf8"),
      ),
    );
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({ path: "docs", query: "c05" }),
      name: "find",
    });

    expect(result.status).toBe("completed");
    expect(result.content).toContain("matches_returned: 20");
    expect(result.content).toContain("matches_total: 25");
    expect(result.content).toContain("omitted_matches: 5");
    expect(result.content).toContain("docs/c05-20.md");
    expect(result.content).not.toContain("docs/c05-21.md");
  });

  it("returns failed when the search root is not a directory", async () => {
    const cwd = await createTempProject();
    await fs.writeFile(path.join(cwd, "file.txt"), "content\n", "utf8");
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({ path: "file.txt", query: "file" }),
      name: "find",
    });

    expect(result).toEqual({
      content: 'failed_reason: path "file.txt" is not a directory',
      metadata: {
        observationSummary: "find failed",
      },
      status: "failed",
      toolName: "find",
    });
  });
});
