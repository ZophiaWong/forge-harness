import fs from "node:fs/promises";
import path from "node:path";

import { loadRepoPromptAssets } from "../context/promptAssembly.js";
import {
  createMinimalLoopSession,
  type MinimalLoopSession,
  type ResponseCreate,
} from "../core/minimalLoop.js";
import { createChildProfileToolRuntime, listChangedFiles } from "../extensions/childSessions.js";
import { createLifecycleEmitter } from "../extensions/lifecycle.js";
import type {
  LeaderToTeammateMessage,
  TeammateDeliveryResult,
  TeammateManager,
  TeammateSummary,
  TeammateToLeaderMessage,
  TeammateWorkerConfig,
} from "../extensions/teammates.js";
import { createDefaultPermissionPolicy } from "../governance/defaultPolicy.js";
import type { PermissionApprover } from "../governance/types.js";
import { createGitIntegrationService } from "../runtime/gitIntegration.js";
import { createJsonlTraceRecorder } from "../runtime/traceRecorder.js";
import type { TeamMessage } from "../runtime/teamMailbox.js";
import { composeToolRuntimes } from "../tools/compositeRuntime.js";
import { createToolRuntime } from "../tools/runtime.js";
import { createTeammateTools } from "../tools/teammateTools.js";

export interface TeammateWorkerChannel {
  disconnect(): void;
  onMessage(listener: (message: LeaderToTeammateMessage) => void): void;
  send(message: TeammateToLeaderMessage): void;
}

export interface StartTeammateWorkerHostOptions {
  responseCreate?: ResponseCreate;
}

export function formatTeammateMailboxTurn(messages: TeamMessage[]): string {
  return [
    "<mailbox_batch>",
    ...messages.flatMap((message) => [
      "<mailbox_message>",
      `id: ${message.id}`,
      `from: ${message.from}`,
      `kind: ${message.kind}`,
      "content:",
      message.content,
      "</mailbox_message>",
    ]),
    "</mailbox_batch>",
  ].join("\n");
}

export function formatTeammateSessionTask(config: TeammateWorkerConfig): string {
  const profileContract = config.definition.profile === "research"
    ? [
        "Use the available read-only repository tools for investigation.",
        "Do not edit or write project files.",
      ]
    : [
        "Use edit and write only inside your stable isolated worktree.",
        "Describe changed files and evidence in each mailbox turn result.",
      ];
  return [
    `You are the long-lived teammate "${config.definition.name}".`,
    `Your stable profile is "${config.definition.profile}" for this root session.`,
    "Keep conversation history, todo state, tool state, and compaction state across mailbox turns.",
    "Treat every mailbox batch as one new user turn. Preserve each message id, sender, and kind when reasoning.",
    "TaskGraph is the shared coordination state across actors.",
    "Do not call todo unless the current Leader message explicitly requests local todo planning.",
    "For short mailbox protocols, call the requested TaskGraph tools directly and then return a final response.",
    ...profileContract,
    "You may use teammate_list and message_send. You may not delegate, broadcast, schedule cron work, or load MCP/plugin tools.",
    "Starting this teammate does not assign a task. Use task_transition claim for a ready unowned task, or wait for the Leader to assign one.",
    "For an edit task, submit a plan and wait for Leader approval before edit/write. Submit evidence and then submit_result when ready.",
    "",
    "Standing instructions:",
    config.definition.instructions,
  ].join("\n");
}

export function startTeammateWorkerHost(
  channel: TeammateWorkerChannel,
  options: StartTeammateWorkerHostOptions = {},
): void {
  let config: TeammateWorkerConfig | undefined;
  let session: MinimalLoopSession | undefined;
  let operationTail = Promise.resolve();
  let nextRequestSequence = 1;
  const pending = new Map<string, {
    reject(error: unknown): void;
    resolve(value: unknown): void;
  }>();

  const request = <T>(
    createMessage: (requestId: string, sessionId: string) => TeammateToLeaderMessage,
  ): Promise<T> => {
    if (!config) {
      return Promise.reject(new Error("teammate worker is not initialized"));
    }
    const requestId = `worker_req_${String(nextRequestSequence).padStart(6, "0")}`;
    nextRequestSequence += 1;
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, {
        reject,
        resolve: (value) => resolve(value as T),
      });
      channel.send(createMessage(requestId, config?.sessionId ?? ""));
    });
  };

  const managerProxy = (): TeammateManager => ({
    async broadcast() {
      throw new Error("teammates may not broadcast");
    },
    async close() {
      return undefined;
    },
    async drainLeaderMessages() {
      return [];
    },
    async flushEvents() {
      return undefined;
    },
    async initialize() {
      return undefined;
    },
    async list() {
      return request<TeammateSummary[]>((requestId, sessionId) => ({
        requestId,
        sessionId,
        type: "list_request",
      }));
    },
    async rejoin() {
      throw new Error("teammates may not rejoin members");
    },
    async resolveAssignee() {
      throw new Error("teammates may not resolve assignees");
    },
    async resolveEditSource() {
      throw new Error("teammates may not resolve other edit sources");
    },
    async sendMessage(input) {
      const result = await request<TeammateDeliveryResult | { error: string }>(
        (requestId, sessionId) => ({
          content: input.content,
          requestId,
          sessionId,
          to: input.to,
          type: "message_request",
        }),
      );
      if ("error" in result) {
        throw new Error(result.error);
      }
      return result;
    },
    async settleBeforeFinal() {
      return [];
    },
    async shutdown() {
      throw new Error("teammates may not shut down members");
    },
    async start() {
      throw new Error("teammates may not start members");
    },
    async terminateAll() {
      return undefined;
    },
  });

  const approver: PermissionApprover = {
    async approve(approval) {
      if (approval.toolCall.name !== "edit" && approval.toolCall.name !== "write") {
        return { approved: false, reason: "teammate approval broker accepts only edit/write" };
      }
      return request((requestId, sessionId) => ({
        argumentsText: approval.toolCall.arguments,
        reason: approval.decision.reason,
        requestId,
        risk: "mutating",
        sessionId,
        toolName: approval.toolCall.name as "edit" | "write",
        type: "approval_request",
      }));
    },
  };

  const initialize = async (message: Extract<LeaderToTeammateMessage, { type: "initialize" }>) => {
    if (config || session) {
      throw new Error("teammate worker was initialized more than once");
    }
    if (message.sessionId !== message.config.sessionId) {
      throw new Error("teammate worker initialize sessionId mismatch");
    }
    config = message.config;
    await fs.mkdir(path.dirname(config.tracePath), { recursive: true });
    await fs.writeFile(config.tracePath, "", { flag: "wx" });
    await fs.writeFile(
      path.join(path.dirname(config.tracePath), "session.json"),
      `${JSON.stringify({
        definition: config.definition,
        rootSessionId: config.rootSessionId,
        sessionId: config.sessionId,
        tracePath: config.tracePath,
      }, null, 2)}\n`,
      "utf8",
    );
    const lifecycleEmitter = createLifecycleEmitter({
      recorder: createJsonlTraceRecorder({
        sessionId: config.sessionId,
        tracePath: config.tracePath,
      }),
    });
    const profileRuntime = createChildProfileToolRuntime({
      cwd: config.cwd,
      gitIntegration: createGitIntegrationService({
        targetCwd: config.baseCwd,
      }),
      ...(config.definition.workspace
        ? { ownWorkspace: { ...config.definition.workspace } }
        : {}),
      profile: config.definition.profile,
      sessionId: config.sessionId,
      taskActor: {
        name: config.definition.name,
        profile: config.definition.profile,
        role: "teammate",
        sessionId: config.sessionId,
      },
      ...(config.taskGraph ? { taskGraph: config.taskGraph } : {}),
    });
    const teammateRuntime = createToolRuntime(createTeammateTools({
      actor: config.definition.name,
      manager: managerProxy(),
    }));
    session = await createMinimalLoopSession({
      approver,
      baseCwd: config.baseCwd,
      cwd: config.cwd,
      lifecycleEmitter,
      maxToolRounds: config.definition.maxToolRounds,
      model: config.model,
      permissionPolicy: createDefaultPermissionPolicy(),
      promptAssets: await loadRepoPromptAssets(config.baseCwd),
      ...(options.responseCreate ? { responseCreate: options.responseCreate } : {}),
      task: formatTeammateSessionTask(config),
      toolRuntime: composeToolRuntimes([profileRuntime, teammateRuntime]),
    });
    channel.send({ sessionId: config.sessionId, type: "ready" });
  };

  const runBatch = async (message: Extract<LeaderToTeammateMessage, { type: "run_batch" }>) => {
    if (!config || !session || message.sessionId !== config.sessionId) {
      return;
    }
    const result = await session.runTurn(
      formatTeammateMailboxTurn(message.messages),
      { maxToolRounds: config.definition.maxToolRounds },
    );
    const changedFiles = config.definition.profile === "edit"
      ? await listChangedFiles(config.cwd)
      : undefined;
    channel.send({
      ...(changedFiles ? { changedFiles } : {}),
      finalAnswer: result.finalAnswer,
      sessionId: config.sessionId,
      type: "turn_result",
      ...(config.definition.workspace ? { workspace: config.definition.workspace } : {}),
    });
  };

  const shutdown = async (message: Extract<LeaderToTeammateMessage, { type: "shutdown" }>) => {
    if (!config || message.sessionId !== config.sessionId) {
      return;
    }
    await session?.close("completed");
    channel.disconnect();
  };

  const fail = async (error: unknown): Promise<void> => {
    const reason = error instanceof Error ? error.message : String(error);
    if (config) {
      channel.send({
        reason,
        sessionId: config.sessionId,
        type: "failure",
      });
    }
    await session?.close("failed").catch(() => undefined);
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
    channel.disconnect();
  };

  channel.onMessage((message) => {
    if (
      message.type === "approval_result"
      || message.type === "list_result"
      || message.type === "message_result"
    ) {
      if (!config || message.sessionId !== config.sessionId) {
        return;
      }
      const waiter = pending.get(message.requestId);
      if (!waiter) {
        return;
      }
      pending.delete(message.requestId);
      if (message.type === "approval_result") {
        waiter.resolve({
          approved: message.approved,
          ...(message.reason ? { reason: message.reason } : {}),
        });
      } else if (message.type === "list_result") {
        waiter.resolve(message.members);
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    operationTail = operationTail.then(async () => {
      if (message.type === "initialize") {
        await initialize(message);
      } else if (message.type === "run_batch") {
        await runBatch(message);
      } else if (message.type === "shutdown") {
        await shutdown(message);
      }
    }).catch(fail);
  });
}

function createProcessChannel(): TeammateWorkerChannel {
  if (!process.send) {
    throw new Error("teammate worker requires a Node IPC channel");
  }
  return {
    disconnect() {
      if (process.connected) {
        process.disconnect();
      }
    },
    onMessage(listener) {
      process.on("message", (message) => {
        listener(message as LeaderToTeammateMessage);
      });
    },
    send(message) {
      process.send?.(message);
    },
  };
}

if (process.send) {
  startTeammateWorkerHost(createProcessChannel());
}
