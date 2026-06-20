export const DEFAULT_TEXT_OUTPUT_CHAR_LIMIT = 20_000;

export function truncateText(output: string, limit: number): string {
  if (limit < 0) {
    throw new Error("output limit must be non-negative.");
  }

  if (output.length <= limit) {
    return output;
  }

  const omitted = output.length - limit;
  return `${output.slice(0, limit)}\n[truncated ${omitted} chars]`;
}
