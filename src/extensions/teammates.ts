import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_MAX_TOOL_ROUNDS, DEFAULT_MODEL } from "../core/minimalLoop.js";
import {
  MAX_TEAMMATES_PER_ROOT,
  TEAM_DEFINITION_SCHEMA_VERSION,
  TEAM_RUNTIME_SCHEMA_VERSION,
  TEAMMATE_READY_TIMEOUT_MS,
  TEAMMATE_SHUTDOWN_TIMEOUT_MS,
  TEAMMATE_TERMINATE_TIMEOUT_MS,
  type MessageDelivery,
  type TeammateBroadcastInput,
  type TeammateBroadcastResult,
  type TeammateDefinition,
  type TeammateDeliveryResult,
  type TeammateLifecycleState,
  type TeammateProcess,
  type TeammateProcessAdapter,
  type TeammateRejoinInput,
  type TeammateRuntime,
  type TeammateSendInput,
  type TeammateStartInput,
  type TeammateSummary,
  type TeammateToLeaderMessage,
  type TeammateWorkerConfig,
  type TeammateWorkspaceFactory,
} from "../domain/teammate.js";
import type { PermissionApprover } from "../governance/types.js";
import {
  createSessionId,
  type SessionTaskGraphBinding,
} from "../runtime/session.js";
import { createFileTeamTaskStore } from "../runtime/teamTaskStore.js";
import {
  createFileMailboxStore,
  MAX_TEAMMATE_NAME_LENGTH,
  TEAMMATE_NAME_PATTERN,
  type AppendTeamMessageInput,
  type MailboxStore,
  type TeamMessage,
} from "../runtime/teamMailbox.js";
import type { LifecycleEmitter } from "./lifecycle.js";
import { createGitTeammateWorkspace } from "../runtime/workspace.js";
import { createNodeTeammateProcessAdapter } from "./teammateProcess.js";

export * from "../domain/teammate.js";
export { createNodeTeammateProcessAdapter } from "./teammateProcess.js";

export interface CreateTeammateManagerOptions {
  approver?: PermissionApprover;
  baseCwd: string;
  lifecycleEmitter: LifecycleEmitter;
  mailboxStore?: MailboxStore;
  model?: string;
  now?: () => Date;
  onLog?: (message: string) => void;
  processAdapter?: TeammateProcessAdapter;
  readyTimeoutMs?: number;
  rootSessionId: string;
  sessionId?: () => string;
  shutdownTimeoutMs?: number;
  taskGraph?: SessionTaskGraphBinding;
  teamRoot: string;
  terminateTimeoutMs?: number;
  workspaceFactory?: TeammateWorkspaceFactory;
}

export interface TeammateManager {
  broadcast(input: TeammateBroadcastInput): Promise<TeammateBroadcastResult>;
  close(): Promise<void>;
  drainLeaderMessages(): Promise<TeamMessage[]>;
  flushEvents(): Promise<void>;
  initialize(): Promise<void>;
  list(): Promise<TeammateSummary[]>;
  rejoin(input: TeammateRejoinInput): Promise<TeammateSummary>;
  sendMessage(input: TeammateSendInput): Promise<TeammateDeliveryResult>;
  settleBeforeFinal(): Promise<TeamMessage[]>;
  start(input: TeammateStartInput): Promise<TeammateSummary>;
  terminateAll(): Promise<void>;
}

interface ManagedTeammate {
  definition: TeammateDefinition;
  process?: TeammateProcess;
  processExit?: Deferred<void>;
  ready?: Deferred<void>;
  recoveryMessageId?: string;
  runtime: TeammateRuntime;
}

export function createTeammateManager(options: CreateTeammateManagerOptions): TeammateManager {
  const now = options.now ?? (() => new Date());
  const mailboxStore = options.mailboxStore ?? createFileMailboxStore({ teamRoot: options.teamRoot });
  const processAdapter = options.processAdapter ?? createNodeTeammateProcessAdapter();
  const allocateSessionId = options.sessionId ?? (() => createSessionId(now()));
  const readyTimeoutMs = options.readyTimeoutMs ?? TEAMMATE_READY_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? TEAMMATE_SHUTDOWN_TIMEOUT_MS;
  const terminateTimeoutMs = options.terminateTimeoutMs ?? TEAMMATE_TERMINATE_TIMEOUT_MS;
  const workspaceFactory = options.workspaceFactory ?? {
    async create(input: { baseCwd: string; name: string; rootSessionId: string }) {
      const workspace = await createGitTeammateWorkspace(input);
      return {
        branch: workspace.branch,
        path: workspace.path,
      };
    },
  };
  const members = new Map<string, ManagedTeammate>();
  let eventTail = Promise.resolve();
  let approvalTail = Promise.resolve();
  let activityVersion = 0;
  const activityWaiters = new Set<() => void>();

  const notifyActivity = (): void => {
    activityVersion += 1;
    for (const waiter of activityWaiters) {
      waiter();
    }
    activityWaiters.clear();
  };

  const queueEvent = (action: () => Promise<void>): void => {
    eventTail = eventTail.then(action, action);
  };

  const persistDefinition = async (definition: TeammateDefinition): Promise<void> => {
    const directory = teammateDirectory(options.teamRoot, definition.name);
    await fs.mkdir(directory, { recursive: true });
    const pathname = path.join(directory, "definition.json");
    try {
      await fs.writeFile(pathname, `${JSON.stringify(definition, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`teammate "${definition.name}" already exists`);
      }
      throw error;
    }
  };

  const persistRuntime = async (runtime: TeammateRuntime): Promise<void> => {
    const directory = teammateDirectory(options.teamRoot, runtime.name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "runtime.json"),
      `${JSON.stringify(runtime, null, 2)}\n`,
      "utf8",
    );
  };

  const appendMailbox = async (input: AppendTeamMessageInput): Promise<TeamMessage> => {
    const message = await mailboxStore.append(input);
    await options.lifecycleEmitter.emit({
      from: message.from,
      kind: message.kind,
      messageId: message.id,
      to: message.to,
      type: "team_mailbox_message_persisted",
    });
    options.onLog?.(
      `[mailbox] id=${message.id} from=${message.from} to=${message.to} kind=${message.kind}`,
    );
    return message;
  };

  const claimMailbox = async (address: string): Promise<TeamMessage[]> => {
    const claim = await mailboxStore.claimUnread(address);
    if (claim.messages.length > 0) {
      await options.lifecycleEmitter.emit({
        address,
        messageIds: claim.messages.map((message) => message.id),
        type: "team_mailbox_claimed",
      });
    }
    return claim.messages;
  };

  const updateRuntime = async (
    member: ManagedTeammate,
    state: TeammateLifecycleState,
    failure?: string,
  ): Promise<void> => {
    if (member.runtime.state === state && member.runtime.failure === failure) {
      return;
    }
    const previousState = member.runtime.state;
    member.runtime = {
      name: member.definition.name,
      schemaVersion: TEAM_RUNTIME_SCHEMA_VERSION,
      sessionId: member.runtime.sessionId,
      state,
      tracePath: member.runtime.tracePath,
      updatedAt: now().toISOString(),
      ...(failure ? { failure } : {}),
    };
    await persistRuntime(member.runtime);
    const mailbox = await mailboxStore.inspect(member.definition.name);
    await options.lifecycleEmitter.emit({
      ...(failure ? { failure } : {}),
      name: member.definition.name,
      previousState,
      profile: member.definition.profile,
      sessionId: member.runtime.sessionId,
      state,
      tracePath: member.runtime.tracePath,
      type: "teammate_state_changed",
      unreadCount: mailbox.unreadCount,
      ...(member.definition.workspace
        ? { workspace: { ...member.definition.workspace } }
        : {}),
    });
    options.onLog?.(
      `[team] name=${member.definition.name} state=${state} session=${member.runtime.sessionId}`,
    );
    notifyActivity();
  };

  const dispatchUnread = async (member: ManagedTeammate): Promise<boolean> => {
    if (!member.process) {
      return false;
    }
    const claimedMessages = await claimMailbox(member.definition.name);
    if (claimedMessages.length === 0) {
      await updateRuntime(member, "idle");
      return false;
    }
    const messages = member.recoveryMessageId
      ? [
          ...claimedMessages.filter((message) => message.id === member.recoveryMessageId),
          ...claimedMessages.filter((message) => message.id !== member.recoveryMessageId),
        ]
      : claimedMessages;
    member.recoveryMessageId = undefined;
    await updateRuntime(member, "busy");
    member.process.send({
      messages,
      sessionId: member.runtime.sessionId,
      type: "run_batch",
    });
    return true;
  };

  const failMember = async (member: ManagedTeammate, reason: string): Promise<void> => {
    if (member.runtime.state === "failed" || member.runtime.state === "stopped") {
      return;
    }
    await updateRuntime(member, "failed", reason);
    await appendMailbox({
      content: `${member.definition.name} failed: ${reason}`,
      from: member.definition.name,
      kind: "failure_notice",
      sessionId: member.runtime.sessionId,
      to: "leader",
    });
    notifyActivity();
  };

  const handleWorkerMessage = async (
    member: ManagedTeammate,
    message: TeammateToLeaderMessage,
  ): Promise<void> => {
    if (message.sessionId !== member.runtime.sessionId) {
      return;
    }
    if (message.type === "ready") {
      member.ready?.resolve();
      notifyActivity();
      return;
    }
    if (message.type === "turn_result") {
      if (member.runtime.state !== "busy") {
        return;
      }
      await appendMailbox({
        ...(member.definition.profile === "edit" && message.changedFiles
          ? { changedFiles: [...message.changedFiles].sort() }
          : {}),
        content: message.finalAnswer,
        from: member.definition.name,
        kind: "turn_result",
        sessionId: member.runtime.sessionId,
        to: "leader",
        ...(member.definition.workspace
          ? { workspace: { ...member.definition.workspace } }
          : {}),
      });
      await updateRuntime(member, "idle");
      await dispatchUnread(member);
      notifyActivity();
      return;
    }
    if (message.type === "failure") {
      await failMember(member, appendProcessTail(message.reason, member.process));
      return;
    }
    if (message.type === "message_request") {
      let result: TeammateDeliveryResult | { error: string };
      try {
        result = await sendMessage({
          content: message.content,
          from: member.definition.name,
          to: message.to,
        });
      } catch (error) {
        result = { error: errorMessage(error) };
      }
      member.process?.send({
        requestId: message.requestId,
        result,
        sessionId: member.runtime.sessionId,
        type: "message_result",
      });
      return;
    }
    if (message.type === "list_request") {
      member.process?.send({
        members: await list(),
        requestId: message.requestId,
        sessionId: member.runtime.sessionId,
        type: "list_result",
      });
      return;
    }

    if (member.definition.profile !== "edit") {
      member.process?.send({
        approved: false,
        reason: "research teammates cannot request edit/write approval",
        requestId: message.requestId,
        sessionId: member.runtime.sessionId,
        type: "approval_result",
      });
      return;
    }

    const brokerApproval = async () => {
      let result;
      try {
        result = options.approver
          ? await options.approver.approve({
              decision: {
                action: "ask",
                reason: `[${member.definition.name}] ${message.reason}`,
                risk: message.risk,
              },
              toolCall: {
                arguments: message.argumentsText,
                name: message.toolName,
              },
            })
          : { approved: false, reason: "no Leader approval UI is available" };
      } catch (error) {
        result = {
          approved: false,
          reason: `Leader approval failed: ${errorMessage(error)}`,
        };
      }
      await options.lifecycleEmitter.emit({
        approved: result.approved,
        name: member.definition.name,
        requestId: message.requestId,
        sessionId: member.runtime.sessionId,
        toolName: message.toolName,
        type: "teammate_approval_brokered",
      });
      member.process?.send({
        approved: result.approved,
        ...(result.reason ? { reason: result.reason } : {}),
        requestId: message.requestId,
        sessionId: member.runtime.sessionId,
        type: "approval_result",
      });
      notifyActivity();
    };
    approvalTail = approvalTail.then(brokerApproval, brokerApproval);
    await approvalTail;
  };

  const attachProcess = (member: ManagedTeammate, process: TeammateProcess): void => {
    member.process = process;
    member.processExit = createDeferred<void>();
    process.onMessage((message) => {
      queueEvent(() => handleWorkerMessage(member, message));
    });
    process.onExit((code, signal) => {
      member.processExit?.resolve();
      queueEvent(async () => {
        if (member.process !== process) {
          return;
        }
        member.process = undefined;
        if (member.runtime.state !== "failed" && member.runtime.state !== "stopped") {
          await failMember(
            member,
            appendProcessTail(
              `worker exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
              process,
            ),
          );
        }
      });
    });
  };

  const startProcess = async (member: ManagedTeammate): Promise<void> => {
    const config: TeammateWorkerConfig = {
      baseCwd: options.baseCwd,
      cwd: member.definition.workspace?.path ?? options.baseCwd,
      definition: member.definition,
      model: options.model ?? DEFAULT_MODEL,
      rootSessionId: options.rootSessionId,
      sessionId: member.runtime.sessionId,
      ...(options.taskGraph
        ? {
            taskGraph: {
              ...(member.definition.taskId ? { delegatedTaskId: member.definition.taskId } : {}),
              rootSessionId: options.taskGraph.rootSessionId,
              taskGraphPath: options.taskGraph.taskGraphPath,
            },
          }
        : {}),
      tracePath: member.runtime.tracePath,
    };
    const process = processAdapter.fork(config);
    const ready = createDeferred<void>();
    member.ready = ready;
    attachProcess(member, process);
    process.send({
      config,
      sessionId: member.runtime.sessionId,
      type: "initialize",
    });

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`teammate "${member.definition.name}" ready timeout`)),
            readyTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      await failMember(member, errorMessage(error));
      process.kill("SIGTERM");
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      member.ready = undefined;
    }
  };

  const toSummary = async (member: ManagedTeammate): Promise<TeammateSummary> => {
    const mailbox = await mailboxStore.inspect(member.definition.name);
    return {
      ...(member.runtime.failure ? { failure: member.runtime.failure } : {}),
      name: member.definition.name,
      profile: member.definition.profile,
      sessionId: member.runtime.sessionId,
      state: member.runtime.state,
      tracePath: member.runtime.tracePath,
      unreadCount: mailbox.unreadCount,
      ...(member.definition.workspace ? { workspace: { ...member.definition.workspace } } : {}),
    };
  };

  const list = async (): Promise<TeammateSummary[]> =>
    Promise.all(
      [...members.values()]
        .sort((left, right) => left.definition.name.localeCompare(right.definition.name))
        .map((member) => toSummary(member)),
    );

  const sendMessage = async (input: TeammateSendInput): Promise<TeammateDeliveryResult> => {
    validateMessageText(input.content, "message content");
    validateMailboxActor(input.from);
    validateMailboxActor(input.to);
    if (input.from === input.to) {
      throw new Error("message recipient cannot be self");
    }
    if (input.to === "leader") {
      if (input.from === "leader" || !members.has(input.from)) {
        throw new Error(`unknown message sender "${input.from}"`);
      }
      const message = await appendMailbox({
        content: input.content,
        from: input.from,
        kind: "direct",
        to: "leader",
      });
      notifyActivity();
      return {
        delivery: "woken",
        messageId: message.id,
        to: "leader",
      };
    }

    const member = members.get(input.to);
    if (!member) {
      throw new Error(`unknown teammate "${input.to}"`);
    }
    if (input.from !== "leader" && !members.has(input.from)) {
      throw new Error(`unknown message sender "${input.from}"`);
    }
    if (member.runtime.state === "stopped") {
      throw new Error(`teammate "${input.to}" is stopped`);
    }

    const message = await appendMailbox({
      content: input.content,
      from: input.from,
      kind: "direct",
      to: input.to,
    });
    let delivery: MessageDelivery;
    if (member.runtime.state === "idle") {
      await dispatchUnread(member);
      delivery = "woken";
    } else if (member.runtime.state === "starting") {
      delivery = "queued_starting";
    } else if (member.runtime.state === "busy") {
      delivery = "queued_busy";
    } else {
      delivery = "queued_offline";
    }
    notifyActivity();
    return {
      delivery,
      messageId: message.id,
      to: input.to,
    };
  };

  const waitForActivity = async (version: number): Promise<void> => {
    if (activityVersion !== version) {
      return;
    }
    await new Promise<void>((resolve) => {
      activityWaiters.add(resolve);
      if (activityVersion !== version) {
        activityWaiters.delete(resolve);
        resolve();
      }
    });
  };

  const stopProcess = async (
    member: ManagedTeammate,
    graceful: boolean,
  ): Promise<void> => {
    const process = member.process;
    const exited = member.processExit;
    if (!process) {
      return;
    }
    if (graceful) {
      process.send({
        sessionId: member.runtime.sessionId,
        type: "shutdown",
      });
      if (exited && await resolvesWithin(exited.promise, shutdownTimeoutMs)) {
        return;
      }
    }
    process.kill("SIGTERM");
    if (exited && await resolvesWithin(exited.promise, terminateTimeoutMs)) {
      return;
    }
    process.kill("SIGKILL");
    process.disconnect();
  };

  return {
    async broadcast(input) {
      if (input.from !== "leader") {
        throw new Error("only Leader may broadcast");
      }
      validateMessageText(input.content, "broadcast content");
      const snapshot = [...members.values()]
        .filter((member) => member.runtime.state !== "stopped")
        .map((member) => member.definition.name)
        .sort();
      const result: TeammateBroadcastResult = {
        delivered: [],
        failed: [],
      };
      for (const recipient of snapshot) {
        try {
          const member = members.get(recipient);
          if (!member) {
            throw new Error(`unknown teammate "${recipient}"`);
          }
          const message = await appendMailbox({
            content: input.content,
            from: "leader",
            kind: "broadcast",
            to: recipient,
          });
          let delivery: MessageDelivery;
          if (member.runtime.state === "idle") {
            await dispatchUnread(member);
            delivery = "woken";
          } else if (member.runtime.state === "starting") {
            delivery = "queued_starting";
          } else if (member.runtime.state === "busy") {
            delivery = "queued_busy";
          } else {
            delivery = "queued_offline";
          }
          result.delivered.push({
            delivery,
            messageId: message.id,
            to: recipient,
          });
        } catch (error) {
          result.failed.push({ reason: errorMessage(error), to: recipient });
        }
      }
      await options.lifecycleEmitter.emit({
        delivered: result.delivered.map((delivery) => delivery.to),
        failed: result.failed.map((failure) => ({ ...failure })),
        type: "team_broadcast_result",
      });
      notifyActivity();
      return result;
    },
    async close() {
      await eventTail;
      await approvalTail;
      const idle = [...members.values()].filter(
        (member) => member.runtime.state === "idle" && member.process,
      );
      for (const member of idle) {
        await updateRuntime(member, "stopped");
        await stopProcess(member, true);
      }
      await options.lifecycleEmitter.emit({
        mode: "graceful",
        stopped: idle.map((member) => member.definition.name),
        type: "team_cleanup",
      });
    },
    async drainLeaderMessages() {
      return claimMailbox("leader");
    },
    async flushEvents() {
      await eventTail;
      await approvalTail;
      await eventTail;
    },
    async initialize() {
      await fs.mkdir(path.join(options.teamRoot, "teammates"), { recursive: true });
      await mailboxStore.initialize("leader");
    },
    list,
    async rejoin(input) {
      const member = members.get(input.name);
      if (!member) {
        throw new Error(`unknown teammate "${input.name}"`);
      }
      if (member.runtime.state !== "failed") {
        throw new Error(`teammate "${input.name}" can rejoin only from failed state`);
      }
      validateMessageText(input.recovery, "recovery");
      const previousSessionId = member.runtime.sessionId;
      const recovery = await appendMailbox({
        content: input.recovery,
        from: "leader",
        kind: "direct",
        to: input.name,
      });
      member.recoveryMessageId = recovery.id;
      const sessionId = allocateSessionId();
      member.runtime = createRuntime(member.definition.name, sessionId, options.teamRoot, now);
      await persistRuntime(member.runtime);
      await options.lifecycleEmitter.emit({
        name: member.definition.name,
        previousSessionId,
        recoveryMessageId: recovery.id,
        sessionId,
        tracePath: member.runtime.tracePath,
        type: "teammate_rejoined",
      });
      await startProcess(member);
      await dispatchUnread(member);
      return toSummary(member);
    },
    sendMessage,
    async settleBeforeFinal() {
      while (true) {
        await eventTail;
        await approvalTail;
        const leaderMessages = await claimMailbox("leader");
        if (leaderMessages.length > 0) {
          return leaderMessages;
        }
        const blocked = [...members.values()].some(
          (member) => member.runtime.state === "starting" || member.runtime.state === "busy",
        );
        if (!blocked) {
          return [];
        }
        const version = activityVersion;
        await waitForActivity(version);
      }
    },
    async start(input) {
      validateTeammateName(input.name);
      validateMessageText(input.instructions, "teammate instructions");
      validateMessageText(input.message, "initial teammate message");
      if (input.profile !== "research" && input.profile !== "edit") {
        throw new Error('teammate profile must be "research" or "edit"');
      }
      if (members.has(input.name)) {
        throw new Error(`teammate "${input.name}" already exists`);
      }
      if (members.size >= MAX_TEAMMATES_PER_ROOT) {
        throw new Error(`root session supports at most ${MAX_TEAMMATES_PER_ROOT} teammates`);
      }
      const maxToolRounds = input.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
      if (!Number.isSafeInteger(maxToolRounds) || maxToolRounds < 1) {
        throw new Error("maxToolRounds must be a positive integer");
      }
      if (input.taskId && !options.taskGraph) {
        throw new Error("teammate taskId requires a root task graph binding");
      }
      if (input.taskId && options.taskGraph) {
        const task = await createFileTeamTaskStore({
          graphPath: options.taskGraph.taskGraphPath,
        }).get(input.taskId);
        if (task.task.status !== "in_progress") {
          throw new Error(
            `teammate taskId "${input.taskId}" must reference an in_progress team task`,
          );
        }
      }
      const workspace = input.profile === "edit"
        ? await workspaceFactory.create({
            baseCwd: options.baseCwd,
            name: input.name,
            rootSessionId: options.rootSessionId,
          })
        : undefined;
      const definition: TeammateDefinition = {
        createdAt: now().toISOString(),
        instructions: input.instructions.trim(),
        maxToolRounds,
        name: input.name,
        profile: input.profile,
        schemaVersion: TEAM_DEFINITION_SCHEMA_VERSION,
        ...(input.taskId ? { taskId: input.taskId.trim() } : {}),
        ...(workspace ? { workspace } : {}),
      };
      const sessionId = allocateSessionId();
      const member: ManagedTeammate = {
        definition,
        runtime: createRuntime(input.name, sessionId, options.teamRoot, now),
      };
      await persistDefinition(definition);
      await persistRuntime(member.runtime);
      members.set(input.name, member);
      await mailboxStore.initialize(input.name);
      await appendMailbox({
        content: input.message,
        from: "leader",
        kind: "direct",
        to: input.name,
      });
      await options.lifecycleEmitter.emit({
        name: definition.name,
        profile: definition.profile,
        sessionId: member.runtime.sessionId,
        state: "starting",
        tracePath: member.runtime.tracePath,
        type: "teammate_registered",
        unreadCount: 1,
        ...(definition.workspace ? { workspace: { ...definition.workspace } } : {}),
      });
      await startProcess(member);
      await dispatchUnread(member);
      return toSummary(member);
    },
    async terminateAll() {
      const stopped: string[] = [];
      for (const member of members.values()) {
        if (member.runtime.state !== "failed" && member.runtime.state !== "stopped") {
          await updateRuntime(member, "stopped");
          stopped.push(member.definition.name);
        }
        await stopProcess(member, false);
      }
      await options.lifecycleEmitter.emit({
        mode: "terminate",
        stopped,
        type: "team_cleanup",
      });
    },
  };
}

async function resolvesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function createRuntime(
  name: string,
  sessionId: string,
  teamRoot: string,
  now: () => Date,
): TeammateRuntime {
  return {
    name,
    schemaVersion: TEAM_RUNTIME_SCHEMA_VERSION,
    sessionId,
    state: "starting",
    tracePath: path.join(
      teammateDirectory(teamRoot, name),
      "sessions",
      sessionId,
      "trace.jsonl",
    ),
    updatedAt: now().toISOString(),
  };
}

function teammateDirectory(teamRoot: string, name: string): string {
  return path.join(teamRoot, "teammates", name);
}

function validateTeammateName(name: string): void {
  if (
    typeof name !== "string"
    || name === "leader"
    || name.length < 1
    || name.length > MAX_TEAMMATE_NAME_LENGTH
    || !TEAMMATE_NAME_PATTERN.test(name)
  ) {
    throw new Error(
      `teammate name must match ${TEAMMATE_NAME_PATTERN.source}, use 1..${MAX_TEAMMATE_NAME_LENGTH} characters, and not be "leader"`,
    );
  }
}

function validateMailboxActor(name: string): void {
  if (name === "leader") {
    return;
  }
  validateTeammateName(name);
}

function validateMessageText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendProcessTail(reason: string, process: TeammateProcess | undefined): string {
  const tail = process?.outputTail?.();
  const stdout = tail?.stdout.trim();
  const stderr = tail?.stderr.trim();
  return [
    reason,
    ...(stdout ? [`stdout tail: ${stdout}`] : []),
    ...(stderr ? [`stderr tail: ${stderr}`] : []),
  ].join("; ");
}
