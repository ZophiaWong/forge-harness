import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import {
  TEAM_TASK_GRAPH_SCHEMA_VERSION,
  TeamTaskStoreError,
  cloneTeamTask,
  cloneTeamTaskGraph,
  isTeamTaskReady,
  parseTeamTaskGraphFile,
  summarizeTeamTask,
  type AddTeamTaskEvidenceInput,
  type CreateTeamTaskInput,
  type TeamTask,
  type TeamTaskActor,
  type TeamTaskEvidence,
  type TeamTaskEvidenceReference,
  type TeamTaskGetResult,
  type TeamTaskGraphFile,
  type TeamTaskListResult,
  type TeamTaskMutationResult,
  type TeamTaskStatus,
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

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new TeamTaskStoreError(
        "graph_malformed",
        `task graph contains malformed JSON: ${errorMessage(error)}`,
        "degraded",
      );
    }

    return parseTeamTaskGraphFile(value);
  };

  const withWriteLock = async <T>(
    action: () => Promise<T>,
    committedMutationFromResult?: (result: T) => TeamTaskMutationResult,
  ): Promise<T> => {
    const lock = await acquireLock(lockPath);
    let actionCompleted = false;
    let result: T | undefined;
    try {
      result = await action();
      actionCompleted = true;
      return result;
    } finally {
      try {
        await releaseLock(lock, lockPath);
      } catch (error) {
        if (actionCompleted && committedMutationFromResult) {
          throw cleanupErrorWithCommittedMutation(
            error,
            committedMutationFromResult(result as T),
          );
        }
        throw error;
      }
    }
  };

  const write = async (graph: TeamTaskGraphFile): Promise<void> => {
    const directory = path.dirname(options.graphPath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(options.graphPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let temporaryHandle: fs.FileHandle | undefined;
    let renamed = false;

    try {
      temporaryHandle = await fs.open(temporaryPath, "wx");
      await temporaryHandle.writeFile(`${JSON.stringify(graph, null, 2)}\n`, "utf8");
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await fs.rename(temporaryPath, options.graphPath);
      renamed = true;
    } catch (error) {
      throw storeIoError("write task graph", error);
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      if (!renamed) {
        await fs.unlink(temporaryPath).catch(() => undefined);
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
      const validatedGraph = parseTeamTaskGraphFile(graph);
      await write(validatedGraph);
      return {
        ...result,
        revision: validatedGraph.revision,
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
      return mutate(asyncCreateMutation(actor, input, now));
    },
    async delete(actor, id) {
      return mutate(deleteMutation(actor, id));
    },
    async get(id) {
      const graph = await load();
      const task = findTask(graph, id);
      return {
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
        const initializationExists = await fileExists(initializationPath);
        if (graphExists) {
          if (!initializationExists) {
            await ensureInitializationMarker(initializationPath);
          }
          return cloneTeamTaskGraph(await load());
        }
        if (initializationExists) {
          throw new TeamTaskStoreError(
            "graph_missing",
            `task graph is missing at ${options.graphPath}`,
            "degraded",
          );
        }

        const initialGraph: TeamTaskGraphFile = {
          nextTaskSequence: 1,
          revision: 0,
          schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
          tasks: [],
        };
        await write(initialGraph);
        await ensureInitializationMarker(initializationPath);
        return cloneTeamTaskGraph(initialGraph);
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
    async update(actor, id, patch) {
      return mutate(updateMutation(actor, id, patch, now));
    },
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
    if (task.status !== "pending" || task.evidence.length > 0 || hasDependents) {
      throw requestError(
        "delete_not_allowed",
        `task "${id}" can be deleted only while pending, without evidence or dependents`,
      );
    }

    graph.tasks = graph.tasks.filter((candidate) => candidate.id !== id);
    return {
      operation: "delete",
      task,
    };
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
    if (actor.role === "child" && actor.delegatedTaskId !== id) {
      throw requestError(
        "delegated_task_mismatch",
        `child session may append evidence only to its delegated task "${String(actor.delegatedTaskId)}"`,
      );
    }

    const task = findTask(graph, id);
    if (task.status !== "in_progress") {
      throw requestError(
        "evidence_not_allowed",
        `evidence can be appended only while task "${id}" is in progress`,
      );
    }

    const normalized = validateEvidenceInput(input);
    const evidence: TeamTaskEvidence = {
      callId: normalized.callId,
      ...(normalized.references ? { references: normalized.references } : {}),
      reportedAt: now().toISOString(),
      reportedByRole: actor.role,
      reportedBySessionId: actor.sessionId.trim(),
      round: normalized.round,
      summary: normalized.summary,
    };
    task.evidence.push(evidence);
    task.updatedAt = evidence.reportedAt;
    return {
      operation: "add_evidence",
      task,
    };
  };
}

function validateEvidenceInput(input: AddTeamTaskEvidenceInput): AddTeamTaskEvidenceInput {
  if (!isRecord(input)) {
    throw requestError("invalid_input", "task evidence input must be an object");
  }
  const fields = Object.keys(input);
  const allowedFields = new Set(["callId", "references", "round", "summary"]);
  if (fields.some((field) => !allowedFields.has(field))) {
    throw requestError("invalid_input", "task evidence input contains unsupported fields");
  }

  const summary = normalizeRequiredInputString(input.summary, "task evidence summary");
  const callId = normalizeRequiredInputString(input.callId, "task evidence callId");
  if (!Number.isSafeInteger(input.round) || input.round < 1) {
    throw requestError("invalid_input", "task evidence round must be a positive safe integer");
  }

  const references = input.references === undefined
    ? undefined
    : validateEvidenceReferences(input.references);
  return {
    callId,
    ...(references ? { references } : {}),
    round: input.round,
    summary,
  };
}

function validateEvidenceReferences(value: unknown): TeamTaskEvidenceReference[] {
  if (!Array.isArray(value)) {
    throw requestError("invalid_input", "task evidence references must be an array");
  }

  return value.map((reference, index) => {
    if (
      !isRecord(reference)
      || Object.keys(reference).length !== 2
      || !("kind" in reference)
      || !("value" in reference)
    ) {
      throw requestError(
        "invalid_input",
        `task evidence reference ${index + 1} must contain kind and value`,
      );
    }
    if (
      reference.kind !== "artifact"
      && reference.kind !== "trace"
      && reference.kind !== "external"
    ) {
      throw requestError(
        "invalid_input",
        `task evidence reference ${index + 1} has an invalid kind`,
      );
    }
    return {
      kind: reference.kind,
      value: normalizeRequiredInputString(
        reference.value,
        `task evidence reference ${index + 1} value`,
      ),
    };
  });
}

function asyncCreateMutation(
  actor: TeamTaskActor,
  input: CreateTeamTaskInput,
  now: () => Date,
): (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision"> {
  return (graph) => {
    requireLeader(actor);
    const normalized = validateCreateInput(input);
    const timestamp = now().toISOString();
    const id = `task_${String(graph.nextTaskSequence).padStart(3, "0")}`;
    validateNewTaskDependencies(graph, id, normalized.dependencies);
    const task: TeamTask = {
      acceptance: normalized.acceptance,
      createdAt: timestamp,
      dependencies: normalized.dependencies,
      description: normalized.description,
      evidence: [],
      id,
      status: "pending",
      title: normalized.title,
      updatedAt: timestamp,
    };
    graph.nextTaskSequence += 1;
    graph.tasks.push(task);
    return {
      nextStatus: task.status,
      operation: "create",
      task,
    };
  };
}

function validateNewTaskDependencies(
  graph: TeamTaskGraphFile,
  taskId: string,
  dependencies: string[],
): void {
  if (new Set(dependencies).size !== dependencies.length) {
    throw requestError("invalid_input", "task dependencies must not contain duplicates");
  }

  const knownTaskIds = new Set(graph.tasks.map((task) => task.id));
  for (const dependencyId of dependencies) {
    if (dependencyId === taskId) {
      throw requestError("invalid_input", `task "${taskId}" cannot depend on itself`);
    }
    if (!knownTaskIds.has(dependencyId)) {
      throw requestError("invalid_input", `task dependency "${dependencyId}" was not found`);
    }
  }
}

function updateMutation(
  actor: TeamTaskActor,
  id: string,
  patch: UpdateTeamTaskPatch,
  now: () => Date,
): (graph: TeamTaskGraphFile) => Omit<TeamTaskMutationResult, "revision"> {
  return (graph) => {
    requireLeader(actor);
    const fields = validateUpdatePatch(patch);
    const task = findTask(graph, id);
    if (task.status === "completed") {
      throw requestError("task_frozen", `completed task "${id}" is frozen`);
    }

    const contractFields = fields.filter((field) =>
      field === "acceptance"
      || field === "dependencies"
      || field === "description"
      || field === "title");
    if (
      contractFields.length > 0
      && task.status !== "pending"
      && task.status !== "blocked"
    ) {
      throw requestError(
        "contract_frozen",
        `task "${id}" contract can change only while pending or blocked`,
      );
    }

    applyContractPatch(task, patch);
    validateCandidateGraph(graph);

    const previousStatus = task.status;
    let statusChanged = false;
    if (fields.includes("status")) {
      applyStatusTransition(graph, task, patch);
      statusChanged = true;
    } else if (fields.includes("blockedReason")) {
      if (task.status !== "blocked") {
        throw requestError(
          "blocked_reason_not_allowed",
          "blockedReason can be set only for a blocked task",
        );
      }
      task.blockedReason = normalizeBlockedReason(patch.blockedReason);
    }

    task.updatedAt = now().toISOString();
    return {
      ...(statusChanged ? { nextStatus: task.status, previousStatus } : {}),
      operation: "update",
      task,
    };
  };
}

function validateUpdatePatch(patch: UpdateTeamTaskPatch): string[] {
  if (!isRecord(patch)) {
    throw requestError("invalid_input", "task update patch must be an object");
  }

  const fields = Object.keys(patch);
  const allowedFields = new Set([
    "acceptance",
    "blockedReason",
    "dependencies",
    "description",
    "status",
    "title",
  ]);
  if (fields.length === 0 || fields.some((field) => !allowedFields.has(field))) {
    throw requestError("invalid_input", "task update patch must contain only supported fields");
  }
  return fields;
}

function applyContractPatch(task: TeamTask, patch: UpdateTeamTaskPatch): void {
  if (Object.prototype.hasOwnProperty.call(patch, "title")) {
    task.title = normalizeRequiredInputString(patch.title, "task title");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "description")) {
    task.description = normalizeRequiredInputString(patch.description, "task description");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "acceptance")) {
    if (!Array.isArray(patch.acceptance) || patch.acceptance.length === 0) {
      throw requestError("invalid_input", "task acceptance must contain at least one criterion");
    }
    task.acceptance = patch.acceptance.map((criterion, index) =>
      normalizeRequiredInputString(criterion, `task acceptance criterion ${index + 1}`));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "dependencies")) {
    if (!Array.isArray(patch.dependencies)) {
      throw requestError("invalid_input", "task dependencies must be an array");
    }
    task.dependencies = patch.dependencies.map((dependency, index) =>
      normalizeRequiredInputString(dependency, `task dependency ${index + 1}`));
  }
}

function applyStatusTransition(
  graph: TeamTaskGraphFile,
  task: TeamTask,
  patch: UpdateTeamTaskPatch,
): void {
  if (!isTeamTaskStatus(patch.status)) {
    throw requestError("invalid_input", "task status is invalid");
  }
  if (patch.status === task.status) {
    throw requestError(
      "invalid_transition",
      `task "${task.id}" is already ${task.status}`,
    );
  }

  if (patch.status === "blocked") {
    if (task.status !== "pending" && task.status !== "in_progress") {
      throw requestError(
        "invalid_transition",
        `task "${task.id}" cannot move from ${task.status} to blocked`,
      );
    }
    task.blockedReason = normalizeBlockedReason(patch.blockedReason);
    task.status = "blocked";
    return;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "blockedReason")) {
    throw requestError(
      "blocked_reason_not_allowed",
      "blockedReason is allowed only when the target status is blocked",
    );
  }

  if (task.status === "blocked" && patch.status === "pending") {
    delete task.blockedReason;
    task.status = "pending";
    return;
  }

  if (task.status === "in_progress" && patch.status === "pending") {
    task.status = "pending";
    return;
  }

  if (task.status === "pending" && patch.status === "in_progress") {
    if (!isTeamTaskReady(graph, task)) {
      throw requestError("task_not_ready", `task "${task.id}" is not ready`);
    }
    task.status = "in_progress";
    return;
  }

  if (task.status === "in_progress" && patch.status === "completed") {
    const tasksById = new Map(graph.tasks.map((candidate) => [candidate.id, candidate]));
    if (
      task.dependencies.some(
        (dependencyId) => tasksById.get(dependencyId)?.status !== "completed",
      )
    ) {
      throw requestError(
        "dependencies_incomplete",
        `task "${task.id}" cannot complete before all dependencies`,
      );
    }
    if (task.evidence.length === 0) {
      throw requestError(
        "evidence_required",
        `task "${task.id}" requires evidence before completion`,
      );
    }
    task.status = "completed";
    return;
  }

  throw requestError(
    "invalid_transition",
    `task "${task.id}" cannot move from ${task.status} to ${patch.status}`,
  );
}

function normalizeBlockedReason(value: unknown): string {
  const reason = readNonEmptyString(value);
  if (!reason) {
    throw requestError(
      "blocked_reason_required",
      "moving a task to blocked requires a non-empty blockedReason",
    );
  }
  return reason;
}

function normalizeRequiredInputString(value: unknown, label: string): string {
  const normalized = readNonEmptyString(value);
  if (!normalized) {
    throw requestError("invalid_input", `${label} must be a non-empty string`);
  }
  return normalized;
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

function validateCreateInput(input: CreateTeamTaskInput): Required<CreateTeamTaskInput> {
  if (!isRecord(input)) {
    throw requestError("invalid_input", "task create input must be an object");
  }

  const title = readNonEmptyString(input.title);
  if (!title) {
    throw requestError("invalid_input", "task title must be a non-empty string");
  }

  const description = readNonEmptyString(input.description);
  if (!description) {
    throw requestError("invalid_input", "task description must be a non-empty string");
  }

  if (!Array.isArray(input.acceptance) || input.acceptance.length === 0) {
    throw requestError("invalid_input", "task acceptance must contain at least one criterion");
  }
  const acceptance = input.acceptance.map((criterion, index) => {
    const normalized = readNonEmptyString(criterion);
    if (!normalized) {
      throw requestError(
        "invalid_input",
        `task acceptance criterion ${index + 1} must be a non-empty string`,
      );
    }
    return normalized;
  });

  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(dependencies)) {
    throw requestError("invalid_input", "task dependencies must be an array");
  }

  return {
    acceptance,
    dependencies: dependencies.map((dependency, index) => {
      const normalized = readNonEmptyString(dependency);
      if (!normalized) {
        throw requestError(
          "invalid_input",
          `task dependency ${index + 1} must be a non-empty string`,
        );
      }
      return normalized;
    }),
    description,
    title,
  };
}

function requireLeader(actor: TeamTaskActor): void {
  validateActor(actor);
  if (actor.role !== "leader") {
    throw requestError("permission_denied", "only a leader can mutate the task graph");
  }
}

function validateActor(actor: TeamTaskActor): void {
  if (!isRecord(actor) || (actor.role !== "leader" && actor.role !== "child")) {
    throw requestError("invalid_actor", "task actor role must be leader or child");
  }
  if (!readNonEmptyString(actor.sessionId)) {
    throw requestError("invalid_actor", "task actor sessionId must be a non-empty string");
  }
}

function findTask(graph: TeamTaskGraphFile, id: string): TeamTask {
  const task = graph.tasks.find((candidate) => candidate.id === id);
  if (!task) {
    throw requestError("task_not_found", `task "${id}" was not found`);
  }
  return task;
}

async function acquireLock(lockPath: string): Promise<fs.FileHandle> {
  const startedAt = performance.now();

  while (true) {
    try {
      return await fs.open(lockPath, "wx");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new TeamTaskStoreError(
          "graph_missing",
          `task graph directory is missing for ${lockPath}`,
          "degraded",
        );
      }
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw storeIoError("acquire task graph lock", error);
      }

      const elapsed = performance.now() - startedAt;
      if (elapsed >= TEAM_TASK_LOCK_TIMEOUT_MS) {
        throw new TeamTaskStoreError(
          "task_store_busy",
          `timed out waiting for task graph lock ${lockPath}`,
          "degraded",
        );
      }
      await delay(Math.min(TEAM_TASK_LOCK_RETRY_MS, TEAM_TASK_LOCK_TIMEOUT_MS - elapsed));
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw storeIoError("inspect task graph", error);
  }
}

async function ensureInitializationMarker(initializationPath: string): Promise<void> {
  try {
    await fs.writeFile(initializationPath, "", { flag: "wx" });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw storeIoError("write task graph initialization marker", error);
    }
  }
}

async function releaseLock(lock: fs.FileHandle, lockPath: string): Promise<void> {
  let closeError: unknown;
  let unlinkError: unknown;

  try {
    await lock.close();
  } catch (error) {
    closeError = error;
  }

  try {
    await fs.unlink(lockPath);
  } catch (error) {
    unlinkError = error;
  }

  if (closeError !== undefined || unlinkError !== undefined) {
    const details = [
      ...(closeError === undefined ? [] : [`close: ${errorMessage(closeError)}`]),
      ...(unlinkError === undefined ? [] : [`unlink: ${errorMessage(unlinkError)}`]),
    ].join("; ");
    throw new TeamTaskStoreError(
      "store_io",
      `failed to release task graph lock: ${details}`,
      "degraded",
    );
  }
}

function cleanupErrorWithCommittedMutation(
  error: unknown,
  committedMutation: TeamTaskMutationResult,
): TeamTaskStoreError {
  if (error instanceof TeamTaskStoreError) {
    return new TeamTaskStoreError(
      error.code,
      error.message,
      error.health,
      committedMutation,
    );
  }

  return new TeamTaskStoreError(
    "store_io",
    `failed to release task graph lock: ${errorMessage(error)}`,
    "degraded",
    committedMutation,
  );
}

function requestError(
  code:
    | "blocked_reason_not_allowed"
    | "blocked_reason_required"
    | "contract_frozen"
    | "delegated_task_mismatch"
    | "delete_not_allowed"
    | "dependencies_incomplete"
    | "evidence_not_allowed"
    | "evidence_required"
    | "invalid_actor"
    | "invalid_input"
    | "invalid_transition"
    | "permission_denied"
    | "task_frozen"
    | "task_not_found"
    | "task_not_ready",
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

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTeamTaskStatus(value: unknown): value is TeamTaskStatus {
  return value === "pending"
    || value === "in_progress"
    || value === "blocked"
    || value === "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
