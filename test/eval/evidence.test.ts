import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectEvalTraceSessions,
  readEvalTrace,
} from "../../src/eval/evidence.js";
import type { RecordedTraceEvent, TraceEventPayload } from "../../src/runtime/trace.js";

const tempRoots: string[] = [];

const VALID_TRACE_PAYLOADS = {
  approval_result: {
    approved: true,
    callId: "call-1",
    round: 1,
    toolName: "read",
    type: "approval_result",
  },
  background_task_finished: {
    command: "pwd",
    kind: "bash",
    round: 1,
    status: "completed",
    taskId: "background-1",
    type: "background_task_finished",
  },
  background_task_notification: {
    command: "pwd",
    kind: "bash",
    round: 1,
    status: "running",
    taskId: "background-1",
    type: "background_task_notification",
  },
  background_task_started: {
    command: "pwd",
    kind: "bash",
    round: 1,
    taskId: "background-1",
    type: "background_task_started",
  },
  candidate_answer: { answer: "candidate", round: 1, type: "candidate_answer" },
  child_session_finished: {
    childSessionId: "child-1",
    parentCallId: "call-1",
    profile: "research",
    round: 1,
    status: "completed",
    tracePath: "/attempt/child.jsonl",
    type: "child_session_finished",
  },
  child_session_handoff: {
    childSessionId: "child-1",
    finalAnswer: "done",
    parentCallId: "call-1",
    profile: "edit",
    round: 1,
    tracePath: "/attempt/child.jsonl",
    type: "child_session_handoff",
  },
  child_session_notification: {
    childSessionId: "child-1",
    profile: "research",
    round: 1,
    status: "running",
    tracePath: "/attempt/child.jsonl",
    type: "child_session_notification",
  },
  child_session_started: {
    childSessionId: "child-1",
    parentCallId: "call-1",
    profile: "research",
    round: 1,
    task: "inspect",
    tracePath: "/attempt/child.jsonl",
    type: "child_session_started",
  },
  completion_gate_failed: {
    problems: [{ code: "graph_degraded", message: "task graph is degraded", taskId: "task-1" }],
    type: "completion_gate_failed",
  },
  context_compacted: {
    afterCharCount: 100,
    beforeCharCount: 200,
    compactedRoundCount: 1,
    keptRecentRoundCount: 1,
    missingHeadings: ["Evidence"],
    omittedSourceCharCount: 10,
    reason: "soft budget exceeded",
    round: 2,
    sourceItemCount: 2,
    sourceRoundCount: 1,
    summary: "summary",
    summaryCharCount: 7,
    telemetry: {
      durationMs: 10,
      usage: {
        cachedInputTokens: 1,
        inputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 6,
      },
    },
    trigger: "auto",
    type: "context_compacted",
  },
  context_compaction_failed: {
    beforeCharCount: 200,
    hardCharBudget: 100,
    reason: "too large",
    round: 2,
    trigger: "reactive",
    type: "context_compaction_failed",
  },
  cron_canceled: {
    cronId: "cron-1",
    round: 1,
    status: "canceled",
    title: "nightly",
    type: "cron_canceled",
  },
  cron_fired: {
    cron: "0 0 * * *",
    cronId: "cron-1",
    minuteKey: "2026-08-03T00:00Z",
    title: "nightly",
    type: "cron_fired",
  },
  cron_run_finished: {
    cronId: "cron-1",
    sessionId: "cron-session",
    status: "completed",
    title: "nightly",
    type: "cron_run_finished",
  },
  cron_scheduled: {
    cron: "0 0 * * *",
    cronId: "cron-1",
    recurring: true,
    round: 1,
    title: "nightly",
    type: "cron_scheduled",
  },
  cron_worker_started: { cwd: "/repo", mode: "once", type: "cron_worker_started" },
  cron_worker_stopped: { mode: "watch", type: "cron_worker_stopped" },
  final_answer: { answer: "done", round: 1, type: "final_answer" },
  hook_result: {
    hookName: "audit",
    sourceEventType: "tool_call",
    status: "completed",
    type: "hook_result",
  },
  mcp_server_connected: {
    deniedToolNames: ["delete"],
    discoveredToolNames: ["read"],
    exposedToolNames: ["read"],
    extraToolNames: [],
    incompatibleTools: [{ rawToolName: "bad", reason: "invalid schema" }],
    missingToolNames: [],
    serverId: "docs",
    type: "mcp_server_connected",
  },
  mcp_server_failed: {
    phase: "call",
    reason: "connection closed",
    round: 1,
    serverId: "docs",
    toolName: "read",
    type: "mcp_server_failed",
  },
  mcp_server_stopped: {
    reason: "session_end",
    serverId: "docs",
    type: "mcp_server_stopped",
  },
  mcp_server_trust_decided: {
    approved: true,
    reason: "configured",
    serverId: "docs",
    type: "mcp_server_trust_decided",
  },
  model_request: {
    inputItemCount: 2,
    model: "gpt-test",
    round: 1,
    toolNames: ["read"],
    type: "model_request",
  },
  model_response: {
    functionCallCount: 1,
    outputText: "response",
    round: 1,
    telemetry: {
      durationMs: 10,
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    },
    type: "model_response",
  },
  permission_decision: {
    action: "ask",
    callId: "call-1",
    reason: "writes files",
    risk: "mutating",
    round: 1,
    toolName: "write",
    type: "permission_decision",
  },
  plugin_activation_result: {
    components: {
      hooks: { active: ["audit"], declared: ["audit"], failed: [] },
      mcpServers: { active: [], declared: [], failed: [] },
      skills: { active: ["review"], declared: ["review"], failed: [] },
    },
    pluginName: "quality",
    status: "active",
    tools: {
      declared: ["review"],
      denied: [],
      exposed: ["review"],
      extra: [],
      incompatible: [],
      missing: [],
    },
    type: "plugin_activation_result",
    version: "1.0.0",
  },
  plugin_trust_decided: {
    approved: true,
    pluginName: "quality",
    reason: "trusted",
    root: "/plugins/quality",
    type: "plugin_trust_decided",
    version: "1.0.0",
  },
  prompt_assembled: {
    catalogSkillIds: ["review"],
    instructionCharCount: 100,
    round: 1,
    sectionNames: ["base_instructions", "selected_skills"],
    selectedSkillIds: ["review"],
    type: "prompt_assembled",
  },
  recovery_attempt: {
    attempt: 1,
    maxAttempts: 2,
    round: 2,
    summary: "retrying",
    type: "recovery_attempt",
  },
  session_ended: { rounds: 1, status: "completed", type: "session_ended" },
  session_failed: { message: "failed", type: "session_failed" },
  session_started: {
    cwd: "/repo",
    maxToolRounds: 10,
    model: "gpt-test",
    task: "inspect",
    type: "session_started",
    workspace: {
      baseBranch: "main",
      baseCommit: "abc123",
      branch: "work/task",
      mode: "git_worktree",
      path: "/repo-worktree",
    },
  },
  task_graph_mutated: {
    nextStatus: "in_progress",
    operation: "transition",
    previousStatus: "pending",
    revision: 1,
    taskId: "task-1",
    type: "task_graph_mutated",
  },
  task_state_updated: {
    callId: "call-1",
    round: 1,
    taskState: {
      acceptance: ["tests pass"],
      items: [{ id: "step-1", status: "in_progress", title: "Implement" }],
      summary: "implementation",
    },
    type: "task_state_updated",
  },
  team_broadcast_result: {
    delivered: ["researcher"],
    failed: [{ reason: "offline", to: "reviewer" }],
    type: "team_broadcast_result",
  },
  team_cleanup: { mode: "graceful", stopped: ["researcher"], type: "team_cleanup" },
  team_mailbox_claimed: {
    address: "leader",
    messageIds: ["message-1"],
    type: "team_mailbox_claimed",
  },
  team_mailbox_message_persisted: {
    from: "researcher",
    kind: "direct",
    messageId: "message-1",
    to: "leader",
    type: "team_mailbox_message_persisted",
  },
  teammate_approval_brokered: {
    approved: true,
    name: "editor",
    requestId: "request-1",
    sessionId: "teammate-session",
    toolName: "edit",
    type: "teammate_approval_brokered",
  },
  teammate_registered: {
    name: "researcher",
    profile: "research",
    sessionId: "teammate-session",
    state: "starting",
    tracePath: "/attempt/teammate.jsonl",
    type: "teammate_registered",
    unreadCount: 1,
    workspace: { branch: "work/research", path: "/repo-research" },
  },
  teammate_rejoined: {
    name: "researcher",
    previousSessionId: "teammate-session-1",
    recoveryMessageId: "message-1",
    sessionId: "teammate-session-2",
    tracePath: "/attempt/teammate-2.jsonl",
    type: "teammate_rejoined",
  },
  teammate_state_changed: {
    name: "researcher",
    previousState: "busy",
    profile: "research",
    sessionId: "teammate-session",
    state: "idle",
    tracePath: "/attempt/teammate.jsonl",
    type: "teammate_state_changed",
    unreadCount: 1,
  },
  tool_call: {
    argumentsText: "{}",
    callId: "call-1",
    round: 1,
    toolName: "read",
    type: "tool_call",
  },
  tool_result: {
    callId: "call-1",
    projectedOutput: "contents",
    round: 1,
    status: "completed",
    taskGraph: {
      error: { code: "graph_invalid", message: "invalid graph" },
      health: "degraded",
      revision: 1,
    },
    toolName: "read",
    type: "tool_result",
  },
  verification_result: {
    command: "npm test",
    exitCode: 0,
    name: "command",
    round: 1,
    status: "passed",
    summary: "passed",
    type: "verification_result",
  },
  workspace_created: {
    baseBranch: "main",
    baseCommit: "abc123",
    baseCwd: "/repo",
    branch: "work/task",
    type: "workspace_created",
    workspacePath: "/repo-worktree",
  },
  workspace_setup_failed: {
    baseCwd: "/repo",
    branch: "work/task",
    reason: "dirty worktree",
    type: "workspace_setup_failed",
    workspacePath: "/repo-worktree",
  },
} satisfies {
  [TType in TraceEventPayload["type"]]: Extract<TraceEventPayload, { type: TType }>;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

function recorded(sequence: number, payload: TraceEventPayload, sessionId: string): RecordedTraceEvent {
  return {
    ...payload,
    sequence,
    sessionId,
    timestamp: "2026-08-03T00:00:00.000Z",
  };
}

async function writeTrace(pathname: string, events: RecordedTraceEvent[]): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

describe("eval trace evidence", () => {
  it("collects root, child, and teammate traces without exposing their absolute paths", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-evidence-"));
    tempRoots.push(attemptRoot);
    const rootPath = path.join(attemptRoot, "private", "root.jsonl");
    const childPath = path.join(attemptRoot, "private", "child.jsonl");
    const teammatePath = path.join(attemptRoot, "private", "teammate.jsonl");
    await writeTrace(childPath, [recorded(1, { answer: "child", round: 1, type: "final_answer" }, "child")]);
    await writeTrace(teammatePath, [recorded(1, { answer: "idle", round: 1, type: "final_answer" }, "mate")]);
    await writeTrace(rootPath, [
      recorded(1, {
        childSessionId: "child",
        parentCallId: "delegate",
        profile: "research",
        round: 1,
        runInBackground: true,
        task: "read child",
        tracePath: childPath,
        type: "child_session_started",
      }, "root"),
      recorded(2, {
        name: "researcher",
        profile: "research",
        sessionId: "mate",
        state: "starting",
        tracePath: teammatePath,
        type: "teammate_registered",
        unreadCount: 1,
      }, "root"),
    ]);

    const sessions = await collectEvalTraceSessions({ attemptRoot, rootTracePath: rootPath });

    expect(sessions.map((session) => ({
      name: session.name,
      profile: session.profile,
      role: session.role,
      sessionId: session.sessionId,
    }))).toEqual([
      { name: undefined, profile: undefined, role: "root", sessionId: "root" },
      { name: undefined, profile: "research", role: "child", sessionId: "child" },
      { name: "researcher", profile: "research", role: "teammate", sessionId: "mate" },
    ]);
  });

  it("rejects malformed JSONL and trace paths outside the attempt", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-evidence-"));
    tempRoots.push(attemptRoot);
    const malformed = path.join(attemptRoot, "malformed.jsonl");
    await fs.writeFile(malformed, "{not-json}\n", "utf8");

    await expect(readEvalTrace(malformed)).rejects.toThrow(/malformed trace JSON/);
    await expect(collectEvalTraceSessions({
      attemptRoot,
      rootTracePath: path.join(os.tmpdir(), "outside.jsonl"),
    })).rejects.toThrow(/inside the eval attempt/);
  });

  it("rejects missing event fields and unknown event types", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-evidence-"));
    tempRoots.push(root);
    const missing = path.join(root, "missing.jsonl");
    await fs.writeFile(missing, `${JSON.stringify({
      callId: "call-1",
      round: 1,
      sequence: 1,
      sessionId: "root",
      timestamp: "2026-08-03T00:00:00.000Z",
      toolName: "read",
      type: "tool_call",
    })}\n`, "utf8");
    await expect(readEvalTrace(missing)).rejects.toThrow(/invalid trace event.*line 1/);

    const unknown = path.join(root, "unknown.jsonl");
    await fs.writeFile(unknown, `${JSON.stringify({
      sequence: 1,
      sessionId: "root",
      timestamp: "2026-08-03T00:00:00.000Z",
      type: "future_event",
    })}\n`, "utf8");
    await expect(readEvalTrace(unknown)).rejects.toThrow(/invalid trace event.*line 1/);
  });

  it("requires contiguous sequences beginning at one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-evidence-"));
    tempRoots.push(root);
    const tracePath = path.join(root, "gap.jsonl");
    await writeTrace(tracePath, [
      recorded(1, VALID_TRACE_PAYLOADS.model_request, "root"),
      recorded(3, VALID_TRACE_PAYLOADS.final_answer, "root"),
    ]);

    await expect(readEvalTrace(tracePath)).rejects.toThrow(/expected sequence 2.*received 3/);
  });

  it("parses a valid fixture for every trace event discriminator", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-evidence-"));
    tempRoots.push(root);
    const tracePath = path.join(root, "all-events.jsonl");
    const payloads = Object.values(VALID_TRACE_PAYLOADS);
    await writeTrace(
      tracePath,
      payloads.map((payload, index) => recorded(index + 1, payload, "root")),
    );

    const events = await readEvalTrace(tracePath);

    expect(events).toHaveLength(49);
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(Object.keys(VALID_TRACE_PAYLOADS)));
  });

  it("rejects invalid envelopes, unexpected fields, and nested trace payloads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-evidence-"));
    tempRoots.push(root);
    const invalidEvents: unknown[] = [
      { ...recorded(1, VALID_TRACE_PAYLOADS.final_answer, "root"), unexpected: true },
      { ...recorded(1, VALID_TRACE_PAYLOADS.final_answer, "root"), round: 0 },
      { ...recorded(1, VALID_TRACE_PAYLOADS.final_answer, "root"), sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...recorded(1, VALID_TRACE_PAYLOADS.final_answer, "root"), timestamp: "August 3, 2026" },
      {
        ...recorded(1, VALID_TRACE_PAYLOADS.model_response, "root"),
        telemetry: { durationMs: 10, unexpected: true },
      },
      {
        ...recorded(1, VALID_TRACE_PAYLOADS.session_started, "root"),
        workspace: { baseBranch: "main", branch: "work/task", mode: "git_worktree", path: "/work" },
      },
      {
        ...recorded(1, VALID_TRACE_PAYLOADS.plugin_activation_result, "root"),
        components: {
          ...VALID_TRACE_PAYLOADS.plugin_activation_result.components,
          hooks: {
            active: [],
            declared: [],
            failed: [{ id: "audit", reason: "failed", unexpected: true }],
          },
        },
      },
      {
        ...recorded(1, VALID_TRACE_PAYLOADS.tool_result, "root"),
        taskGraph: {
          error: { code: "future_failure", message: "bad" },
          health: "degraded",
          revision: 1,
        },
      },
      {
        ...recorded(1, VALID_TRACE_PAYLOADS.completion_gate_failed, "root"),
        problems: [{ code: "graph_degraded", message: "bad", unexpected: true }],
      },
      {
        ...recorded(1, VALID_TRACE_PAYLOADS.task_state_updated, "root"),
        taskState: {
          acceptance: ["done"],
          items: [
            { id: "step-1", status: "in_progress", title: "First" },
            { id: "step-2", status: "in_progress", title: "Second" },
          ],
          summary: "invalid",
        },
      },
      {
        ...recorded(1, VALID_TRACE_PAYLOADS.task_state_updated, "root"),
        taskState: {
          ...VALID_TRACE_PAYLOADS.task_state_updated.taskState,
          unexpected: true,
        },
      },
    ];

    for (const [index, event] of invalidEvents.entries()) {
      const tracePath = path.join(root, `invalid-${index}.jsonl`);
      await fs.writeFile(tracePath, `${JSON.stringify(event)}\n`, "utf8");
      await expect(readEvalTrace(tracePath), `invalid fixture ${index}`).rejects.toThrow(
        /invalid trace event.*line 1/,
      );
    }
  });
});
