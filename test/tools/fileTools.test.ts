import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDefaultToolRuntime } from "../../src/tools/defaultRuntime.js";

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-file-tools-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("edit tool", () => {
  it("replaces exactly one text match and returns a diff-like result", async () => {
    const cwd = await createTempProject();
    await fs.writeFile(path.join(cwd, "sample.txt"), "alpha\nold line\nomega\n", "utf8");
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        newText: "new line",
        oldText: "old line",
        path: "sample.txt",
      }),
      name: "edit",
    });

    await expect(fs.readFile(path.join(cwd, "sample.txt"), "utf8")).resolves.toBe("alpha\nnew line\nomega\n");
    expect(result.status).toBe("completed");
    expect(result.toolName).toBe("edit");
    expect(result.content).toContain("path: sample.txt");
    expect(result.content).toContain("action: edited");
    expect(result.content).toContain("diff:");
    expect(result.content).toContain("-old line");
    expect(result.content).toContain("+new line");
  });

  it("blocks paths outside cwd", async () => {
    const cwd = await createTempProject();
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        newText: "new",
        oldText: "old",
        path: "../escape.txt",
      }),
      name: "edit",
    });

    expect(result).toEqual({
      content: 'blocked_reason: path "../escape.txt" is outside the current working directory',
      status: "blocked",
      toolName: "edit",
    });
  });

  it("fails when oldText is missing", async () => {
    const cwd = await createTempProject();
    await fs.writeFile(path.join(cwd, "sample.txt"), "alpha\nomega\n", "utf8");
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        newText: "new line",
        oldText: "old line",
        path: "sample.txt",
      }),
      name: "edit",
    });

    expect(result).toEqual({
      content: 'failed_reason: oldText was not found in path "sample.txt"',
      status: "failed",
      toolName: "edit",
    });
  });

  it("fails when oldText matches more than once", async () => {
    const cwd = await createTempProject();
    await fs.writeFile(path.join(cwd, "sample.txt"), "same\nmiddle\nsame\n", "utf8");
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        newText: "changed",
        oldText: "same",
        path: "sample.txt",
      }),
      name: "edit",
    });

    expect(result).toEqual({
      content: 'failed_reason: oldText matched 2 times in path "sample.txt"; expected exactly one match',
      status: "failed",
      toolName: "edit",
    });
  });

  it("reports malformed arguments without throwing", async () => {
    const cwd = await createTempProject();
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: "{bad json",
      name: "edit",
    });

    expect(result).toEqual({
      content: "failed_reason: edit arguments must be JSON with non-empty string path and oldText fields, and a string newText field",
      status: "failed",
      toolName: "edit",
    });
  });

  it("fails for directories", async () => {
    const cwd = await createTempProject();
    const runtime = createDefaultToolRuntime({ cwd });

    await expect(
      runtime.execute({
        arguments: JSON.stringify({
          newText: "new",
          oldText: "old",
          path: ".",
        }),
        name: "edit",
      }),
    ).resolves.toEqual({
      content: 'failed_reason: path "." is a directory',
      status: "failed",
      toolName: "edit",
    });
  });

  it("fails for non-UTF-8 files", async () => {
    const cwd = await createTempProject();
    await fs.writeFile(path.join(cwd, "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    const runtime = createDefaultToolRuntime({ cwd });

    await expect(
      runtime.execute({
        arguments: JSON.stringify({
          newText: "new",
          oldText: "old",
          path: "binary.bin",
        }),
        name: "edit",
      }),
    ).resolves.toEqual({
      content: 'failed_reason: path "binary.bin" is not valid UTF-8 text',
      status: "failed",
      toolName: "edit",
    });
  });
});

describe("write tool", () => {
  it("creates a text file and returns a diff-like result", async () => {
    const cwd = await createTempProject();
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        content: "hello\nworld\n",
        path: "created.txt",
      }),
      name: "write",
    });

    await expect(fs.readFile(path.join(cwd, "created.txt"), "utf8")).resolves.toBe("hello\nworld\n");
    expect(result.status).toBe("completed");
    expect(result.toolName).toBe("write");
    expect(result.content).toContain("path: created.txt");
    expect(result.content).toContain("action: created");
    expect(result.content).toContain("diff:");
    expect(result.content).toContain("+hello");
    expect(result.content).toContain("+world");
  });

  it("overwrites an existing text file and returns a diff-like result", async () => {
    const cwd = await createTempProject();
    await fs.writeFile(path.join(cwd, "sample.txt"), "old\n", "utf8");
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        content: "new\n",
        path: "sample.txt",
      }),
      name: "write",
    });

    await expect(fs.readFile(path.join(cwd, "sample.txt"), "utf8")).resolves.toBe("new\n");
    expect(result.status).toBe("completed");
    expect(result.content).toContain("action: overwritten");
    expect(result.content).toContain("-old");
    expect(result.content).toContain("+new");
  });

  it("blocks paths outside cwd", async () => {
    const cwd = await createTempProject();
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        content: "escape",
        path: "../escape.txt",
      }),
      name: "write",
    });

    expect(result).toEqual({
      content: 'blocked_reason: path "../escape.txt" is outside the current working directory',
      status: "blocked",
      toolName: "write",
    });
  });

  it("fails when the parent directory is missing", async () => {
    const cwd = await createTempProject();
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: JSON.stringify({
        content: "hello",
        path: "missing/file.txt",
      }),
      name: "write",
    });

    expect(result).toEqual({
      content: 'failed_reason: parent directory for path "missing/file.txt" does not exist',
      status: "failed",
      toolName: "write",
    });
  });

  it("reports malformed arguments without throwing", async () => {
    const cwd = await createTempProject();
    const runtime = createDefaultToolRuntime({ cwd });

    const result = await runtime.execute({
      arguments: "{bad json",
      name: "write",
    });

    expect(result).toEqual({
      content: "failed_reason: write arguments must be JSON with non-empty string path and string content fields",
      status: "failed",
      toolName: "write",
    });
  });
});
