import type { PermissionDecision } from "../governance/types.js";

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
