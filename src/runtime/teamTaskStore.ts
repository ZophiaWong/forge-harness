import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import {
  TEAM_TASK_GRAPH_SCHEMA_VERSION,
  TeamTaskStoreError,
  availableTeamTaskActions,
  cloneTeamTask,
  cloneTeamTaskGraph,
  isTeamTaskReady,
  parseTeamTaskGraphFile,
  summarizeTeamTask,
  type AddTeamTaskEvidenceInput,
  type CreateTeamTaskInput,
  type RecordTeamTaskVerificationInput,
  type TeamTask,
  type TeamTaskActor,
  type TeamTaskActorIdentity,
  type TeamTaskAssignee,
  type TeamTaskEvidence,
  type TeamTaskEvidenceReference,
  type TeamTaskGetResult,
  type TeamTaskGraphFile,
  type TeamTaskIntegrationReceipt,
  type TeamTaskListResult,
  type TeamTaskMutationResult,
  type TeamTaskOwner,
  type TeamTaskResultSource,
  type TeamTaskTransitionInput,
  type UpdateTeamTaskPatch,
} from "../domain/teamTask.js";

export const TEAM_TASK_LOCK_RETRY_MS = 25;
export const TEAM_TASK_LOCK_TIMEOUT_MS = 1_000;

export interface FileTeamTaskStoreOptions {
  graphPath: string;
  now?: () => Date;
}

export interface TeamTaskStore {
  addEvidence(
    actor: TeamTaskActor,
    id: string,
    input: AddTeamTaskEvidenceInput,
  ): Promise<TeamTaskMutationResult>;
  create(actor: TeamTaskActor, input: CreateTeamTaskInput): Promise<TeamTaskMutationResult>;
  delete(actor: TeamTaskActor, id: string): Promise<TeamTaskMutationResult>;
  get(id: string): Promise<TeamTaskGetResult>;
  initialize(): Promise<TeamTaskGraphFile>;
  list(): Promise<TeamTaskListResult>;
  read(): Promise<TeamTaskGraphFile>;
  recordIntegration(
    actor: TeamTaskActor,
    id: string,
    receipt: TeamTaskIntegrationReceipt,
  ): Promise<TeamTaskMutationResult>;
  recordVerification(
    actor: TeamTaskActor,
    id: string,
    input: RecordTeamTaskVerificationInput,
  ): Promise<TeamTaskMutationResult>;
  transition(
    actor: TeamTaskActor,
    input: TeamTaskTransitionInput,
  ): Promise<TeamTaskMutationResult>;
  update(
    actor: TeamTaskActor,
    id: string,
    patch: UpdateTeamTaskPatch,
  ): Promise<TeamTaskMutationResult>;
}

export function createFileTeamTaskStore(options: FileTeamTaskStoreOptions): TeamTaskStore {
  const now = options.now ?? (() => new Date());
  const initializationPath = `${options.graphPath}.initialized`;
  const lockPath = `${options.graphPath}.lock`;
  let initialized = false;

  const load = async (): Promise<TeamTaskGraphFile> => {
    let raw: string;
    try {
      raw = await fs.readFile(options.graphPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new TeamTaskStoreError(
          "graph_missing",
          `task graph is missing at ${options.graphPath}`,
          "degraded",
        );
      }
      throw storeIoError("read task graph", error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new TeamTaskStoreError(
        "graph_malformed",
        `task graph contains malformed JSON: ${errorMessage(error)}`,
        "degraded",
      );
    }
    return parseTeamTaskGraphFile(parsed);
  };

  const write = async (graph: TeamTaskGraphFile): Promise<void> => {
    const directory = path.dirname(options.graphPath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(options.graphPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let handle: fs.FileHandle | undefined;
    let renamed = false;
    try {
      handle = await fs.open(temporaryPath, "wx");
      await handle.writeFile(`${JSON.stringify(graph, null, 2)}\n`, "utf8");
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, options.graphPath);
      renamed = true;
    } catch (error) {
      throw storeIoError("write task graph", error);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) {
        await fs.unlink(temporaryPath).catch(() => undefined);
      }
    }
  };

  const withWriteLock = async <T>(
    action: () => Promise<T>,
    committedMutationFromResult?: (result: T) => TeamTaskMutationResult,
  ): Promise<T> => {
    const lock = await acquireLock(lockPath);
    let completed = false;
    let result: T | undefined;
    try {
      result = await action();
      completed = true;
      return result;
    } finally {
      try {
        await releaseLock(lock, lockPath);
      } catch (error) {
        if (completed && committedMutationFromResult) {
          throw cleanupErrorWithCommittedMutation(error, committedMutationFromResult(result as T));
        }
        throw error;
      }
    }
  };

  const mutate = async (
    change: (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision">,
  ): Promise<TeamTaskMutationResult> => withWriteLock(
    async () => {
      const graph = await load();
      const result = change(graph);
      graph.revision += 1;
      const validated = parseTeamTaskGraphFile(graph);
      await write(validated);
      return {
        ...result,
        revision: validated.revision,
        task: cloneTeamTask(result.task),
      };
    },
    (result) => result,
  );

  return {
    async addEvidence(actor, id, input) {
      return mutate(addEvidenceMutation(actor, id, input, now));
    },
    async create(actor, input) {
      return mutate(createMutation(actor, input, now));
    },
    async delete(actor, id) {
      return mutate(deleteMutation(actor, id));
    },
    async get(id) {
      const graph = await load();
      const task = findTask(graph, id);
      return {
        availableActions: availableTeamTaskActions(graph, task),
        ready: isTeamTaskReady(graph, task),
        revision: graph.revision,
        task: cloneTeamTask(task),
      };
    },
    async initialize() {
      if (initialized) {
        return cloneTeamTaskGraph(await load());
      }
      try {
        await fs.mkdir(path.dirname(options.graphPath), { recursive: true });
      } catch (error) {
        throw storeIoError("prepare task graph directory", error);
      }
      const graph = await withWriteLock(async () => {
        const graphExists = await fileExists(options.graphPath);
        const markerExists = await fileExists(initializationPath);
        if (graphExists) {
          if (!markerExists) {
            await ensureInitializationMarker(initializationPath);
          }
          return cloneTeamTaskGraph(await load());
        }
        if (markerExists) {
          throw new TeamTaskStoreError(
            "graph_missing",
            `task graph is missing at ${options.graphPath}`,
            "degraded",
          );
        }
        const initial: TeamTaskGraphFile = {
          nextTaskSequence: 1,
          revision: 0,
          schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
          tasks: [],
        };
        await write(initial);
        await ensureInitializationMarker(initializationPath);
        return cloneTeamTaskGraph(initial);
      });
      initialized = true;
      return graph;
    },
    async list() {
      const graph = await load();
      return {
        revision: graph.revision,
        tasks: graph.tasks
          .slice()
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((task) => summarizeTeamTask(graph, task)),
      };
    },
    async read() {
      return cloneTeamTaskGraph(await load());
    },
    async recordIntegration(actor, id, receipt) {
      return mutate(recordIntegrationMutation(actor, id, receipt, now));
    },
    async recordVerification(actor, id, input) {
      return mutate(recordVerificationMutation(actor, id, input, now));
    },
    async transition(actor, input) {
      return mutate(transitionMutation(actor, input, now));
    },
    async update(actor, id, patch) {
      return mutate(updateMutation(actor, id, patch, now));
    },
  };
}

function createMutation(
  actor: TeamTaskActor,
  input: CreateTeamTaskInput,
  now: () => Date,
): (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision"> {
  return (graph) => {
    requireLeader(actor);
    const normalized = normalizeCreateInput(input);
    const id = `task_${String(graph.nextTaskSequence).padStart(3, "0")}`;
    validateDependencies(graph, id, normalized.dependencies);
    const timestamp = now().toISOString();
    const task: TeamTask = {
      acceptance: normalized.acceptance,
      createdAt: timestamp,
      dependencies: normalized.dependencies,
      description: normalized.description,
      evidence: [],
      id,
      kind: normalized.kind,
      status: "pending",
      title: normalized.title,
      trace: [],
      transferCount: 0,
      updatedAt: timestamp,
      ...(normalized.verificationCommand
        ? { verificationCommand: normalized.verificationCommand }
        : {}),
    };
    graph.nextTaskSequence += 1;
    graph.tasks.push(task);
    return {
      nextStatus: "pending",
      operation: "create",
      task,
    };
  };
}

function updateMutation(
  actor: TeamTaskActor,
  id: string,
  patch: UpdateTeamTaskPatch,
  now: () => Date,
): (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision"> {
  return (graph) => {
    requireLeader(actor);
    const task = findTask(graph, id);
    if (task.status !== "pending" || task.owner !== undefined) {
      throw requestError("contract_frozen", `task "${id}" contract froze when it was acquired`);
    }
    const previousContract = contractSnapshot(task);
    const normalized = normalizeUpdatePatch(patch, task);
    Object.assign(task, normalized);
    validateDependencies(graph, id, task.dependencies);
    task.updatedAt = now().toISOString();
    pushTrace(graph, task, now, "contract_updated", undefined, undefined, undefined, {
      contract: previousContract,
    });
    validateCandidateGraph(graph);
    return { operation: "update", task };
  };
}

function deleteMutation(
  actor: TeamTaskActor,
  id: string,
): (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision"> {
  return (graph) => {
    requireLeader(actor);
    const task = findTask(graph, id);
    const hasDependents = graph.tasks.some(
      (candidate) => candidate.id !== id && candidate.dependencies.includes(id),
    );
    if (
      task.status !== "pending"
      || task.owner !== undefined
      || task.evidence.length > 0
      || hasDependents
    ) {
      throw requestError(
        "delete_not_allowed",
        `task "${id}" can be deleted only before acquisition, evidence, or dependents`,
      );
    }
    graph.tasks = graph.tasks.filter((candidate) => candidate.id !== id);
    return { operation: "delete", task };
  };
}

function addEvidenceMutation(
  actor: TeamTaskActor,
  id: string,
  input: AddTeamTaskEvidenceInput,
  now: () => Date,
): (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision"> {
  return (graph) => {
    validateActor(actor);
    const task = findTask(graph, id);
    if (task.status !== "in_progress") {
      throw requestError(
        "evidence_not_allowed",
        `task "${id}" accepts evidence only while in_progress`,
      );
    }
    assertEvidenceActor(actor, task);
    const normalized = normalizeEvidenceInput(input);
    const timestamp = now().toISOString();
    const evidence: TeamTaskEvidence = {
      callId: normalized.callId,
      ...(normalized.references ? { references: normalized.references } : {}),
      reportedAt: timestamp,
      reportedByRole: actor.role,
      reportedBySessionId: actor.sessionId.trim(),
      round: normalized.round,
      summary: normalized.summary,
    };
    task.evidence.push(evidence);
    task.updatedAt = timestamp;
    return { operation: "add_evidence", task };
  };
}

function transitionMutation(
  actor: TeamTaskActor,
  input: TeamTaskTransitionInput,
  now: () => Date,
): (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision"> {
  return (graph) => {
    validateActor(actor);
    if (!isRecord(input) || typeof input.action !== "string" || typeof input.id !== "string") {
      throw requestError("invalid_input", "task transition requires action and id");
    }
    const task = findTask(graph, input.id.trim());
    const previousStatus = task.status;

    switch (input.action) {
      case "assign":
        requireLeader(actor);
        acquireTask(graph, task, normalizeAssignee(input.assignee), now, "assign");
        break;
      case "claim":
        if (actor.role !== "teammate") {
          throw requestError("permission_denied", "only a teammate can claim a task");
        }
        acquireTask(
          graph,
          task,
          { name: actor.name, profile: actor.profile, role: "teammate" },
          now,
          "claim",
        );
        break;
      case "submit_plan":
        submitPlan(actor, task, input, graph, now);
        break;
      case "review_plan":
        reviewPlan(actor, task, input, graph, now);
        break;
      case "submit_result":
        submitResult(actor, task, input, graph, now);
        break;
      case "review_result":
        reviewResearchResult(actor, task, input, graph, now);
        break;
      case "submit_handoff":
        submitHandoff(actor, task, input, graph, now);
        break;
      case "transfer":
        transferTask(actor, task, normalizeAssignee(input.assignee), graph, now);
        break;
      case "block":
        blockTask(actor, task, input.code, input.reason, graph, now);
        break;
      default:
        throw requestError("invalid_input", "unknown task transition action");
    }

    validateCandidateGraph(graph);
    return {
      ...(task.status !== previousStatus
        ? { nextStatus: task.status, previousStatus }
        : {}),
      operation: "transition",
      task,
    };
  };
}

function acquireTask(
  graph: TeamTaskGraphFile,
  task: TeamTask,
  assignee: TeamTaskAssignee,
  now: () => Date,
  detail: string,
): void {
  if (!isTeamTaskReady(graph, task)) {
    throw requestError("task_not_ready", `task "${task.id}" is not ready for acquisition`);
  }
  if (assignee.role === "teammate") {
    if (assignee.profile !== task.kind) {
      throw requestError(
        "invalid_input",
        `${assignee.profile} teammate "${assignee.name}" cannot own ${task.kind} task "${task.id}"`,
      );
    }
    assertTeammateCapacity(graph, assignee.name, task.id);
  }
  task.owner = ownerFromAssignee(assignee);
  task.status = "in_progress";
  task.updatedAt = now().toISOString();
  pushTrace(graph, task, now, "acquired", detail, "pending", "in_progress");
}

function submitPlan(
  actor: TeamTaskActor,
  task: TeamTask,
  input: Extract<TeamTaskTransitionInput, { action: "submit_plan" }>,
  graph: TeamTaskGraphFile,
  now: () => Date,
): void {
  requireOwnedTeammate(actor, task);
  if (task.kind !== "edit" || task.status !== "in_progress") {
    throw requestError("invalid_transition", "plans apply only to in-progress edit tasks");
  }
  const summary = normalizeRequiredString(input.summary, "plan summary");
  const steps = normalizeStringArray(input.steps, "plan steps", true);
  const timestamp = now().toISOString();
  const previousPlan = task.plan ? structuredClone(task.plan) : undefined;
  task.plan = {
    status: "pending",
    steps,
    submittedAt: timestamp,
    submittedBy: {
      name: actor.name,
      role: "teammate",
      sessionId: actor.sessionId.trim(),
    },
    summary,
  };
  task.updatedAt = timestamp;
  pushTrace(graph, task, now, "plan_submitted", undefined, undefined, undefined, {
    ...(previousPlan ? { plan: previousPlan } : {}),
  });
}

function reviewPlan(
  actor: TeamTaskActor,
  task: TeamTask,
  input: Extract<TeamTaskTransitionInput, { action: "review_plan" }>,
  graph: TeamTaskGraphFile,
  now: () => Date,
): void {
  requireLeader(actor);
  if (
    task.kind !== "edit"
    || task.status !== "in_progress"
    || task.owner?.role !== "teammate"
    || task.plan?.status !== "pending"
  ) {
    throw requestError("stale_approval", `task "${task.id}" has no current plan awaiting review`);
  }
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw requestError("invalid_input", "plan decision must be approve or reject");
  }
  const timestamp = now().toISOString();
  const previousPlan = structuredClone(task.plan);
  task.plan = {
    ...task.plan,
    approvedAt: timestamp,
    approvedBy: "leader",
    decisionReason: normalizeRequiredString(input.reason, "plan review reason"),
    status: input.decision === "approve" ? "approved" : "rejected",
  };
  task.updatedAt = timestamp;
  pushTrace(graph, task, now, "plan_reviewed", input.decision, undefined, undefined, {
    plan: previousPlan,
  });
}

function submitResult(
  actor: TeamTaskActor,
  task: TeamTask,
  input: Extract<TeamTaskTransitionInput, { action: "submit_result" }>,
  graph: TeamTaskGraphFile,
  now: () => Date,
): void {
  requireCurrentOwner(actor, task);
  if (task.status !== "in_progress") {
    throw requestError("invalid_transition", `task "${task.id}" is not accepting a result`);
  }
  if (task.evidence.length === 0) {
    throw requestError("evidence_required", `task "${task.id}" requires evidence before submission`);
  }
  const summary = normalizeRequiredString(input.summary, "result summary");
  const timestamp = now().toISOString();
  const previousSubmission = task.submission ? structuredClone(task.submission) : undefined;
  const previousVerdict = task.verdict ? structuredClone(task.verdict) : undefined;
  if (task.kind === "edit") {
    if (task.owner?.role === "teammate" && task.plan?.status !== "approved") {
      throw requestError("plan_not_approved", `edit task "${task.id}" requires an approved plan`);
    }
    const source = normalizeEditSource(input.source);
    validateSubmissionSource(actor, task, source);
    const fingerprint = normalizeRequiredString(input.fingerprint, "edit result fingerprint");
    const changedFiles = normalizeStringArray(input.changedFiles, "edit result changedFiles", true);
    task.submission = {
      changedFiles: [...changedFiles].sort(),
      fingerprint,
      source,
      submittedAt: timestamp,
      submittedBy: actorIdentity(actor),
      summary,
    };
  } else {
    if (input.source !== undefined || input.fingerprint !== undefined || input.changedFiles !== undefined) {
      throw requestError("invalid_input", "research result cannot include an edit source");
    }
    task.submission = {
      submittedAt: timestamp,
      submittedBy: actorIdentity(actor),
      summary,
    };
  }
  delete task.verdict;
  task.status = "submitted";
  task.updatedAt = timestamp;
  pushTrace(graph, task, now, "result_submitted", undefined, "in_progress", "submitted", {
    ...(previousSubmission ? { submission: previousSubmission } : {}),
    ...(previousVerdict ? { verdict: previousVerdict } : {}),
  });
}

function reviewResearchResult(
  actor: TeamTaskActor,
  task: TeamTask,
  input: Extract<TeamTaskTransitionInput, { action: "review_result" }>,
  graph: TeamTaskGraphFile,
  now: () => Date,
): void {
  requireLeader(actor);
  if (task.kind !== "research" || task.status !== "submitted" || !task.submission) {
    throw requestError("invalid_transition", "only a submitted research result can be reviewed");
  }
  if (input.decision !== "pass" && input.decision !== "reject") {
    throw requestError("invalid_input", "result decision must be pass or reject");
  }
  const timestamp = now().toISOString();
  const reason = normalizeRequiredString(input.reason, "result review reason");
  const reviewedSubmission = structuredClone(task.submission);
  const previousVerdict = task.verdict ? structuredClone(task.verdict) : undefined;
  if (input.decision === "pass") {
    task.verdict = {
      decidedAt: timestamp,
      decidedBy: "leader",
      status: "passed",
      summary: reason,
    };
    task.status = "completed";
  } else {
    delete task.submission;
    delete task.verdict;
    task.status = "in_progress";
  }
  task.updatedAt = timestamp;
  pushTrace(graph, task, now, "result_reviewed", input.decision, "submitted", task.status, {
    submission: reviewedSubmission,
    ...(previousVerdict ? { verdict: previousVerdict } : {}),
  });
}

function submitHandoff(
  actor: TeamTaskActor,
  task: TeamTask,
  input: Extract<TeamTaskTransitionInput, { action: "submit_handoff" }>,
  graph: TeamTaskGraphFile,
  now: () => Date,
): void {
  requireCurrentOwner(actor, task);
  if (task.status !== "in_progress" && task.status !== "submitted") {
    throw requestError("invalid_transition", `task "${task.id}" cannot accept a handoff`);
  }
  const timestamp = now().toISOString();
  const previousHandoff = task.handoff ? structuredClone(task.handoff) : undefined;
  task.handoff = {
    from: structuredClone(task.owner as TeamTaskOwner),
    ...(input.references === undefined
      ? {}
      : { references: normalizeReferences(input.references) }),
    submittedAt: timestamp,
    summary: normalizeRequiredString(input.summary, "handoff summary"),
  };
  task.updatedAt = timestamp;
  pushTrace(graph, task, now, "handoff_submitted", undefined, undefined, undefined, {
    ...(previousHandoff ? { handoff: previousHandoff } : {}),
  });
}

function transferTask(
  actor: TeamTaskActor,
  task: TeamTask,
  assignee: TeamTaskAssignee,
  graph: TeamTaskGraphFile,
  now: () => Date,
): void {
  requireLeader(actor);
  if (task.transferCount >= 1) {
    throw requestError("transfer_exhausted", `task "${task.id}" already used its one transfer`);
  }
  if (task.owner?.role !== "teammate" || !task.handoff || !sameOwner(task.owner, task.handoff.from)) {
    throw requestError("handoff_required", `task "${task.id}" requires its current owner's handoff`);
  }
  if (assignee.role !== "teammate") {
    throw requestError("invalid_input", "a transferred task must move to a teammate");
  }
  if (assignee.name === task.owner.name) {
    throw requestError("invalid_input", "task transfer requires a different teammate");
  }
  if (assignee.profile !== task.kind) {
    throw requestError("invalid_input", "task and target teammate profiles must match");
  }
  assertTeammateCapacity(graph, assignee.name, task.id);
  const previousStatus = task.status;
  const transferSnapshot = protocolSnapshot(task);
  task.owner = ownerFromAssignee(assignee);
  task.status = "in_progress";
  task.transferCount += 1;
  delete task.plan;
  delete task.submission;
  delete task.verdict;
  task.updatedAt = now().toISOString();
  pushTrace(
    graph,
    task,
    now,
    "transferred",
    assignee.name,
    previousStatus,
    "in_progress",
    transferSnapshot,
  );
}

function blockTask(
  actor: TeamTaskActor,
  task: TeamTask,
  codeValue: unknown,
  reasonValue: unknown,
  graph: TeamTaskGraphFile,
  now: () => Date,
): void {
  requireLeader(actor);
  if (task.status === "completed" || task.status === "blocked") {
    throw requestError("task_frozen", `terminal task "${task.id}" is frozen`);
  }
  const previousStatus = task.status;
  const blockedSnapshot = protocolSnapshot(task);
  const timestamp = now().toISOString();
  task.blocker = {
    code: normalizeRequiredString(codeValue, "blocker code"),
    reason: normalizeRequiredString(reasonValue, "blocker reason"),
    reportedAt: timestamp,
    reportedBy: actorIdentity(actor),
  };
  task.status = "blocked";
  task.updatedAt = timestamp;
  pushTrace(
    graph,
    task,
    now,
    "blocked",
    task.blocker.code,
    previousStatus,
    "blocked",
    blockedSnapshot,
  );
}

function recordVerificationMutation(
  actor: TeamTaskActor,
  id: string,
  input: RecordTeamTaskVerificationInput,
  now: () => Date,
): (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision"> {
  return (graph) => {
    requireLeader(actor);
    const task = findTask(graph, id);
    if (task.kind !== "edit" || task.status !== "submitted" || !task.submission?.fingerprint) {
      throw requestError("invalid_transition", `task "${id}" has no submitted edit to verify`);
    }
    const command = normalizeRequiredString(input.command, "verification command");
    if (command !== task.verificationCommand) {
      throw requestError("stale_approval", "approved verification command does not match the task contract");
    }
    const fingerprint = normalizeRequiredString(input.fingerprint, "verification fingerprint");
    if (fingerprint !== task.submission.fingerprint) {
      throw requestError("source_drift", `task "${id}" source changed after submission`);
    }
    if (!Number.isSafeInteger(input.exitCode) || input.exitCode < 0) {
      throw requestError("invalid_input", "verification exitCode must be a non-negative integer");
    }
    const previousStatus = task.status;
    const verificationSnapshot = protocolSnapshot(task);
    const timestamp = now().toISOString();
    if (input.exitCode === 0) {
      task.verdict = {
        command,
        decidedAt: timestamp,
        decidedBy: "leader",
        fingerprint,
        status: "passed",
        summary: normalizeRequiredString(input.summary, "verification summary"),
      };
    } else {
      delete task.submission;
      delete task.verdict;
      task.status = "in_progress";
    }
    task.updatedAt = timestamp;
    pushTrace(
      graph,
      task,
      now,
      "verification_recorded",
      input.exitCode === 0 ? "passed" : `failed:${input.exitCode}`,
      previousStatus,
      task.status,
      verificationSnapshot,
    );
    validateCandidateGraph(graph);
    return {
      ...(task.status !== previousStatus
        ? { nextStatus: task.status, previousStatus }
        : {}),
      operation: "verify",
      task,
    };
  };
}

function recordIntegrationMutation(
  actor: TeamTaskActor,
  id: string,
  receipt: TeamTaskIntegrationReceipt,
  now: () => Date,
): (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision"> {
  return (graph) => {
    requireLeader(actor);
    const task = findTask(graph, id);
    if (
      task.kind !== "edit"
      || task.status !== "submitted"
      || !task.submission?.source
      || !task.submission.fingerprint
      || task.verdict?.status !== "passed"
    ) {
      throw requestError("invalid_transition", `task "${id}" is not ready for integration`);
    }
    const normalized = normalizeReceipt(receipt);
    if (
      normalized.fingerprint !== task.submission.fingerprint
      || normalized.fingerprint !== task.verdict.fingerprint
    ) {
      throw requestError("fingerprint_mismatch", `task "${id}" integration receipt is stale`);
    }
    if (JSON.stringify(normalized.source) !== JSON.stringify(task.submission.source)) {
      throw requestError("source_drift", `task "${id}" integration source does not match submission`);
    }
    const previousStatus = task.status;
    const integrationSnapshot = protocolSnapshot(task);
    task.integrationReceipt = normalized;
    task.status = "completed";
    task.updatedAt = now().toISOString();
    pushTrace(
      graph,
      task,
      now,
      "integrated",
      normalized.integratedCommit,
      previousStatus,
      "completed",
      integrationSnapshot,
    );
    validateCandidateGraph(graph);
    return {
      nextStatus: "completed",
      operation: "integrate",
      previousStatus,
      task,
    };
  };
}

function normalizeCreateInput(input: CreateTeamTaskInput): {
  acceptance: string[];
  dependencies: string[];
  description: string;
  kind: "research" | "edit";
  title: string;
  verificationCommand?: string;
} {
  if (!isRecord(input)) {
    throw requestError("invalid_input", "task create input must be an object");
  }
  const allowed = new Set([
    "acceptance",
    "dependencies",
    "description",
    "kind",
    "title",
    "verificationCommand",
  ]);
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw requestError("invalid_input", "task create input contains unsupported fields");
  }
  const kind = input.kind;
  if (kind !== "research" && kind !== "edit") {
    throw requestError("invalid_input", "task kind must be research or edit");
  }
  const verificationCommand = input.verificationCommand === undefined
    ? undefined
    : normalizeRequiredString(input.verificationCommand, "verificationCommand");
  if (kind === "edit" && !verificationCommand) {
    throw requestError("invalid_input", "edit task requires verificationCommand");
  }
  if (kind === "research" && verificationCommand !== undefined) {
    throw requestError("invalid_input", "research task cannot declare verificationCommand");
  }
  return {
    acceptance: normalizeStringArray(input.acceptance, "task acceptance", true),
    dependencies: normalizeStringArray(input.dependencies ?? [], "task dependencies", false),
    description: normalizeRequiredString(input.description, "task description"),
    kind,
    title: normalizeRequiredString(input.title, "task title"),
    ...(verificationCommand ? { verificationCommand } : {}),
  };
}

function normalizeUpdatePatch(
  patch: UpdateTeamTaskPatch,
  current: TeamTask,
): UpdateTeamTaskPatch {
  if (!isRecord(patch)) {
    throw requestError("invalid_input", "task update patch must be an object");
  }
  const fields = Object.keys(patch);
  const allowed = new Set([
    "acceptance",
    "dependencies",
    "description",
    "kind",
    "title",
    "verificationCommand",
  ]);
  if (fields.length === 0 || fields.some((field) => !allowed.has(field))) {
    throw requestError(
      "invalid_input",
      "task_update accepts only pending contract fields; protocol state uses task_transition",
    );
  }
  const kind = patch.kind ?? current.kind;
  if (kind !== "research" && kind !== "edit") {
    throw requestError("invalid_input", "task kind must be research or edit");
  }
  const verificationCommand = Object.prototype.hasOwnProperty.call(patch, "verificationCommand")
    ? (patch.verificationCommand === undefined
      ? undefined
      : normalizeRequiredString(patch.verificationCommand, "verificationCommand"))
    : current.verificationCommand;
  if (kind === "edit" && !verificationCommand) {
    throw requestError("invalid_input", "edit task requires verificationCommand");
  }
  if (kind === "research" && verificationCommand !== undefined) {
    throw requestError("invalid_input", "research task cannot declare verificationCommand");
  }
  return {
    ...(patch.acceptance === undefined
      ? {}
      : { acceptance: normalizeStringArray(patch.acceptance, "task acceptance", true) }),
    ...(patch.dependencies === undefined
      ? {}
      : { dependencies: normalizeStringArray(patch.dependencies, "task dependencies", false) }),
    ...(patch.description === undefined
      ? {}
      : { description: normalizeRequiredString(patch.description, "task description") }),
    ...(patch.kind === undefined ? {} : { kind }),
    ...(patch.title === undefined
      ? {}
      : { title: normalizeRequiredString(patch.title, "task title") }),
    ...(Object.prototype.hasOwnProperty.call(patch, "verificationCommand")
      ? { verificationCommand }
      : {}),
  };
}

function normalizeEvidenceInput(input: AddTeamTaskEvidenceInput): AddTeamTaskEvidenceInput {
  if (!isRecord(input)) {
    throw requestError("invalid_input", "task evidence input must be an object");
  }
  const allowed = new Set(["callId", "references", "round", "summary"]);
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw requestError("invalid_input", "task evidence input contains unsupported fields");
  }
  if (!Number.isSafeInteger(input.round) || input.round < 1) {
    throw requestError("invalid_input", "task evidence round must be a positive integer");
  }
  return {
    callId: normalizeRequiredString(input.callId, "task evidence callId"),
    ...(input.references === undefined ? {} : { references: normalizeReferences(input.references) }),
    round: input.round,
    summary: normalizeRequiredString(input.summary, "task evidence summary"),
  };
}

function normalizeReferences(value: unknown): TeamTaskEvidenceReference[] {
  if (!Array.isArray(value)) {
    throw requestError("invalid_input", "task evidence references must be an array");
  }
  return value.map((reference, index) => {
    if (!isRecord(reference) || !hasExactKeys(reference, ["kind", "value"])) {
      throw requestError("invalid_input", `task evidence reference ${index + 1} is invalid`);
    }
    if (
      reference.kind !== "artifact"
      && reference.kind !== "trace"
      && reference.kind !== "external"
    ) {
      throw requestError("invalid_input", `task evidence reference ${index + 1} kind is invalid`);
    }
    return {
      kind: reference.kind,
      value: normalizeRequiredString(reference.value, `task evidence reference ${index + 1} value`),
    };
  });
}

function normalizeAssignee(value: unknown): TeamTaskAssignee {
  if (!isRecord(value)) {
    throw requestError("invalid_input", "task assignee is invalid");
  }
  if (value.role === "leader" && hasExactKeys(value, ["role"])) {
    return { role: "leader" };
  }
  if (
    value.role === "teammate"
    && hasExactKeys(value, ["name", "profile", "role"])
    && (value.profile === "research" || value.profile === "edit")
  ) {
    return {
      name: normalizeRequiredString(value.name, "teammate assignee name"),
      profile: value.profile,
      role: "teammate",
    };
  }
  throw requestError("invalid_input", "task assignee is invalid");
}

function normalizeEditSource(value: unknown): TeamTaskResultSource {
  if (!isRecord(value) || !isRecord(value.workspace) || !hasExactKeys(value.workspace, ["branch", "path"])) {
    throw requestError("invalid_input", "edit result source is invalid");
  }
  const workspace = {
    branch: normalizeRequiredString(value.workspace.branch, "edit source branch"),
    path: normalizeRequiredString(value.workspace.path, "edit source path"),
  };
  if (
    value.kind === "child"
    && hasExactKeys(value, ["childSessionId", "kind", "profile", "workspace"])
    && (value.profile === "research" || value.profile === "edit")
  ) {
    return {
      childSessionId: normalizeRequiredString(value.childSessionId, "child source sessionId"),
      kind: "child",
      profile: value.profile,
      workspace,
    };
  }
  if (
    value.kind === "teammate"
    && hasExactKeys(value, ["kind", "name", "profile", "sessionId", "workspace"])
    && (value.profile === "research" || value.profile === "edit")
  ) {
    return {
      kind: "teammate",
      name: normalizeRequiredString(value.name, "teammate source name"),
      profile: value.profile,
      sessionId: normalizeRequiredString(value.sessionId, "teammate source sessionId"),
      workspace,
    };
  }
  throw requestError("invalid_input", "edit result source is invalid");
}

function normalizeReceipt(value: TeamTaskIntegrationReceipt): TeamTaskIntegrationReceipt {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["fingerprint", "integratedAt", "integratedCommit", "source", "sourceCommit", "targetBefore"],
  )) {
    throw requestError("invalid_input", "integration receipt is invalid");
  }
  return {
    fingerprint: normalizeRequiredString(value.fingerprint, "receipt fingerprint"),
    integratedAt: normalizeIsoTimestamp(value.integratedAt, "receipt integratedAt"),
    integratedCommit: normalizeRequiredString(value.integratedCommit, "receipt integratedCommit"),
    source: normalizeEditSource(value.source),
    sourceCommit: normalizeRequiredString(value.sourceCommit, "receipt sourceCommit"),
    targetBefore: normalizeRequiredString(value.targetBefore, "receipt targetBefore"),
  };
}

function validateSubmissionSource(
  actor: TeamTaskActor,
  task: TeamTask,
  source: TeamTaskResultSource,
): void {
  if (source.profile !== "edit") {
    throw requestError("invalid_input", "edit result source must use the edit profile");
  }
  if (actor.role === "teammate") {
    if (
      source.kind !== "teammate"
      || source.name !== actor.name
      || source.sessionId !== actor.sessionId
    ) {
      throw requestError("owner_mismatch", "teammate edit source must match the current owner session");
    }
    return;
  }
  if (actor.role === "leader" && task.owner?.role === "leader" && source.kind === "child") {
    return;
  }
  throw requestError("child_source_invalid", "Leader-owned edit results require a registered edit child source");
}

function assertEvidenceActor(actor: TeamTaskActor, task: TeamTask): void {
  if (actor.role === "child") {
    if (actor.delegatedTaskId !== task.id || task.owner?.role !== "leader") {
      throw requestError(
        "delegated_task_mismatch",
        `child session may append evidence only to its delegated Leader-owned task`,
      );
    }
    return;
  }
  if (actor.role === "teammate") {
    requireOwnedTeammate(actor, task);
  }
}

function requireCurrentOwner(actor: TeamTaskActor, task: TeamTask): void {
  if (actor.role === "leader" && task.owner?.role === "leader") {
    return;
  }
  if (
    actor.role === "teammate"
    && task.owner?.role === "teammate"
    && task.owner.name === actor.name
  ) {
    return;
  }
  throw requestError("owner_mismatch", `actor does not own task "${task.id}"`);
}

function requireOwnedTeammate(
  actor: TeamTaskActor,
  task: TeamTask,
): asserts actor is Extract<TeamTaskActor, { role: "teammate" }> {
  if (
    actor.role !== "teammate"
    || task.owner?.role !== "teammate"
    || task.owner.name !== actor.name
  ) {
    throw requestError("owner_mismatch", `teammate does not own task "${task.id}"`);
  }
}

function assertTeammateCapacity(
  graph: TeamTaskGraphFile,
  teammateName: string,
  exceptTaskId: string,
): void {
  const active = graph.tasks.find(
    (candidate) =>
      candidate.id !== exceptTaskId
      && candidate.owner?.role === "teammate"
      && candidate.owner.name === teammateName
      && candidate.status !== "completed"
      && candidate.status !== "blocked",
  );
  if (active) {
    throw requestError(
      "capacity_exceeded",
      `teammate "${teammateName}" already owns active task "${active.id}"`,
    );
  }
}

function ownerFromAssignee(assignee: TeamTaskAssignee): TeamTaskOwner {
  return assignee.role === "leader"
    ? { role: "leader" }
    : { name: assignee.name, role: "teammate" };
}

function actorIdentity(actor: TeamTaskActor): TeamTaskActorIdentity {
  if (actor.role === "teammate") {
    return { name: actor.name.trim(), role: "teammate", sessionId: actor.sessionId.trim() };
  }
  return { role: actor.role, sessionId: actor.sessionId.trim() };
}

function sameOwner(left: TeamTaskOwner, right: TeamTaskOwner): boolean {
  return left.role === right.role
    && (left.role === "leader" || (right.role === "teammate" && left.name === right.name));
}

function validateDependencies(graph: TeamTaskGraphFile, taskId: string, dependencies: string[]): void {
  if (new Set(dependencies).size !== dependencies.length) {
    throw requestError("invalid_input", "task dependencies must not contain duplicates");
  }
  const known = new Set(graph.tasks.map((task) => task.id));
  for (const dependency of dependencies) {
    if (dependency === taskId) {
      throw requestError("invalid_input", `task "${taskId}" cannot depend on itself`);
    }
    if (!known.has(dependency)) {
      throw requestError("invalid_input", `task dependency "${dependency}" was not found`);
    }
  }
}

function validateCandidateGraph(graph: TeamTaskGraphFile): void {
  try {
    parseTeamTaskGraphFile(graph);
  } catch (error) {
    if (error instanceof TeamTaskStoreError && error.code === "graph_invalid") {
      throw requestError("invalid_input", error.message);
    }
    throw error;
  }
}

function pushTrace(
  graph: TeamTaskGraphFile,
  task: TeamTask,
  now: () => Date,
  type: TeamTask["trace"][number]["type"],
  detail?: string,
  from?: TeamTask["status"],
  to?: TeamTask["status"],
  snapshot?: Record<string, unknown>,
): void {
  task.trace.push({
    at: now().toISOString(),
    ...(detail ? { detail } : {}),
    ...(from ? { from } : {}),
    ...(task.owner ? { owner: structuredClone(task.owner) } : {}),
    revision: graph.revision + 1,
    ...(snapshot && Object.keys(snapshot).length > 0
      ? { snapshot: structuredClone(snapshot) }
      : {}),
    ...(to ? { to } : {}),
    type,
  });
}

function contractSnapshot(task: TeamTask): Record<string, unknown> {
  return {
    acceptance: [...task.acceptance],
    dependencies: [...task.dependencies],
    description: task.description,
    kind: task.kind,
    title: task.title,
    ...(task.verificationCommand ? { verificationCommand: task.verificationCommand } : {}),
  };
}

function protocolSnapshot(task: TeamTask): Record<string, unknown> {
  return {
    ...(task.handoff ? { handoff: structuredClone(task.handoff) } : {}),
    ...(task.owner ? { owner: structuredClone(task.owner) } : {}),
    ...(task.plan ? { plan: structuredClone(task.plan) } : {}),
    status: task.status,
    ...(task.submission ? { submission: structuredClone(task.submission) } : {}),
    ...(task.verdict ? { verdict: structuredClone(task.verdict) } : {}),
  };
}

function findTask(graph: TeamTaskGraphFile, id: string): TeamTask {
  const task = graph.tasks.find((candidate) => candidate.id === id);
  if (!task) {
    throw requestError("task_not_found", `task "${id}" was not found`);
  }
  return task;
}

function requireLeader(
  actor: TeamTaskActor,
): asserts actor is Extract<TeamTaskActor, { role: "leader" }> {
  validateActor(actor);
  if (actor.role !== "leader") {
    throw requestError("permission_denied", "only the Leader may perform this task action");
  }
}

function validateActor(actor: TeamTaskActor): void {
  if (!isRecord(actor) || !normalizeOptionalString(actor.sessionId)) {
    throw requestError("invalid_actor", "task actor requires a non-empty sessionId");
  }
  if (actor.role === "leader") {
    return;
  }
  if (
    actor.role === "teammate"
    && normalizeOptionalString(actor.name)
    && (actor.profile === "research" || actor.profile === "edit")
  ) {
    return;
  }
  if (
    actor.role === "child"
    && (actor.profile === undefined || actor.profile === "research" || actor.profile === "edit")
  ) {
    return;
  }
  throw requestError("invalid_actor", "task actor is invalid");
}

function normalizeStringArray(value: unknown, label: string, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    throw requestError("invalid_input", `${label} must be ${requireNonEmpty ? "a non-empty" : "an"} array`);
  }
  return value.map((entry, index) => normalizeRequiredString(entry, `${label} ${index + 1}`));
}

function normalizeRequiredString(value: unknown, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw requestError("invalid_input", `${label} must be a non-empty string`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw requestError("invalid_input", `${label} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw requestError("invalid_input", `${label} must be an ISO timestamp`);
  }
  return value;
}

async function acquireLock(lockPath: string): Promise<fs.FileHandle> {
  const startedAt = performance.now();
  while (true) {
    try {
      return await fs.open(lockPath, "wx");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw new TeamTaskStoreError(
          "store_io",
          `failed to acquire task graph lock: ${errorMessage(error)}`,
          "degraded",
        );
      }
      if (performance.now() - startedAt >= TEAM_TASK_LOCK_TIMEOUT_MS) {
        throw new TeamTaskStoreError(
          "task_store_busy",
          `task graph lock is busy at ${lockPath}`,
          "degraded",
        );
      }
      await delay(TEAM_TASK_LOCK_RETRY_MS);
    }
  }
}

async function releaseLock(handle: fs.FileHandle, lockPath: string): Promise<void> {
  let closeFailure: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeFailure = error;
  }
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    throw new TeamTaskStoreError(
      "store_io",
      `failed to release task graph lock: ${errorMessage(error)}`,
      "degraded",
    );
  }
  if (closeFailure) {
    throw new TeamTaskStoreError(
      "store_io",
      `failed to close task graph lock: ${errorMessage(closeFailure)}`,
      "degraded",
    );
  }
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw storeIoError("inspect task graph path", error);
  }
}

async function ensureInitializationMarker(pathname: string): Promise<void> {
  try {
    await fs.writeFile(pathname, "initialized\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw storeIoError("write task graph initialization marker", error);
    }
  }
}

function cleanupErrorWithCommittedMutation(
  error: unknown,
  committedMutation: TeamTaskMutationResult,
): TeamTaskStoreError {
  if (error instanceof TeamTaskStoreError) {
    return new TeamTaskStoreError(error.code, error.message, error.health, committedMutation);
  }
  return new TeamTaskStoreError(
    "store_io",
    `failed to release task graph lock: ${errorMessage(error)}`,
    "degraded",
    committedMutation,
  );
}

function requestError(
  code: ConstructorParameters<typeof TeamTaskStoreError>[0],
  message: string,
): TeamTaskStoreError {
  return new TeamTaskStoreError(code, message, "healthy");
}

function storeIoError(operation: string, error: unknown): TeamTaskStoreError {
  return new TeamTaskStoreError(
    "store_io",
    `failed to ${operation}: ${errorMessage(error)}`,
    "degraded",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
