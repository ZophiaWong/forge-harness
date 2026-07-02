import type { PermissionDecisionAction, PermissionRisk } from "../governance/types.js";
import type { ToolStatus } from "../tools/types.js";
import type { RuntimeTaskState } from "./task.js";
import type { SessionEndStatus, TraceEventPayload, TraceRecorder } from "./trace.js";
import type { VerificationStatus } from "./verification.js";

export type RuntimeStatus = "idle" | "running" | "completed" | "failed";

export interface RuntimeModelRequestState {
  inputItemCount: number;
  model: string;
  round: number;
  toolNames: string[];
}

export interface RuntimeModelResponseState {
  functionCallCount: number;
  outputText: string;
  round: number;
}

export interface RuntimeToolCallState {
  argumentsText: string;
  callId: string;
  round: number;
  toolName: string;
}

export interface RuntimePermissionDecisionState {
  action: PermissionDecisionAction;
  callId: string;
  reason: string;
  risk: PermissionRisk;
  round: number;
  toolName: string;
}

export interface RuntimeApprovalResultState {
  approved: boolean;
  callId: string;
  reason?: string;
  round: number;
  toolName: string;
}

export interface RuntimeToolResultState {
  callId: string;
  projectedOutput: string;
  round: number;
  status: ToolStatus;
  toolName: string;
}

export interface RuntimeFinalAnswerState {
  answer: string;
  round: number;
}

export interface RuntimeCandidateAnswerState {
  answer: string;
  round: number;
}

export interface RuntimeVerificationResultState {
  command?: string;
  exitCode?: number | null;
  name: string;
  round: number;
  status: VerificationStatus;
  summary: string;
}

export type RuntimeProblem =
  | {
      kind: "tool_result";
      message: string;
      round: number;
      status: Extract<ToolStatus, "failed" | "timed_out">;
      toolName: string;
    }
  | {
      kind: "session_failed";
      message: string;
    }
  | {
      kind: "verification_failed";
      round: number;
      status: Exclude<VerificationStatus, "passed">;
      summary: string;
    };

export interface RuntimeState {
  candidateAnswer?: RuntimeCandidateAnswerState;
  currentRound: number;
  cwd?: string;
  ended: boolean;
  finalAnswer?: RuntimeFinalAnswerState;
  lastApprovalResult?: RuntimeApprovalResultState;
  lastModelRequest?: RuntimeModelRequestState;
  lastModelResponse?: RuntimeModelResponseState;
  lastPermissionDecision?: RuntimePermissionDecisionState;
  lastProblem?: RuntimeProblem;
  lastToolCall?: RuntimeToolCallState;
  lastToolResult?: RuntimeToolResultState;
  lastVerificationResult?: RuntimeVerificationResultState;
  maxToolRounds?: number;
  model?: string;
  recoveryAttempts?: number;
  rounds?: number;
  status: RuntimeStatus;
  taskState?: RuntimeTaskState;
  task?: string;
}

export interface RuntimeStateRecorder {
  getState(): RuntimeState;
  recorder: TraceRecorder;
}

export function createInitialRuntimeState(): RuntimeState {
  return {
    currentRound: 0,
    ended: false,
    status: "idle",
  };
}

export function applyRuntimeStateEvent(state: RuntimeState, event: TraceEventPayload): RuntimeState {
  switch (event.type) {
    case "session_started":
      return {
        ...createInitialRuntimeState(),
        currentRound: 0,
        cwd: event.cwd,
        ended: false,
        maxToolRounds: event.maxToolRounds,
        model: event.model,
        status: "running",
        task: event.task,
      };
    case "model_request":
      return {
        ...state,
        currentRound: event.round,
        lastModelRequest: {
          inputItemCount: event.inputItemCount,
          model: event.model,
          round: event.round,
          toolNames: event.toolNames,
        },
      };
    case "prompt_assembled":
      return state;
    case "model_response":
      return {
        ...state,
        currentRound: event.round,
        lastModelResponse: {
          functionCallCount: event.functionCallCount,
          outputText: event.outputText,
          round: event.round,
        },
      };
    case "tool_call":
      return {
        ...state,
        currentRound: event.round,
        lastToolCall: {
          argumentsText: event.argumentsText,
          callId: event.callId,
          round: event.round,
          toolName: event.toolName,
        },
      };
    case "permission_decision":
      return {
        ...state,
        currentRound: event.round,
        lastPermissionDecision: {
          action: event.action,
          callId: event.callId,
          reason: event.reason,
          risk: event.risk,
          round: event.round,
          toolName: event.toolName,
        },
      };
    case "approval_result":
      return {
        ...state,
        currentRound: event.round,
        lastApprovalResult: {
          approved: event.approved,
          callId: event.callId,
          ...(event.reason ? { reason: event.reason } : {}),
          round: event.round,
          toolName: event.toolName,
        },
      };
    case "tool_result":
      return {
        ...state,
        currentRound: event.round,
        lastProblem: createToolProblem(event) ?? state.lastProblem,
        lastToolResult: {
          callId: event.callId,
          projectedOutput: event.projectedOutput,
          round: event.round,
          status: event.status,
          toolName: event.toolName,
        },
      };
    case "task_state_updated":
      return {
        ...state,
        currentRound: event.round,
        taskState: {
          acceptance: [...event.taskState.acceptance],
          items: event.taskState.items.map((item) => ({ ...item })),
          summary: event.taskState.summary,
          updatedAtRound: event.round,
          updatedByCallId: event.callId,
        },
      };
    case "candidate_answer":
      return {
        ...state,
        candidateAnswer: {
          answer: event.answer,
          round: event.round,
        },
        currentRound: event.round,
      };
    case "verification_result":
      return {
        ...state,
        currentRound: event.round,
        lastProblem: createVerificationProblem(event),
        lastVerificationResult: {
          ...(event.command !== undefined ? { command: event.command } : {}),
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          name: event.name,
          round: event.round,
          status: event.status,
          summary: event.summary,
        },
      };
    case "recovery_attempt":
      return {
        ...state,
        currentRound: event.round,
        recoveryAttempts: event.attempt,
      };
    case "final_answer":
      return {
        ...state,
        currentRound: event.round,
        finalAnswer: {
          answer: event.answer,
          round: event.round,
        },
      };
    case "session_failed":
      return {
        ...state,
        lastProblem: {
          kind: "session_failed",
          message: event.message,
        },
        status: "failed",
      };
    case "session_ended":
      return {
        ...state,
        ended: true,
        rounds: event.rounds,
        status: toRuntimeStatus(event.status),
      };
    case "hook_result":
      return state;
  }
}

export function createRuntimeStateRecorder(delegate: TraceRecorder): RuntimeStateRecorder {
  let state = createInitialRuntimeState();

  return {
    getState() {
      return state;
    },
    recorder: {
      async record(event) {
        state = applyRuntimeStateEvent(state, event);
        await delegate.record(event);
      },
    },
  };
}

function createVerificationProblem(
  event: Extract<TraceEventPayload, { type: "verification_result" }>,
): RuntimeProblem | undefined {
  if (event.status === "passed") {
    return undefined;
  }

  return {
    kind: "verification_failed",
    round: event.round,
    status: event.status,
    summary: event.summary,
  };
}

function createToolProblem(event: Extract<TraceEventPayload, { type: "tool_result" }>): RuntimeProblem | undefined {
  if (event.status !== "failed" && event.status !== "timed_out") {
    return undefined;
  }

  return {
    kind: "tool_result",
    message: event.projectedOutput,
    round: event.round,
    status: event.status,
    toolName: event.toolName,
  };
}

function toRuntimeStatus(status: SessionEndStatus): RuntimeStatus {
  return status;
}
