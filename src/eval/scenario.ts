import type { TeamTaskGraphFile } from "../domain/teamTask.js";
import type { RecordedTraceEvent } from "../runtime/trace.js";
import type {
  EvalAssertionResult,
  EvalAttemptResult,
} from "./types.js";

export type EvalScenarioId =
  | "async-child-handoff"
  | "c17c-team-completion"
  | "compaction-retention"
  | "governed-read-only"
  | "verification-recovery";

export interface EvalFixtureFileManifest {
  contentId: string;
  path: string;
}

export interface EvalToolRuleManifest {
  actor?: string;
  arguments?: Record<string, unknown>;
  name: string;
  session: "child" | "root" | "teammate";
}

export interface EvalScenarioManifest {
  actionPolicy: {
    tools: EvalToolRuleManifest[];
    trustedFixtures: string[];
  };
  fixture: {
    files: EvalFixtureFileManifest[];
    initialCommit: true;
  };
  graderVersion: number;
  id: EvalScenarioId;
  repetitions: number;
  runtime: {
    childMaxToolRounds?: number;
    contextCompaction?: {
      hardCharBudget: number;
      recentRoundsToKeep: number;
      softCharBudget: number;
      sourceItemCharLimit: number;
    };
    rootMaxToolRounds: number;
    teammateMaxToolRounds?: number;
    verifierTimeoutMs: number;
    workflowTimeoutMs: number;
  };
  task: string;
}

export interface EvalGitSnapshot {
  head: string;
  statusEntries: string[];
}

export interface EvalTraceSession {
  events: RecordedTraceEvent[];
  name?: string;
  profile?: "edit" | "research";
  role: "child" | "root" | "teammate";
  sessionId: string;
}

export interface EvalAttemptEvidence {
  artifacts: Record<string, string | undefined>;
  finalAnswer?: string;
  git: {
    after: EvalGitSnapshot;
    before: EvalGitSnapshot;
  };
  modelRequestChecks: Array<{
    afterCompaction: boolean;
    pinnedTaskPresent: boolean;
    round: number;
  }>;
  scenarioId: EvalScenarioId;
  sessions: EvalTraceSession[];
  taskGraph?: TeamTaskGraphFile;
  team?: {
    leaderUnreadCount: number;
    members: Array<{
      name: string;
      state: "busy" | "failed" | "idle" | "starting" | "stopped";
      unreadCount: number;
    }>;
  };
}

export interface EvalGrade {
  assertions: EvalAssertionResult[];
  outcome: EvalAttemptResult["outcome"];
}

export interface EvalScenario {
  grade(evidence: EvalAttemptEvidence): EvalGrade;
  id: EvalScenarioId;
  isToolCallAllowed(session: EvalTraceSession, toolName: string, argumentsText: string): boolean;
  manifest: EvalScenarioManifest;
}
