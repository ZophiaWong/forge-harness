export const TEAM_TASK_GRAPH_SCHEMA_VERSION = 1;

export type TeamTaskStatus = "pending" | "in_progress" | "blocked" | "completed";
export type TeamTaskActorRole = "leader" | "child";
export type TeamTaskEvidenceReferenceKind = "artifact" | "trace" | "external";
export type TeamTaskGraphHealth = "healthy" | "degraded";
export type TeamTaskFailureCode =
  | "blocked_reason_not_allowed"
  | "blocked_reason_required"
  | "contract_frozen"
  | "delegated_task_mismatch"
  | "delete_not_allowed"
  | "dependencies_incomplete"
  | "evidence_not_allowed"
  | "evidence_required"
  | "graph_invalid"
  | "graph_malformed"
  | "graph_missing"
  | "invalid_actor"
  | "invalid_input"
  | "invalid_transition"
  | "task_store_busy"
  | "permission_denied"
  | "schema_unsupported"
  | "store_io"
  | "task_frozen"
  | "task_not_ready"
  | "task_not_found";

export interface TeamTaskEvidenceReference {
  kind: TeamTaskEvidenceReferenceKind;
  value: string;
}

export interface TeamTaskEvidence {
  callId: string;
  references?: TeamTaskEvidenceReference[];
  reportedAt: string;
  reportedByRole: TeamTaskActorRole;
  reportedBySessionId: string;
  round: number;
  summary: string;
}

export interface TeamTask {
  acceptance: string[];
  blockedReason?: string;
  createdAt: string;
  dependencies: string[];
  description: string;
  evidence: TeamTaskEvidence[];
  id: string;
  status: TeamTaskStatus;
  title: string;
  updatedAt: string;
}

export interface TeamTaskGraphFile {
  nextTaskSequence: number;
  revision: number;
  schemaVersion: number;
  tasks: TeamTask[];
}

export interface CreateTeamTaskInput {
  acceptance: string[];
  dependencies?: string[];
  description: string;
  title: string;
}

export interface UpdateTeamTaskPatch {
  acceptance?: string[];
  blockedReason?: string;
  dependencies?: string[];
  description?: string;
  status?: TeamTaskStatus;
  title?: string;
}

export interface AddTeamTaskEvidenceInput {
  callId: string;
  references?: TeamTaskEvidenceReference[];
  round: number;
  summary: string;
}

export interface TeamTaskSummary {
  dependencies: string[];
  evidenceCount: number;
  id: string;
  ready: boolean;
  status: TeamTaskStatus;
  title: string;
}

export interface TeamTaskListResult {
  revision: number;
  tasks: TeamTaskSummary[];
}

export interface TeamTaskGetResult {
  ready: boolean;
  revision: number;
  task: TeamTask;
}

export type TeamTaskMutationOperation = "create" | "update" | "add_evidence" | "delete";

export interface TeamTaskMutationResult {
  nextStatus?: TeamTaskStatus;
  operation: TeamTaskMutationOperation;
  previousStatus?: TeamTaskStatus;
  revision: number;
  task: TeamTask;
}

export type TeamTaskActor =
  | {
      role: "leader";
      sessionId: string;
    }
  | {
      delegatedTaskId?: string;
      role: "child";
      sessionId: string;
    };

export class TeamTaskStoreError extends Error {
  readonly code: TeamTaskFailureCode;
  declare readonly committedMutation?: TeamTaskMutationResult;
  readonly health: TeamTaskGraphHealth;

  constructor(
    code: TeamTaskFailureCode,
    message: string,
    health: TeamTaskGraphHealth,
    committedMutation?: TeamTaskMutationResult,
  ) {
    super(message);
    this.name = "TeamTaskStoreError";
    this.code = code;
    if (committedMutation) {
      this.committedMutation = committedMutation;
    }
    this.health = health;
  }
}

export function parseTeamTaskGraphFile(value: unknown): TeamTaskGraphFile {
  if (!isRecord(value) || !hasExactKeys(value, ["nextTaskSequence", "revision", "schemaVersion", "tasks"])) {
    throw invalidGraph("task graph must contain only schemaVersion, revision, nextTaskSequence, and tasks");
  }

  if (!Number.isSafeInteger(value.schemaVersion)) {
    throw invalidGraph("task graph schemaVersion must be a safe integer");
  }

  if (value.schemaVersion !== TEAM_TASK_GRAPH_SCHEMA_VERSION) {
    throw new TeamTaskStoreError(
      "schema_unsupported",
      `unsupported task graph schema version ${String(value.schemaVersion)}`,
      "degraded",
    );
  }

  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw invalidGraph("task graph revision must be a non-negative safe integer");
  }

  if (!Number.isSafeInteger(value.nextTaskSequence) || (value.nextTaskSequence as number) < 1) {
    throw invalidGraph("task graph nextTaskSequence must be a positive safe integer");
  }

  if (!Array.isArray(value.tasks)) {
    throw invalidGraph("task graph tasks must be an array");
  }

  const tasks = value.tasks.map((task, index) => parseTeamTask(task, index));
  const tasksById = new Map<string, TeamTask>();
  let maxTaskSequence = 0;

  for (const task of tasks) {
    if (tasksById.has(task.id)) {
      throw invalidGraph(`task graph contains duplicate task id "${task.id}"`);
    }
    tasksById.set(task.id, task);
    maxTaskSequence = Math.max(maxTaskSequence, taskSequence(task.id));
  }

  if ((value.nextTaskSequence as number) <= maxTaskSequence) {
    throw invalidGraph("task graph nextTaskSequence must be greater than every persisted task id");
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (dependencyId === task.id) {
        throw invalidGraph(`task "${task.id}" cannot depend on itself`);
      }
      if (!tasksById.has(dependencyId)) {
        throw invalidGraph(`task "${task.id}" has unknown dependency "${dependencyId}"`);
      }
    }

    if (
      task.status === "completed"
      && task.dependencies.some((dependencyId) => tasksById.get(dependencyId)?.status !== "completed")
    ) {
      throw invalidGraph(`completed task "${task.id}" has an incomplete dependency`);
    }
  }

  assertAcyclic(tasksById);

  return {
    nextTaskSequence: value.nextTaskSequence as number,
    revision: value.revision as number,
    schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
    tasks,
  };
}

export function cloneTeamTaskGraph(graph: TeamTaskGraphFile): TeamTaskGraphFile {
  return structuredClone(graph);
}

export function cloneTeamTask(task: TeamTask): TeamTask {
  return structuredClone(task);
}

export function isTeamTaskReady(graph: TeamTaskGraphFile, task: TeamTask): boolean {
  let validated: TeamTaskGraphFile;
  try {
    validated = parseTeamTaskGraphFile(graph);
  } catch {
    return false;
  }

  const validatedTask = validated.tasks.find((candidate) => candidate.id === task.id);
  if (!validatedTask || validatedTask.status !== "pending") {
    return false;
  }

  const tasksById = new Map(validated.tasks.map((candidate) => [candidate.id, candidate]));
  return validatedTask.dependencies.every(
    (dependencyId) => tasksById.get(dependencyId)?.status === "completed",
  );
}

export function summarizeTeamTask(graph: TeamTaskGraphFile, task: TeamTask): TeamTaskSummary {
  return {
    dependencies: [...task.dependencies],
    evidenceCount: task.evidence.length,
    id: task.id,
    ready: isTeamTaskReady(graph, task),
    status: task.status,
    title: task.title,
  };
}

function invalidGraph(message: string): TeamTaskStoreError {
  return new TeamTaskStoreError("graph_invalid", message, "degraded");
}

function parseTeamTask(value: unknown, index: number): TeamTask {
  const requiredKeys = [
    "acceptance",
    "createdAt",
    "dependencies",
    "description",
    "evidence",
    "id",
    "status",
    "title",
    "updatedAt",
  ];
  if (!isRecord(value) || !hasRequiredAndAllowedKeys(value, requiredKeys, ["blockedReason"])) {
    throw invalidGraph(`task graph task ${index + 1} has invalid fields`);
  }

  const id = readNormalizedString(value.id, `task graph task ${index + 1} id`);
  taskSequence(id);
  const title = readNormalizedString(value.title, `task "${id}" title`);
  const description = readNormalizedString(value.description, `task "${id}" description`);
  const createdAt = readIsoTimestamp(value.createdAt, `task "${id}" createdAt`);
  const updatedAt = readIsoTimestamp(value.updatedAt, `task "${id}" updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw invalidGraph(`task "${id}" updatedAt cannot precede createdAt`);
  }

  if (!isTeamTaskStatus(value.status)) {
    throw invalidGraph(`task "${id}" has invalid status`);
  }

  const blockedReason = value.blockedReason === undefined
    ? undefined
    : readNormalizedString(value.blockedReason, `task "${id}" blockedReason`);
  if (value.status === "blocked" && !blockedReason) {
    throw invalidGraph(`blocked task "${id}" must have a blockedReason`);
  }
  if (value.status !== "blocked" && blockedReason !== undefined) {
    throw invalidGraph(`non-blocked task "${id}" cannot have a blockedReason`);
  }

  if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) {
    throw invalidGraph(`task "${id}" acceptance must contain at least one criterion`);
  }
  const acceptance = value.acceptance.map((criterion, acceptanceIndex) =>
    readNormalizedString(criterion, `task "${id}" acceptance criterion ${acceptanceIndex + 1}`));

  if (!Array.isArray(value.dependencies)) {
    throw invalidGraph(`task "${id}" dependencies must be an array`);
  }
  const dependencies = value.dependencies.map((dependency, dependencyIndex) => {
    const dependencyId = readNormalizedString(
      dependency,
      `task "${id}" dependency ${dependencyIndex + 1}`,
    );
    taskSequence(dependencyId);
    return dependencyId;
  });
  if (new Set(dependencies).size !== dependencies.length) {
    throw invalidGraph(`task "${id}" contains duplicate dependencies`);
  }

  if (!Array.isArray(value.evidence)) {
    throw invalidGraph(`task "${id}" evidence must be an array`);
  }
  const evidence = value.evidence.map((record, evidenceIndex) =>
    parseTeamTaskEvidence(record, id, evidenceIndex));
  if (value.status === "completed" && evidence.length === 0) {
    throw invalidGraph(`completed task "${id}" must contain evidence`);
  }

  return {
    acceptance,
    ...(blockedReason ? { blockedReason } : {}),
    createdAt,
    dependencies,
    description,
    evidence,
    id,
    status: value.status,
    title,
    updatedAt,
  };
}

function parseTeamTaskEvidence(value: unknown, taskId: string, index: number): TeamTaskEvidence {
  const requiredKeys = [
    "callId",
    "reportedAt",
    "reportedByRole",
    "reportedBySessionId",
    "round",
    "summary",
  ];
  if (!isRecord(value) || !hasRequiredAndAllowedKeys(value, requiredKeys, ["references"])) {
    throw invalidGraph(`task "${taskId}" evidence ${index + 1} has invalid fields`);
  }

  if (value.reportedByRole !== "leader" && value.reportedByRole !== "child") {
    throw invalidGraph(`task "${taskId}" evidence ${index + 1} has invalid reportedByRole`);
  }
  if (!Number.isSafeInteger(value.round) || (value.round as number) < 1) {
    throw invalidGraph(`task "${taskId}" evidence ${index + 1} round must be positive`);
  }

  const references = value.references === undefined
    ? undefined
    : parseEvidenceReferences(value.references, taskId, index);

  return {
    callId: readNormalizedString(
      value.callId,
      `task "${taskId}" evidence ${index + 1} callId`,
    ),
    ...(references ? { references } : {}),
    reportedAt: readIsoTimestamp(
      value.reportedAt,
      `task "${taskId}" evidence ${index + 1} reportedAt`,
    ),
    reportedByRole: value.reportedByRole,
    reportedBySessionId: readNormalizedString(
      value.reportedBySessionId,
      `task "${taskId}" evidence ${index + 1} reportedBySessionId`,
    ),
    round: value.round as number,
    summary: readNormalizedString(value.summary, `task "${taskId}" evidence ${index + 1} summary`),
  };
}

function parseEvidenceReferences(
  value: unknown,
  taskId: string,
  evidenceIndex: number,
): TeamTaskEvidenceReference[] {
  if (!Array.isArray(value)) {
    throw invalidGraph(`task "${taskId}" evidence ${evidenceIndex + 1} references must be an array`);
  }

  return value.map((reference, referenceIndex) => {
    if (!isRecord(reference) || !hasExactKeys(reference, ["kind", "value"])) {
      throw invalidGraph(
        `task "${taskId}" evidence ${evidenceIndex + 1} reference ${referenceIndex + 1} is invalid`,
      );
    }
    if (
      reference.kind !== "artifact"
      && reference.kind !== "trace"
      && reference.kind !== "external"
    ) {
      throw invalidGraph(
        `task "${taskId}" evidence ${evidenceIndex + 1} reference ${referenceIndex + 1} has invalid kind`,
      );
    }
    return {
      kind: reference.kind,
      value: readNormalizedString(
        reference.value,
        `task "${taskId}" evidence ${evidenceIndex + 1} reference ${referenceIndex + 1} value`,
      ),
    };
  });
}

function assertAcyclic(tasksById: Map<string, TeamTask>): void {
  const visitState = new Map<string, "visiting" | "visited">();

  const visit = (taskId: string): void => {
    const state = visitState.get(taskId);
    if (state === "visiting") {
      throw invalidGraph(`task graph contains a dependency cycle at "${taskId}"`);
    }
    if (state === "visited") {
      return;
    }

    visitState.set(taskId, "visiting");
    for (const dependencyId of tasksById.get(taskId)?.dependencies ?? []) {
      visit(dependencyId);
    }
    visitState.set(taskId, "visited");
  };

  for (const taskId of tasksById.keys()) {
    visit(taskId);
  }
}

function taskSequence(id: string): number {
  const match = /^task_(\d{3,})$/.exec(id);
  if (!match) {
    throw invalidGraph(`task id "${id}" must use the task_NNN format`);
  }

  const sequence = Number(match[1]);
  if (
    !Number.isSafeInteger(sequence)
    || sequence < 1
    || `task_${String(sequence).padStart(3, "0")}` !== id
  ) {
    throw invalidGraph(`task id "${id}" has an invalid sequence`);
  }
  return sequence;
}

function readNormalizedString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw invalidGraph(`${label} must be a normalized non-empty string`);
  }
  return value;
}

function readIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw invalidGraph(`${label} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalidGraph(`${label} must be an ISO timestamp`);
  }
  return value;
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

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  requiredKeys: string[],
  optionalKeys: string[],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}
