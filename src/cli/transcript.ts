import type { HookableTraceEvent } from "../extensions/lifecycle.js";
import type { PermissionDecision } from "../governance/types.js";
import type { PromptAssemblySummary } from "../context/promptAssembly.js";
import { countTaskItems } from "../runtime/task.js";
import type { RuntimeState } from "../runtime/state.js";
import type { VerificationResult } from "../runtime/verification.js";

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

export function formatPromptAssemblyTranscript(round: number, summary: PromptAssemblySummary): string {
  const selectedSkills =
    summary.selectedSkillIds.length > 0 ? summary.selectedSkillIds.join(",") : "none";

  return [
    `[round ${round}] prompt:`,
    `sections=${summary.sectionNames.join(",")}`,
    `catalogSkills=${summary.catalogSkillIds.length}`,
    `selectedSkills=${selectedSkills}`,
    `chars=${summary.instructionCharCount}`,
  ].join(" ");
}

export function formatSessionTranscript(sessionId: string, tracePath: string): string {
  return `[session] id=${sessionId} trace=${tracePath}`;
}

export function formatVerificationTranscript(result: VerificationResult): string {
  const parts = [`status=${result.status}`];

  if (result.command) {
    parts.push(`command="${result.command}"`);
  }

  if (result.exitCode !== undefined) {
    parts.push(`exitCode=${result.exitCode === null ? "null" : result.exitCode}`);
  }

  return `[verify] ${parts.join(" ")}`;
}

export function formatRecoveryTranscript(attempt: number, maxAttempts: number): string {
  return `[recovery] attempt=${attempt}/${maxAttempts}`;
}

export function formatHookLogTranscript(event: HookableTraceEvent): string {
  const parts = [`event=${event.type}`];

  if ("round" in event && typeof event.round === "number") {
    parts.push(`round=${event.round}`);
  }

  if ("status" in event) {
    parts.push(`status=${event.status}`);
  }

  return `[hook] ${parts.join(" ")}`;
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

  if (state.lastVerificationResult) {
    parts.push(`verification=${state.lastVerificationResult.status}`);
  }

  if (state.recoveryAttempts !== undefined) {
    parts.push(`recoveryAttempts=${state.recoveryAttempts}`);
  }

  if (state.taskState) {
    const counts = countTaskItems(state.taskState);
    const openItems = counts.pending + counts.in_progress + counts.blocked;
    parts.push(`todos=${openItems}/${state.taskState.items.length}`);
    parts.push(`blocked=${counts.blocked}`);
  }

  if (state.lastProblem) {
    parts.push(`problem=${state.lastProblem.kind}`);
  }

  const prefix = round === undefined ? "[state]" : `[round ${round}] state:`;

  return `${prefix} ${parts.join(" ")}`;
}
