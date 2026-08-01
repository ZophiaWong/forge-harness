import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ignoredDirectories = new Set([
  ".git",
  ".forge",
  ".superpowers",
  ".worktrees",
  "node_modules",
]);

function parseRoot(args) {
  if (args.length === 0) {
    return process.cwd();
  }

  if (args.length === 2 && args[0] === "--root") {
    return resolve(args[1]);
  }

  throw new Error("usage: node scripts/check-doc-links.mjs [--root <path>]");
}

async function collectMarkdownFiles(root) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        continue;
      }

      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        files.push(path);
      }
    }
  }

  await visit(root);
  return files;
}

async function targetExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function stripFencedCode(source) {
  let fenceCharacter = "";
  let fenceLength = 0;

  return source
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(`{3,}|~{3,})/);
      if (match) {
        const marker = match[1];
        if (!fenceCharacter) {
          fenceCharacter = marker[0];
          fenceLength = marker.length;
        } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
          fenceCharacter = "";
          fenceLength = 0;
        }
        return "";
      }
      return fenceCharacter ? "" : line;
    })
    .join("\n");
}

export async function runDocLinkCheck(options) {
  const root = parseRoot(options.args);
  const files = await collectMarkdownFiles(root);
  const missing = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)\n]+)\)/g;

  for (const file of files) {
    const source = stripFencedCode(await readFile(file, "utf8"));

    for (const match of source.matchAll(linkPattern)) {
      const sourceTarget = match[1].trim();
      const rawTarget =
        sourceTarget.startsWith("<") && sourceTarget.endsWith(">")
          ? sourceTarget.slice(1, -1)
          : sourceTarget;
      if (!rawTarget || rawTarget.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) {
        continue;
      }

      const target = rawTarget.split("#", 1)[0];
      const absoluteTarget = resolve(dirname(file), target);
      if (!(await targetExists(absoluteTarget))) {
        missing.push({
          file: relative(root, file).split("\\").join("/"),
          target: sourceTarget,
        });
      }
    }
  }

  if (missing.length > 0) {
    for (const item of missing) {
      options.stderr.write(`${item.file}: missing local target ${item.target}\n`);
    }
    return 1;
  }

  const noun = files.length === 1 ? "file" : "files";
  options.stdout.write(`Checked ${files.length} Markdown ${noun}: all local links resolve.\n`);
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    process.exitCode = await runDocLinkCheck({
      args: process.argv.slice(2),
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "documentation link check failed"}\n`,
    );
    process.exitCode = 1;
  }
}
