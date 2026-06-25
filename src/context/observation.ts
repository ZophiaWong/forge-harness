import type { ToolResult, ToolStatus } from "../tools/types.js";

export interface Observation {
  content: string;
  metadata?: Record<string, unknown>;
  status: ToolStatus;
  summary: string;
  toolName: string;
}

export function createToolObservation(result: ToolResult): Observation {
  return {
    content: result.content,
    metadata: result.metadata,
    status: result.status,
    summary: readObservationSummary(result),
    toolName: result.toolName,
  };
}

function readObservationSummary(result: ToolResult): string {
  const summary = result.metadata?.observationSummary;

  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary;
  }

  return `${result.toolName} ${result.status}`;
}
