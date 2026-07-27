import type { ChildSessionProfile, SessionTaskGraphBinding } from "../runtime/session.js";
import type {
  TeamMessage,
  TeammateWorkspaceReference,
} from "../runtime/teamMailbox.js";

export const TEAM_DEFINITION_SCHEMA_VERSION = 1;
export const TEAM_RUNTIME_SCHEMA_VERSION = 1;
export const MAX_TEAMMATES_PER_ROOT = 8;
export const TEAMMATE_READY_TIMEOUT_MS = 5_000;
export const TEAMMATE_SHUTDOWN_TIMEOUT_MS = 2_000;
export const TEAMMATE_TERMINATE_TIMEOUT_MS = 1_000;

export type TeammateLifecycleState = "starting" | "busy" | "idle" | "failed" | "stopped";
export type MessageDelivery =
  | "woken"
  | "queued_starting"
  | "queued_busy"
  | "queued_offline";

export interface TeammateDefinition {
  createdAt: string;
  instructions: string;
  maxToolRounds: number;
  name: string;
  profile: ChildSessionProfile;
  schemaVersion: typeof TEAM_DEFINITION_SCHEMA_VERSION;
  taskId?: string;
  workspace?: TeammateWorkspaceReference;
}

export interface TeammateRuntime {
  failure?: string;
  name: string;
  schemaVersion: typeof TEAM_RUNTIME_SCHEMA_VERSION;
  sessionId: string;
  state: TeammateLifecycleState;
  tracePath: string;
  updatedAt: string;
}

export interface TeammateSummary {
  failure?: string;
  name: string;
  profile: ChildSessionProfile;
  sessionId: string;
  state: TeammateLifecycleState;
  tracePath: string;
  unreadCount: number;
  workspace?: TeammateWorkspaceReference;
}

export interface TeammateStartInput {
  instructions: string;
  maxToolRounds?: number;
  message: string;
  name: string;
  profile: ChildSessionProfile;
  taskId?: string;
}

export interface TeammateRejoinInput {
  name: string;
  recovery: string;
}

export interface TeammateSendInput {
  content: string;
  from: string;
  to: string;
}

export interface TeammateBroadcastInput {
  content: string;
  from: "leader";
}

export interface TeammateDeliveryResult {
  delivery: MessageDelivery;
  messageId: string;
  to: string;
}

export interface TeammateBroadcastResult {
  delivered: TeammateDeliveryResult[];
  failed: Array<{ reason: string; to: string }>;
}

export interface TeammateWorkerConfig {
  baseCwd: string;
  cwd: string;
  definition: TeammateDefinition;
  model: string;
  rootSessionId: string;
  sessionId: string;
  taskGraph?: SessionTaskGraphBinding;
  tracePath: string;
}

export type LeaderToTeammateMessage =
  | {
      config: TeammateWorkerConfig;
      sessionId: string;
      type: "initialize";
    }
  | {
      messages: TeamMessage[];
      sessionId: string;
      type: "run_batch";
    }
  | {
      approved: boolean;
      reason?: string;
      requestId: string;
      sessionId: string;
      type: "approval_result";
    }
  | {
      requestId: string;
      result: TeammateDeliveryResult | { error: string };
      sessionId: string;
      type: "message_result";
    }
  | {
      members: TeammateSummary[];
      requestId: string;
      sessionId: string;
      type: "list_result";
    }
  | {
      sessionId: string;
      type: "shutdown";
    };

export type TeammateToLeaderMessage =
  | {
      sessionId: string;
      type: "ready";
    }
  | {
      changedFiles?: string[];
      finalAnswer: string;
      sessionId: string;
      type: "turn_result";
      workspace?: TeammateWorkspaceReference;
    }
  | {
      reason: string;
      sessionId: string;
      type: "failure";
    }
  | {
      content: string;
      requestId: string;
      sessionId: string;
      to: string;
      type: "message_request";
    }
  | {
      requestId: string;
      sessionId: string;
      type: "list_request";
    }
  | {
      argumentsText: string;
      reason: string;
      requestId: string;
      risk: "mutating";
      sessionId: string;
      toolName: "edit" | "write";
      type: "approval_request";
    };

export interface TeammateProcess {
  disconnect(): void;
  kill(signal?: NodeJS.Signals): boolean;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onMessage(listener: (message: TeammateToLeaderMessage) => void): void;
  outputTail?(): { stderr: string; stdout: string };
  send(message: LeaderToTeammateMessage): void;
}

export interface TeammateProcessAdapter {
  fork(config: TeammateWorkerConfig): TeammateProcess;
}

export interface TeammateWorkspaceFactory {
  create(options: {
    baseCwd: string;
    name: string;
    rootSessionId: string;
  }): Promise<TeammateWorkspaceReference>;
}
