import { z } from "zod";

import { isTaskState, type TaskState } from "./task.js";
import type { RecordedTraceEvent } from "./trace.js";

const nonEmptyString = z.string().min(1);
const safeInteger = z.number().int().safe();
const nonNegativeSafeInteger = safeInteger.nonnegative();
const positiveSafeInteger = safeInteger.positive();
const safeExitCode = safeInteger.nullable();

const modelUsageSchema = z.object({
  cachedInputTokens: nonNegativeSafeInteger.optional(),
  inputTokens: nonNegativeSafeInteger,
  outputTokens: nonNegativeSafeInteger,
  reasoningTokens: nonNegativeSafeInteger.optional(),
  totalTokens: nonNegativeSafeInteger,
}).strict();

const modelCallTelemetrySchema = z.object({
  durationMs: z.number().safe().nonnegative(),
  usage: modelUsageSchema.optional(),
}).strict();

const sessionWorkspaceSchema = z.object({
  baseBranch: nonEmptyString,
  baseCommit: nonEmptyString,
  branch: nonEmptyString,
  mode: z.literal("git_worktree"),
  path: nonEmptyString,
}).strict();

const teammateWorkspaceSchema = z.object({
  branch: nonEmptyString,
  path: nonEmptyString,
}).strict();

const pluginComponentActivationSchema = z.object({
  active: z.array(z.string()),
  declared: z.array(z.string()),
  failed: z.array(z.object({
    id: nonEmptyString,
    reason: z.string(),
  }).strict()),
}).strict();

const pluginToolActivationSchema = z.object({
  declared: z.array(z.string()),
  denied: z.array(z.string()),
  exposed: z.array(z.string()),
  extra: z.array(z.string()),
  incompatible: z.array(z.object({
    reason: z.string(),
    toolName: nonEmptyString,
  }).strict()),
  missing: z.array(z.string()),
}).strict();

const teamTaskFailureCodeSchema = z.enum([
  "capacity_exceeded",
  "child_source_invalid",
  "contract_frozen",
  "delegated_task_mismatch",
  "delete_not_allowed",
  "dependencies_incomplete",
  "dirty_target",
  "evidence_not_allowed",
  "evidence_required",
  "fingerprint_mismatch",
  "graph_invalid",
  "graph_malformed",
  "graph_missing",
  "handoff_required",
  "integration_conflict",
  "invalid_actor",
  "invalid_input",
  "invalid_transition",
  "owner_mismatch",
  "permission_denied",
  "plan_not_approved",
  "schema_unsupported",
  "source_drift",
  "git_identity_missing",
  "cherry_pick_in_progress",
  "stale_approval",
  "store_io",
  "task_frozen",
  "task_not_found",
  "task_not_ready",
  "task_store_busy",
  "transfer_exhausted",
  "verification_failed",
]);

const teamTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "submitted",
  "completed",
  "blocked",
]);

const taskGraphProjectionSchema = z.object({
  error: z.object({
    code: teamTaskFailureCodeSchema,
    message: z.string(),
  }).strict().optional(),
  health: z.enum(["healthy", "degraded"]),
  revision: nonNegativeSafeInteger.optional(),
}).strict();

const completionGateProblemSchema = z.object({
  code: nonEmptyString,
  message: z.string(),
  taskId: nonEmptyString.optional(),
  teammate: nonEmptyString.optional(),
}).strict();

const taskStateStructureSchema = z.object({
  acceptance: z.array(z.string()),
  items: z.array(z.object({
    id: z.string(),
    note: z.string().optional(),
    status: z.enum(["pending", "in_progress", "completed", "blocked"]),
    title: z.string(),
  }).strict()),
  summary: z.string(),
}).strict();

const taskStateSchema = z.intersection(
  taskStateStructureSchema,
  z.custom<TaskState>(isTaskState),
);

const envelope = {
  sequence: positiveSafeInteger,
  sessionId: nonEmptyString,
  timestamp: z.string().datetime(),
};

function recorded<TShape extends z.ZodRawShape>(shape: TShape) {
  return z.object({ ...shape, ...envelope }).strict();
}

const recordedTraceEventSchema = z.discriminatedUnion("type", [
  recorded({
    approved: z.boolean(),
    callId: nonEmptyString,
    reason: z.string().optional(),
    round: positiveSafeInteger,
    toolName: nonEmptyString,
    type: z.literal("approval_result"),
  }),
  recorded({
    command: z.string(),
    exitCode: safeExitCode.optional(),
    kind: z.literal("bash"),
    round: positiveSafeInteger,
    status: z.enum(["running", "completed", "timed_out", "failed", "canceled"]),
    taskId: nonEmptyString,
    type: z.literal("background_task_finished"),
  }),
  recorded({
    command: z.string(),
    kind: z.literal("bash"),
    round: positiveSafeInteger,
    status: z.enum(["running", "completed", "timed_out", "failed", "canceled"]),
    taskId: nonEmptyString,
    type: z.literal("background_task_notification"),
  }),
  recorded({
    command: z.string(),
    kind: z.literal("bash"),
    round: positiveSafeInteger,
    taskId: nonEmptyString,
    type: z.literal("background_task_started"),
  }),
  recorded({
    answer: z.string(),
    round: positiveSafeInteger,
    type: z.literal("candidate_answer"),
  }),
  recorded({
    childSessionId: nonEmptyString,
    parentCallId: nonEmptyString,
    profile: z.enum(["research", "edit"]),
    reason: z.string().optional(),
    round: positiveSafeInteger,
    runInBackground: z.boolean().optional(),
    status: z.enum(["completed", "failed"]),
    tracePath: nonEmptyString,
    type: z.literal("child_session_finished"),
    workspace: sessionWorkspaceSchema.optional(),
  }),
  recorded({
    changedFiles: z.array(z.string()).optional(),
    childSessionId: nonEmptyString,
    finalAnswer: z.string(),
    parentCallId: nonEmptyString,
    profile: z.enum(["research", "edit"]),
    round: positiveSafeInteger,
    tracePath: nonEmptyString,
    type: z.literal("child_session_handoff"),
    workspace: sessionWorkspaceSchema.optional(),
  }),
  recorded({
    childSessionId: nonEmptyString,
    profile: z.enum(["research", "edit"]),
    round: positiveSafeInteger,
    status: z.enum(["running", "completed", "failed"]),
    tracePath: nonEmptyString,
    type: z.literal("child_session_notification"),
  }),
  recorded({
    childSessionId: nonEmptyString,
    parentCallId: nonEmptyString,
    profile: z.enum(["research", "edit"]),
    round: positiveSafeInteger,
    runInBackground: z.boolean().optional(),
    task: z.string(),
    tracePath: nonEmptyString,
    type: z.literal("child_session_started"),
    workspace: sessionWorkspaceSchema.optional(),
  }),
  recorded({
    problems: z.array(completionGateProblemSchema),
    type: z.literal("completion_gate_failed"),
  }),
  recorded({
    afterCharCount: nonNegativeSafeInteger,
    beforeCharCount: nonNegativeSafeInteger,
    compactedRoundCount: nonNegativeSafeInteger,
    keptRecentRoundCount: nonNegativeSafeInteger,
    missingHeadings: z.array(z.enum(["Task", "Progress", "Evidence", "Open Questions", "Next Step"])),
    omittedSourceCharCount: nonNegativeSafeInteger,
    reason: z.string(),
    round: positiveSafeInteger,
    sourceItemCount: nonNegativeSafeInteger,
    sourceRoundCount: nonNegativeSafeInteger,
    summary: z.string(),
    summaryCharCount: nonNegativeSafeInteger,
    telemetry: modelCallTelemetrySchema.optional(),
    trigger: z.enum(["auto", "reactive", "manual"]),
    type: z.literal("context_compacted"),
  }),
  recorded({
    afterCharCount: nonNegativeSafeInteger.optional(),
    beforeCharCount: nonNegativeSafeInteger,
    hardCharBudget: positiveSafeInteger,
    reason: z.string(),
    round: positiveSafeInteger,
    trigger: z.enum(["auto", "reactive", "manual"]),
    type: z.literal("context_compaction_failed"),
  }),
  recorded({
    cronId: nonEmptyString,
    round: positiveSafeInteger,
    status: z.string(),
    title: z.string(),
    type: z.literal("cron_canceled"),
  }),
  recorded({
    cron: z.string(),
    cronId: nonEmptyString,
    minuteKey: nonEmptyString,
    title: z.string(),
    type: z.literal("cron_fired"),
  }),
  recorded({
    cronId: nonEmptyString,
    error: z.string().optional(),
    status: z.enum(["completed", "failed"]),
    title: z.string(),
    type: z.literal("cron_run_finished"),
  }),
  recorded({
    cron: z.string(),
    cronId: nonEmptyString,
    recurring: z.boolean(),
    round: positiveSafeInteger,
    title: z.string(),
    type: z.literal("cron_scheduled"),
  }),
  recorded({
    cwd: nonEmptyString,
    mode: z.enum(["watch", "once"]),
    type: z.literal("cron_worker_started"),
  }),
  recorded({
    mode: z.enum(["watch", "once"]),
    type: z.literal("cron_worker_stopped"),
  }),
  recorded({
    answer: z.string(),
    round: positiveSafeInteger,
    type: z.literal("final_answer"),
  }),
  recorded({
    error: z.string().optional(),
    hookName: nonEmptyString,
    round: positiveSafeInteger.optional(),
    sourceEventType: z.string(),
    status: z.enum(["completed", "failed"]),
    type: z.literal("hook_result"),
  }),
  recorded({
    deniedToolNames: z.array(z.string()),
    discoveredToolNames: z.array(z.string()),
    exposedToolNames: z.array(z.string()),
    extraToolNames: z.array(z.string()),
    incompatibleTools: z.array(z.object({
      rawToolName: nonEmptyString,
      reason: z.string(),
    }).strict()),
    missingToolNames: z.array(z.string()),
    serverId: nonEmptyString,
    type: z.literal("mcp_server_connected"),
  }),
  recorded({
    phase: z.enum(["connect", "discovery", "call", "transport", "close"]),
    reason: z.string(),
    round: positiveSafeInteger.optional(),
    serverId: nonEmptyString,
    toolName: nonEmptyString.optional(),
    type: z.literal("mcp_server_failed"),
  }),
  recorded({
    reason: z.enum(["session_end", "unexpected_close", "startup_failed"]),
    serverId: nonEmptyString,
    type: z.literal("mcp_server_stopped"),
  }),
  recorded({
    approved: z.boolean(),
    reason: z.string(),
    serverId: nonEmptyString,
    type: z.literal("mcp_server_trust_decided"),
  }),
  recorded({
    inputItemCount: nonNegativeSafeInteger,
    model: nonEmptyString,
    round: positiveSafeInteger,
    toolNames: z.array(z.string()),
    type: z.literal("model_request"),
  }),
  recorded({
    functionCallCount: nonNegativeSafeInteger,
    outputText: z.string(),
    round: positiveSafeInteger,
    telemetry: modelCallTelemetrySchema.optional(),
    type: z.literal("model_response"),
  }),
  recorded({
    action: z.enum(["allow", "deny", "ask"]),
    callId: nonEmptyString,
    reason: z.string(),
    risk: z.enum(["inspect", "mutating", "destructive", "unknown"]),
    round: positiveSafeInteger,
    toolName: nonEmptyString,
    type: z.literal("permission_decision"),
  }),
  recorded({
    components: z.object({
      hooks: pluginComponentActivationSchema,
      mcpServers: pluginComponentActivationSchema,
      skills: pluginComponentActivationSchema,
    }).strict(),
    pluginName: nonEmptyString,
    status: z.enum(["active", "degraded", "failed"]),
    tools: pluginToolActivationSchema,
    type: z.literal("plugin_activation_result"),
    version: nonEmptyString,
  }),
  recorded({
    approved: z.boolean(),
    pluginName: nonEmptyString,
    reason: z.string(),
    root: nonEmptyString,
    type: z.literal("plugin_trust_decided"),
    version: nonEmptyString,
  }),
  recorded({
    catalogSkillIds: z.array(z.string()),
    instructionCharCount: nonNegativeSafeInteger,
    round: positiveSafeInteger,
    sectionNames: z.array(z.enum([
      "base_instructions",
      "tool_rules",
      "project_memory",
      "skill_catalog",
      "selected_skills",
    ])),
    selectedSkillIds: z.array(z.string()),
    type: z.literal("prompt_assembled"),
  }),
  recorded({
    attempt: positiveSafeInteger,
    maxAttempts: positiveSafeInteger,
    round: positiveSafeInteger,
    summary: z.string(),
    type: z.literal("recovery_attempt"),
  }),
  recorded({
    rounds: nonNegativeSafeInteger,
    status: z.enum(["completed", "failed"]),
    type: z.literal("session_ended"),
  }),
  recorded({
    message: z.string(),
    type: z.literal("session_failed"),
  }),
  recorded({
    baseCwd: nonEmptyString.optional(),
    cwd: nonEmptyString,
    maxToolRounds: positiveSafeInteger,
    model: nonEmptyString,
    task: z.string(),
    type: z.literal("session_started"),
    workspace: sessionWorkspaceSchema.optional(),
  }),
  recorded({
    nextStatus: teamTaskStatusSchema.optional(),
    operation: z.enum(["create", "update", "add_evidence", "delete", "transition", "verify", "integrate"]),
    previousStatus: teamTaskStatusSchema.optional(),
    revision: nonNegativeSafeInteger,
    taskId: nonEmptyString,
    type: z.literal("task_graph_mutated"),
  }),
  recorded({
    callId: nonEmptyString,
    round: positiveSafeInteger,
    taskState: taskStateSchema,
    type: z.literal("task_state_updated"),
  }),
  recorded({
    delivered: z.array(z.string()),
    failed: z.array(z.object({
      reason: z.string(),
      to: nonEmptyString,
    }).strict()),
    type: z.literal("team_broadcast_result"),
  }),
  recorded({
    mode: z.enum(["graceful", "terminate"]),
    stopped: z.array(z.string()),
    type: z.literal("team_cleanup"),
  }),
  recorded({
    address: nonEmptyString,
    messageIds: z.array(z.string()),
    type: z.literal("team_mailbox_claimed"),
  }),
  recorded({
    from: nonEmptyString,
    kind: z.enum(["direct", "broadcast", "turn_result", "failure_notice"]),
    messageId: nonEmptyString,
    to: nonEmptyString,
    type: z.literal("team_mailbox_message_persisted"),
  }),
  recorded({
    approved: z.boolean(),
    name: nonEmptyString,
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    toolName: z.enum(["edit", "write"]),
    type: z.literal("teammate_approval_brokered"),
  }),
  recorded({
    name: nonEmptyString,
    profile: z.enum(["research", "edit"]),
    sessionId: nonEmptyString,
    state: z.literal("starting"),
    tracePath: nonEmptyString,
    type: z.literal("teammate_registered"),
    unreadCount: nonNegativeSafeInteger,
    workspace: teammateWorkspaceSchema.optional(),
  }),
  recorded({
    name: nonEmptyString,
    previousSessionId: nonEmptyString,
    recoveryMessageId: nonEmptyString,
    sessionId: nonEmptyString,
    tracePath: nonEmptyString,
    type: z.literal("teammate_rejoined"),
  }),
  recorded({
    failure: z.string().optional(),
    name: nonEmptyString,
    previousState: z.enum(["starting", "busy", "idle", "failed", "stopped"]),
    profile: z.enum(["research", "edit"]),
    sessionId: nonEmptyString,
    state: z.enum(["starting", "busy", "idle", "failed", "stopped"]),
    tracePath: nonEmptyString,
    type: z.literal("teammate_state_changed"),
    unreadCount: nonNegativeSafeInteger,
    workspace: teammateWorkspaceSchema.optional(),
  }),
  recorded({
    argumentsText: z.string(),
    callId: nonEmptyString,
    round: positiveSafeInteger,
    toolName: nonEmptyString,
    type: z.literal("tool_call"),
  }),
  recorded({
    callId: nonEmptyString,
    projectedOutput: z.string(),
    round: positiveSafeInteger,
    status: z.enum(["completed", "failed", "blocked", "timed_out"]),
    taskGraph: taskGraphProjectionSchema.optional(),
    toolName: nonEmptyString,
    type: z.literal("tool_result"),
  }),
  recorded({
    command: z.string().optional(),
    exitCode: safeExitCode.optional(),
    name: nonEmptyString,
    round: positiveSafeInteger,
    status: z.enum(["passed", "failed", "blocked"]),
    summary: z.string(),
    type: z.literal("verification_result"),
  }),
  recorded({
    baseBranch: nonEmptyString,
    baseCommit: nonEmptyString,
    baseCwd: nonEmptyString,
    branch: nonEmptyString,
    type: z.literal("workspace_created"),
    workspacePath: nonEmptyString,
  }),
  recorded({
    baseCwd: nonEmptyString,
    branch: nonEmptyString,
    reason: z.string(),
    type: z.literal("workspace_setup_failed"),
    workspacePath: nonEmptyString,
  }),
]);

export function parseRecordedTraceEvent(value: unknown): RecordedTraceEvent {
  return recordedTraceEventSchema.parse(value) as RecordedTraceEvent;
}
