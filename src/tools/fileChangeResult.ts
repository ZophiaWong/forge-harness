import { DEFAULT_TEXT_OUTPUT_CHAR_LIMIT, truncateText } from "./text.js";

export type FileChangeAction = "created" | "edited" | "overwritten";

export interface FileChangeResultInput {
  action: FileChangeAction;
  afterText: string;
  beforeText: string;
  outputCharLimit?: number;
  path: string;
}

export function formatFileChangeResult(input: FileChangeResultInput): string {
  const beforeLines = splitDisplayLines(input.beforeText);
  const afterLines = splitDisplayLines(input.afterText);
  const diff = formatLineDiff(beforeLines, afterLines);
  const output = [
    `path: ${input.path}`,
    `action: ${input.action}`,
    `before_lines: ${beforeLines.length}`,
    `after_lines: ${afterLines.length}`,
    "diff:",
    diff || "(no textual changes)",
  ].join("\n");

  return truncateText(output, input.outputCharLimit ?? DEFAULT_TEXT_OUTPUT_CHAR_LIMIT);
}

function splitDisplayLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function formatLineDiff(beforeLines: string[], afterLines: string[]): string {
  let prefixLength = 0;

  while (
    prefixLength < beforeLines.length &&
    prefixLength < afterLines.length &&
    beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;

  while (
    suffixLength < beforeLines.length - prefixLength &&
    suffixLength < afterLines.length - prefixLength &&
    beforeLines[beforeLines.length - 1 - suffixLength] === afterLines[afterLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const output: string[] = [];

  for (const line of beforeLines.slice(0, prefixLength)) {
    output.push(` ${line}`);
  }

  for (const line of beforeLines.slice(prefixLength, beforeLines.length - suffixLength)) {
    output.push(`-${line}`);
  }

  for (const line of afterLines.slice(prefixLength, afterLines.length - suffixLength)) {
    output.push(`+${line}`);
  }

  const suffixStart = suffixLength === 0 ? beforeLines.length : beforeLines.length - suffixLength;

  for (const line of beforeLines.slice(suffixStart)) {
    output.push(` ${line}`);
  }

  return output.join("\n");
}
