import type { PermissionDecisionAction, PermissionRisk } from "../governance/types.js";
import type { ToolStatus } from "../tools/types.js";
import type { VerificationStatus } from "./verification.js";

export type SessionEndStatus = "completed" | "failed";

export type TraceEventPayload =
  | {
      type: "session_started";
      task: string;
      cwd: string;
      model: string;
      maxToolRounds: number;
    }
  | {
      type: "model_request";
      round: number;
      model: string;
      inputItemCount: number;
      toolNames: string[];
    }
  | {
      type: "model_response";
      round: number;
      outputText: string;
      functionCallCount: number;
    }
  | {
      type: "tool_call";
      round: number;
      callId: string;
      toolName: string;
      argumentsText: string;
    }
  | {
      type: "permission_decision";
      round: number;
      callId: string;
      toolName: string;
      action: PermissionDecisionAction;
      risk: PermissionRisk;
      reason: string;
    }
  | {
      type: "approval_result";
      round: number;
      callId: string;
      toolName: string;
      approved: boolean;
      reason?: string;
    }
  | {
      type: "tool_result";
      round: number;
      callId: string;
      toolName: string;
      status: ToolStatus;
      projectedOutput: string;
    }
  | {
      type: "candidate_answer";
      round: number;
      answer: string;
    }
  | {
      type: "verification_result";
      round: number;
      name: string;
      status: VerificationStatus;
      summary: string;
      command?: string;
      exitCode?: number | null;
    }
  | {
      type: "recovery_attempt";
      round: number;
      attempt: number;
      maxAttempts: number;
      summary: string;
    }
  | {
      type: "final_answer";
      round: number;
      answer: string;
    }
  | {
      type: "session_failed";
      message: string;
    }
  | {
      type: "session_ended";
      status: SessionEndStatus;
      rounds: number;
    };

export type RecordedTraceEvent = TraceEventPayload & {
  sessionId: string;
  sequence: number;
  timestamp: string;
};

export interface TraceRecorder {
  record(event: TraceEventPayload): Promise<void>;
}

export function createNoopTraceRecorder(): TraceRecorder {
  return {
    async record() {
      return undefined;
    },
  };
}
