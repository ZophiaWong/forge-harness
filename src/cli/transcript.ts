import type { PermissionDecision } from "../governance/types.js";
import type { RuntimeState } from "../runtime/state.js";

export function formatFunctionCallTranscript(
  round: number,
  toolName: string,
  argumentsText: string,
): string {
  return `[round ${round}] function_call: ${toolName} ${argumentsText}`;
}

export function formatPermissionDecisionTranscript(round: number, decision: PermissionDecision): string {
  return `[round ${round}] permission: ${decision.action} risk=${decision.risk} reason=${decision.reason}`;
}

export function formatSessionTranscript(sessionId: string, tracePath: string): string {
  return `[session] id=${sessionId} trace=${tracePath}`;
}

export function formatRuntimeStateTranscript(state: RuntimeState, round?: number): string {
  const parts = [`status=${state.status}`];

  if (state.rounds !== undefined) {
    parts.push(`rounds=${state.rounds}`);
  }

  const lastToolName = state.lastToolResult?.toolName ?? state.lastToolCall?.toolName;
  if (lastToolName) {
    parts.push(`lastTool=${lastToolName}`);
  }

  if (state.lastToolResult) {
    parts.push(`lastToolStatus=${state.lastToolResult.status}`);
  }

  if (state.lastProblem) {
    parts.push(`problem=${state.lastProblem.kind}`);
  }

  const prefix = round === undefined ? "[state]" : `[round ${round}] state:`;

  return `${prefix} ${parts.join(" ")}`;
}
