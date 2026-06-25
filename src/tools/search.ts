import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { CwdPathResult } from "./pathBoundary.js";

export const MAX_SEARCH_MATCHES = 20;
export const MAX_MATCH_LINE_CHARS = 240;

export const SKIPPED_SEARCH_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

export interface SearchFile {
  absolutePath: string;
  relativePath: string;
}

export interface WalkFilesResult {
  files: SearchFile[];
}

export async function walkSearchFiles(root: CwdPathResult): Promise<WalkFilesResult> {
  const stat = await fs.stat(root.absolutePath);

  if (stat.isFile()) {
    return {
      files: [
        {
          absolutePath: root.absolutePath,
          relativePath: root.relativePath,
        },
      ],
    };
  }

  if (!stat.isDirectory()) {
    return {
      files: [],
    };
  }

  const files: SearchFile[] = [];
  await collectFiles(root.absolutePath, root.relativePath, files);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return { files };
}

export async function walkSearchDirectory(root: CwdPathResult): Promise<WalkFilesResult> {
  const files: SearchFile[] = [];
  await collectFiles(root.absolutePath, root.relativePath, files);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return { files };
}

export async function readUtf8File(file: SearchFile): Promise<{ text: string } | { skipped: true }> {
  const buffer = await fs.readFile(file.absolutePath);

  if (!isUtf8(buffer)) {
    return { skipped: true };
  }

  return { text: buffer.toString("utf8") };
}

export function formatQuoted(value: string): string {
  return JSON.stringify(value);
}

export function formatSearchSummary(toolName: "find" | "grep", count: number, query: string): string {
  if (toolName === "find") {
    return `find found ${count} ${count === 1 ? "file" : "files"} for ${formatQuoted(query)}`;
  }

  return `grep found ${count} ${count === 1 ? "match" : "matches"} for ${formatQuoted(query)}`;
}

export function truncateMatchLine(line: string): string {
  if (line.length <= MAX_MATCH_LINE_CHARS) {
    return line;
  }

  const omitted = line.length - MAX_MATCH_LINE_CHARS;
  return `${line.slice(0, MAX_MATCH_LINE_CHARS)} [truncated ${omitted} chars]`;
}

async function collectFiles(absoluteDirectory: string, relativeDirectory: string, files: SearchFile[]): Promise<void> {
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  const sorted = entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sorted) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const relativePath = relativeDirectory === "." ? entry.name : path.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_SEARCH_DIRECTORIES.has(entry.name)) {
        await collectFiles(absolutePath, relativePath, files);
      }

      continue;
    }

    if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
    }
  }
}
