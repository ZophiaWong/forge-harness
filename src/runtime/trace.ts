import type { PermissionDecisionAction, PermissionRisk } from "../governance/types.js";
import type { ContextCompactionTrigger, RequiredCompactionHeading } from "../context/compaction.js";
import type { PromptSectionName } from "../context/promptAssembly.js";
import type { ToolStatus } from "../tools/types.js";
import type { BackgroundTaskKind, BackgroundTaskStatus } from "./backgroundTasks.js";
import type { CronRunStatus } from "./cronStore.js";
import type { TaskState } from "./task.js";
import type { VerificationStatus } from "./verification.js";

export type SessionEndStatus = "completed" | "failed";
export type HookResultStatus = "completed" | "failed";

export type TraceEventPayload =
  | {
      type: "workspace_created";
      baseCwd: string;
      workspacePath: string;
      branch: string;
      baseBranch: string;
      baseCommit: string;
    }
  | {
      type: "workspace_setup_failed";
      baseCwd: string;
      workspacePath: string;
      branch: string;
      reason: string;
    }
  | {
      type: "session_started";
      task: string;
      cwd: string;
      baseCwd?: string;
      workspace?: {
        baseBranch: string;
        baseCommit: string;
        branch: string;
        mode: "git_worktree";
        path: string;
      };
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
      type: "prompt_assembled";
      round: number;
      sectionNames: PromptSectionName[];
      instructionCharCount: number;
      catalogSkillIds: string[];
      selectedSkillIds: string[];
    }
  | {
      type: "context_compacted";
      round: number;
      trigger: ContextCompactionTrigger;
      reason: string;
      beforeCharCount: number;
      afterCharCount: number;
      sourceItemCount: number;
      sourceRoundCount: number;
      compactedRoundCount: number;
      keptRecentRoundCount: number;
      summaryCharCount: number;
      omittedSourceCharCount: number;
      missingHeadings: RequiredCompactionHeading[];
      summary: string;
    }
  | {
      type: "context_compaction_failed";
      round: number;
      trigger: ContextCompactionTrigger;
      reason: string;
      beforeCharCount: number;
      afterCharCount?: number;
      hardCharBudget: number;
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
      type: "task_state_updated";
      round: number;
      callId: string;
      taskState: TaskState;
    }
  | {
      type: "background_task_started";
      round: number;
      taskId: string;
      kind: BackgroundTaskKind;
      command: string;
    }
  | {
      type: "background_task_finished";
      round: number;
      taskId: string;
      kind: BackgroundTaskKind;
      command: string;
      status: BackgroundTaskStatus;
      exitCode?: number | null;
    }
  | {
      type: "background_task_notification";
      round: number;
      taskId: string;
      kind: BackgroundTaskKind;
      command: string;
      status: BackgroundTaskStatus;
    }
  | {
      type: "cron_scheduled";
      round: number;
      cronId: string;
      title: string;
      cron: string;
      recurring: boolean;
    }
  | {
      type: "cron_canceled";
      round: number;
      cronId: string;
      title: string;
      status: string;
    }
  | {
      type: "cron_worker_started";
      cwd: string;
      mode: "watch" | "once";
    }
  | {
      type: "cron_fired";
      cronId: string;
      title: string;
      cron: string;
      minuteKey: string;
    }
  | {
      type: "cron_run_finished";
      cronId: string;
      title: string;
      sessionId: string;
      status: CronRunStatus;
      error?: string;
    }
  | {
      type: "cron_worker_stopped";
      mode: "watch" | "once";
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
    }
  | {
      type: "hook_result";
      hookName: string;
      sourceEventType: string;
      status: HookResultStatus;
      round?: number;
      error?: string;
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
