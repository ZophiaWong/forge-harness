import type { ToolResult } from "./types.js";

export function formatToolResultForModel(result: ToolResult): string {
  return [`tool: ${result.toolName}`, `status: ${result.status}`, result.content].join("\n");
}
