export const TEAM_TASK_GRAPH_SCHEMA_VERSION = 2;

export type TeamTaskKind = "research" | "edit";
export type TeamTaskStatus =
  | "pending"
  | "in_progress"
  | "submitted"
  | "completed"
  | "blocked";
export type TeamTaskActorRole = "leader" | "teammate" | "child";
export type TeamTaskEvidenceReferenceKind = "artifact" | "trace" | "external";
export type TeamTaskGraphHealth = "healthy" | "degraded";
export type TeamTaskProfile = "research" | "edit";

export type TeamTaskFailureCode =
  | "capacity_exceeded"
  | "child_source_invalid"
  | "contract_frozen"
  | "delegated_task_mismatch"
  | "delete_not_allowed"
  | "dependencies_incomplete"
  | "dirty_target"
  | "evidence_not_allowed"
  | "evidence_required"
  | "fingerprint_mismatch"
  | "graph_invalid"
  | "graph_malformed"
  | "graph_missing"
  | "handoff_required"
  | "integration_conflict"
  | "invalid_actor"
  | "invalid_input"
  | "invalid_transition"
  | "owner_mismatch"
  | "permission_denied"
  | "plan_not_approved"
  | "schema_unsupported"
  | "source_drift"
  | "git_identity_missing"
  | "cherry_pick_in_progress"
  | "stale_approval"
  | "store_io"
  | "task_frozen"
  | "task_not_found"
  | "task_not_ready"
  | "task_store_busy"
  | "transfer_exhausted"
  | "verification_failed";

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

export type TeamTaskOwner =
  | { role: "leader" }
  | { name: string; role: "teammate" };

export interface TeamTaskPlan {
  approvedAt?: string;
  approvedBy?: "leader";
  decisionReason?: string;
  status: "pending" | "approved" | "rejected";
  steps: string[];
  submittedAt: string;
  submittedBy: { name: string; role: "teammate"; sessionId: string };
  summary: string;
}

export interface TeamTaskWorkspaceSource {
  branch: string;
  path: string;
}

export type TeamTaskResultSource =
  | {
      childSessionId: string;
      kind: "child";
      profile: TeamTaskProfile;
      workspace: TeamTaskWorkspaceSource;
    }
  | {
      kind: "teammate";
      name: string;
      profile: TeamTaskProfile;
      sessionId: string;
      workspace: TeamTaskWorkspaceSource;
    };

export interface TeamTaskSubmission {
  changedFiles?: string[];
  fingerprint?: string;
  source?: TeamTaskResultSource;
  submittedAt: string;
  submittedBy: TeamTaskActorIdentity;
  summary: string;
}

export interface TeamTaskVerdict {
  command?: string;
  decidedAt: string;
  decidedBy: "leader";
  fingerprint?: string;
  status: "passed";
  summary: string;
}

export interface TeamTaskHandoff {
  from: TeamTaskOwner;
  references?: TeamTaskEvidenceReference[];
  submittedAt: string;
  summary: string;
}

export interface TeamTaskIntegrationReceipt {
  fingerprint: string;
  integratedAt: string;
  integratedCommit: string;
  source: TeamTaskResultSource;
  sourceCommit: string;
  targetBefore: string;
}

export interface TeamTaskBlocker {
  code: string;
  reason: string;
  reportedAt: string;
  reportedBy: TeamTaskActorIdentity;
}

export interface TeamTaskTraceEntry {
  at: string;
  detail?: string;
  from?: TeamTaskStatus;
  owner?: TeamTaskOwner;
  revision: number;
  snapshot?: Record<string, unknown>;
  to?: TeamTaskStatus;
  type:
    | "acquired"
    | "blocked"
    | "contract_updated"
    | "handoff_submitted"
    | "integrated"
    | "plan_reviewed"
    | "plan_submitted"
    | "result_reviewed"
    | "result_submitted"
    | "transferred"
    | "verification_recorded";
}

export interface TeamTask {
  acceptance: string[];
  blocker?: TeamTaskBlocker;
  createdAt: string;
  dependencies: string[];
  description: string;
  evidence: TeamTaskEvidence[];
  handoff?: TeamTaskHandoff;
  id: string;
  integrationReceipt?: TeamTaskIntegrationReceipt;
  kind: TeamTaskKind;
  owner?: TeamTaskOwner;
  plan?: TeamTaskPlan;
  status: TeamTaskStatus;
  submission?: TeamTaskSubmission;
  title: string;
  trace: TeamTaskTraceEntry[];
  transferCount: number;
  updatedAt: string;
  verdict?: TeamTaskVerdict;
  verificationCommand?: string;
}

export interface TeamTaskGraphFile {
  nextTaskSequence: number;
  revision: number;
  schemaVersion: typeof TEAM_TASK_GRAPH_SCHEMA_VERSION;
  tasks: TeamTask[];
}

export interface CreateTeamTaskInput {
  acceptance: string[];
  dependencies?: string[];
  description: string;
  kind: TeamTaskKind;
  title: string;
  verificationCommand?: string;
}

export interface UpdateTeamTaskPatch {
  acceptance?: string[];
  dependencies?: string[];
  description?: string;
  kind?: TeamTaskKind;
  title?: string;
  verificationCommand?: string;
}

export interface AddTeamTaskEvidenceInput {
  callId: string;
  references?: TeamTaskEvidenceReference[];
  round: number;
  summary: string;
}

export interface TeamTaskSummary {
  availableActions: TeamTaskAvailableAction[];
  dependencies: string[];
  evidenceCount: number;
  id: string;
  kind: TeamTaskKind;
  owner?: TeamTaskOwner;
  ready: boolean;
  status: TeamTaskStatus;
  title: string;
}

export interface TeamTaskListResult {
  revision: number;
  tasks: TeamTaskSummary[];
}

export interface TeamTaskGetResult {
  availableActions: TeamTaskAvailableAction[];
  ready: boolean;
  revision: number;
  task: TeamTask;
}

export type TeamTaskMutationOperation =
  | "create"
  | "update"
  | "add_evidence"
  | "delete"
  | "transition"
  | "verify"
  | "integrate";

export interface TeamTaskMutationResult {
  nextStatus?: TeamTaskStatus;
  operation: TeamTaskMutationOperation;
  previousStatus?: TeamTaskStatus;
  revision: number;
  task: TeamTask;
}

export type TeamTaskActorIdentity =
  | { role: "leader"; sessionId: string }
  | { name: string; role: "teammate"; sessionId: string }
  | { role: "child"; sessionId: string };

export type TeamTaskActor =
  | { role: "leader"; sessionId: string }
  | {
      name: string;
      profile: TeamTaskProfile;
      role: "teammate";
      sessionId: string;
    }
  | {
      delegatedTaskId?: string;
      profile?: TeamTaskProfile;
      role: "child";
      sessionId: string;
    };

export type TeamTaskAssignee =
  | { role: "leader" }
  | { name: string; profile: TeamTaskProfile; role: "teammate" };

export type TeamTaskTransitionInput =
  | { action: "assign"; assignee: TeamTaskAssignee; id: string }
  | { action: "claim"; id: string }
  | { action: "submit_plan"; id: string; steps: string[]; summary: string }
  | {
      action: "review_plan";
      decision: "approve" | "reject";
      id: string;
      reason: string;
    }
  | {
      action: "submit_result";
      changedFiles?: string[];
      fingerprint?: string;
      id: string;
      source?: TeamTaskResultSource;
      summary: string;
    }
  | {
      action: "review_result";
      decision: "pass" | "reject";
      id: string;
      reason: string;
    }
  | {
      action: "submit_handoff";
      id: string;
      references?: TeamTaskEvidenceReference[];
      summary: string;
    }
  | { action: "transfer"; assignee: TeamTaskAssignee; id: string }
  | { action: "block"; code: string; id: string; reason: string };

export interface RecordTeamTaskVerificationInput {
  command: string;
  exitCode: number;
  fingerprint: string;
  summary: string;
}

export type TeamTaskAvailableAction =
  | "assign"
  | "claim"
  | "update"
  | "delete"
  | "add_evidence"
  | "submit_plan"
  | "review_plan"
  | "submit_result"
  | "review_result"
  | "verify"
  | "integrate"
  | "submit_handoff"
  | "transfer"
  | "block";

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

export function cloneTeamTaskGraph(graph: TeamTaskGraphFile): TeamTaskGraphFile {
  return structuredClone(graph);
}

export function cloneTeamTask(task: TeamTask): TeamTask {
  return structuredClone(task);
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
  const byId = new Map<string, TeamTask>();
  let maxSequence = 0;
  for (const task of tasks) {
    if (byId.has(task.id)) {
      throw invalidGraph(`task graph contains duplicate task id "${task.id}"`);
    }
    byId.set(task.id, task);
    maxSequence = Math.max(maxSequence, taskSequence(task.id));
  }
  if ((value.nextTaskSequence as number) <= maxSequence) {
    throw invalidGraph("task graph nextTaskSequence must be greater than every persisted task id");
  }
  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (dependencyId === task.id) {
        throw invalidGraph(`task "${task.id}" cannot depend on itself`);
      }
      if (!byId.has(dependencyId)) {
        throw invalidGraph(`task "${task.id}" has unknown dependency "${dependencyId}"`);
      }
    }
    if (
      task.status === "completed"
      && task.dependencies.some((id) => byId.get(id)?.status !== "completed")
    ) {
      throw invalidGraph(`completed task "${task.id}" has an incomplete dependency`);
    }
  }
  assertAcyclic(byId);
  assertOwnerCapacity(tasks);

  return {
    nextTaskSequence: value.nextTaskSequence as number,
    revision: value.revision as number,
    schemaVersion: TEAM_TASK_GRAPH_SCHEMA_VERSION,
    tasks,
  };
}

export function isTeamTaskReady(graph: TeamTaskGraphFile, task: TeamTask): boolean {
  if (task.status !== "pending" || task.owner !== undefined) {
    return false;
  }
  const byId = new Map(graph.tasks.map((candidate) => [candidate.id, candidate]));
  return task.dependencies.every((id) => byId.get(id)?.status === "completed");
}

export function availableTeamTaskActions(
  graph: TeamTaskGraphFile,
  task: TeamTask,
): TeamTaskAvailableAction[] {
  if (task.status === "completed" || task.status === "blocked") {
    return [];
  }
  if (task.status === "pending") {
    return isTeamTaskReady(graph, task)
      ? ["assign", "claim", "update", "delete", "block"]
      : ["update", "delete", "block"];
  }
  if (task.status === "submitted") {
    const actions: TeamTaskAvailableAction[] = task.kind === "research"
      ? ["review_result", "block"]
      : task.verdict?.status === "passed"
        ? ["integrate", "block"]
        : ["verify", "block"];
    if (task.owner?.role === "teammate") {
      actions.push("submit_handoff");
    }
    return actions;
  }
  const actions: TeamTaskAvailableAction[] = ["add_evidence", "block"];
  if (
    task.kind === "research"
    || task.owner?.role === "leader"
    || task.plan?.status === "approved"
  ) {
    actions.push("submit_result");
  }
  if (task.kind === "edit" && task.owner?.role === "teammate" && task.plan?.status !== "approved") {
    actions.push("submit_plan");
  }
  if (task.kind === "edit" && task.plan?.status === "pending") {
    actions.push("review_plan");
  }
  if (task.owner?.role === "teammate") {
    actions.push("submit_handoff");
    if (task.handoff) {
      actions.push("transfer");
    }
  }
  return [...new Set(actions)];
}

export function summarizeTeamTask(graph: TeamTaskGraphFile, task: TeamTask): TeamTaskSummary {
  return {
    availableActions: availableTeamTaskActions(graph, task),
    dependencies: [...task.dependencies],
    evidenceCount: task.evidence.length,
    id: task.id,
    kind: task.kind,
    ...(task.owner ? { owner: structuredClone(task.owner) } : {}),
    ready: isTeamTaskReady(graph, task),
    status: task.status,
    title: task.title,
  };
}

function parseTeamTask(value: unknown, index: number): TeamTask {
  const required = [
    "acceptance",
    "createdAt",
    "dependencies",
    "description",
    "evidence",
    "id",
    "kind",
    "status",
    "title",
    "trace",
    "transferCount",
    "updatedAt",
  ];
  const optional = [
    "blocker",
    "handoff",
    "integrationReceipt",
    "owner",
    "plan",
    "submission",
    "verdict",
    "verificationCommand",
  ];
  if (!isRecord(value) || !hasRequiredAndAllowedKeys(value, required, optional)) {
    throw invalidGraph(`task graph task ${index + 1} has invalid fields`);
  }

  const id = normalizedString(value.id, `task graph task ${index + 1} id`);
  taskSequence(id);
  const kind = parseKind(value.kind, id);
  const status = parseStatus(value.status, id);
  const createdAt = isoTimestamp(value.createdAt, `task "${id}" createdAt`);
  const updatedAt = isoTimestamp(value.updatedAt, `task "${id}" updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw invalidGraph(`task "${id}" updatedAt cannot precede createdAt`);
  }
  const acceptance = normalizedStringArray(value.acceptance, `task "${id}" acceptance`, true);
  const dependencies = normalizedStringArray(value.dependencies, `task "${id}" dependencies`, false);
  if (new Set(dependencies).size !== dependencies.length) {
    throw invalidGraph(`task "${id}" contains duplicate dependencies`);
  }
  if (!Array.isArray(value.evidence)) {
    throw invalidGraph(`task "${id}" evidence must be an array`);
  }
  const evidence = value.evidence.map((record, evidenceIndex) =>
    parseEvidence(record, id, evidenceIndex));
  if (!Array.isArray(value.trace)) {
    throw invalidGraph(`task "${id}" trace must be an array`);
  }
  const trace = value.trace.map((record, traceIndex) => parseTrace(record, id, traceIndex));
  if (!Number.isSafeInteger(value.transferCount) || (value.transferCount as number) < 0 || (value.transferCount as number) > 1) {
    throw invalidGraph(`task "${id}" transferCount must be 0 or 1`);
  }

  const verificationCommand = value.verificationCommand === undefined
    ? undefined
    : normalizedString(value.verificationCommand, `task "${id}" verificationCommand`);
  if (kind === "edit" && !verificationCommand) {
    throw invalidGraph(`edit task "${id}" requires verificationCommand`);
  }
  if (kind === "research" && verificationCommand !== undefined) {
    throw invalidGraph(`research task "${id}" cannot have verificationCommand`);
  }

  const owner = value.owner === undefined ? undefined : parseOwner(value.owner, id);
  if (status === "pending" && owner !== undefined) {
    throw invalidGraph(`pending task "${id}" cannot have an owner`);
  }
  if (status !== "pending" && status !== "blocked" && owner === undefined) {
    throw invalidGraph(`${status} task "${id}" requires an owner`);
  }
  const blocker = value.blocker === undefined ? undefined : parseBlocker(value.blocker, id);
  if (status === "blocked" && !blocker) {
    throw invalidGraph(`blocked task "${id}" requires a blocker`);
  }
  if (status !== "blocked" && blocker) {
    throw invalidGraph(`non-blocked task "${id}" cannot have a blocker`);
  }
  const submission = value.submission === undefined
    ? undefined
    : parseSubmission(value.submission, id, kind);
  if (status === "submitted" && !submission) {
    throw invalidGraph(`submitted task "${id}" requires a submission`);
  }
  if ((status === "pending" || status === "in_progress") && submission) {
    throw invalidGraph(`task "${id}" can retain a submission only after submission`);
  }
  const verdict = value.verdict === undefined ? undefined : parseVerdict(value.verdict, id);
  const receipt = value.integrationReceipt === undefined
    ? undefined
    : parseReceipt(value.integrationReceipt, id);
  const plan = value.plan === undefined ? undefined : parsePlan(value.plan, id);
  const handoff = value.handoff === undefined ? undefined : parseHandoff(value.handoff, id);
  if (status === "pending" && (evidence.length > 0 || plan || submission || verdict || receipt || handoff)) {
    throw invalidGraph(`pending task "${id}" cannot retain protocol state`);
  }
  if (status === "completed" && (!submission || !verdict)) {
    throw invalidGraph(`completed task "${id}" requires submission and verdict`);
  }
  if (receipt && (kind !== "edit" || status !== "completed")) {
    throw invalidGraph(`only a completed edit task "${id}" can have an integrationReceipt`);
  }
  if (plan && (kind !== "edit" || owner?.role !== "teammate" || plan.submittedBy.name !== owner.name)) {
    throw invalidGraph(`task "${id}" plan does not match its edit teammate owner`);
  }
  if (kind === "research") {
    if (verdict && status !== "completed") {
      throw invalidGraph(`research task "${id}" can have a verdict only when completed`);
    }
    if (verdict?.command || verdict?.fingerprint) {
      throw invalidGraph(`research task "${id}" verdict cannot contain edit verification fields`);
    }
  } else {
    if (submission?.source?.profile !== undefined && submission.source.profile !== "edit") {
      throw invalidGraph(`edit task "${id}" source must use the edit profile`);
    }
    if (
      verdict
      && (
        verdict.command !== verificationCommand
        || !verdict.fingerprint
        || verdict.fingerprint !== submission?.fingerprint
      )
    ) {
      throw invalidGraph(`edit task "${id}" verdict does not match its submission`);
    }
    if (status === "completed" && !receipt) {
      throw invalidGraph(`completed edit task "${id}" requires integrationReceipt`);
    }
    if (
      receipt
      && (
        receipt.fingerprint !== submission?.fingerprint
        || receipt.fingerprint !== verdict?.fingerprint
        || JSON.stringify(receipt.source) !== JSON.stringify(submission?.source)
      )
    ) {
      throw invalidGraph(`edit task "${id}" receipt does not match its verified submission`);
    }
  }
  if (submission && owner?.role === "leader" && submission.submittedBy.role !== "leader") {
    throw invalidGraph(`task "${id}" submission does not match its Leader owner`);
  }
  if (
    submission
    && owner?.role === "teammate"
    && (
      submission.submittedBy.role !== "teammate"
      || submission.submittedBy.name !== owner.name
    )
  ) {
    throw invalidGraph(`task "${id}" submission does not match its teammate owner`);
  }
  if (
    kind === "edit"
    && submission?.source
    && (
      (owner?.role === "leader" && submission.source.kind !== "child")
      || (
        owner?.role === "teammate"
        && (
          submission.source.kind !== "teammate"
          || submission.source.name !== owner.name
          || submission.submittedBy.role !== "teammate"
          || submission.source.sessionId !== submission.submittedBy.sessionId
        )
      )
    )
  ) {
    throw invalidGraph(`edit task "${id}" source does not match its owner and submitter`);
  }
  if (status === "completed" && evidence.length === 0) {
    throw invalidGraph(`completed task "${id}" requires evidence`);
  }

  return {
    acceptance,
    ...(blocker ? { blocker } : {}),
    createdAt,
    dependencies,
    description: normalizedString(value.description, `task "${id}" description`),
    evidence,
    ...(handoff ? { handoff } : {}),
    id,
    ...(receipt ? { integrationReceipt: receipt } : {}),
    kind,
    ...(owner ? { owner } : {}),
    ...(plan ? { plan } : {}),
    status,
    ...(submission ? { submission } : {}),
    title: normalizedString(value.title, `task "${id}" title`),
    trace,
    transferCount: value.transferCount as number,
    updatedAt,
    ...(verdict ? { verdict } : {}),
    ...(verificationCommand ? { verificationCommand } : {}),
  };
}

function parseEvidence(value: unknown, taskId: string, index: number): TeamTaskEvidence {
  const required = ["callId", "reportedAt", "reportedByRole", "reportedBySessionId", "round", "summary"];
  if (!isRecord(value) || !hasRequiredAndAllowedKeys(value, required, ["references"])) {
    throw invalidGraph(`task "${taskId}" evidence ${index + 1} has invalid fields`);
  }
  if (value.reportedByRole !== "leader" && value.reportedByRole !== "teammate" && value.reportedByRole !== "child") {
    throw invalidGraph(`task "${taskId}" evidence ${index + 1} has invalid reportedByRole`);
  }
  if (!Number.isSafeInteger(value.round) || (value.round as number) < 1) {
    throw invalidGraph(`task "${taskId}" evidence ${index + 1} round must be positive`);
  }
  return {
    callId: normalizedString(value.callId, `task "${taskId}" evidence ${index + 1} callId`),
    ...(value.references === undefined
      ? {}
      : { references: parseReferences(value.references, `task "${taskId}" evidence ${index + 1}`) }),
    reportedAt: isoTimestamp(value.reportedAt, `task "${taskId}" evidence ${index + 1} reportedAt`),
    reportedByRole: value.reportedByRole,
    reportedBySessionId: normalizedString(value.reportedBySessionId, `task "${taskId}" evidence ${index + 1} sessionId`),
    round: value.round as number,
    summary: normalizedString(value.summary, `task "${taskId}" evidence ${index + 1} summary`),
  };
}

function parseOwner(value: unknown, taskId: string): TeamTaskOwner {
  if (!isRecord(value)) {
    throw invalidGraph(`task "${taskId}" owner is invalid`);
  }
  if (value.role === "leader" && hasExactKeys(value, ["role"])) {
    return { role: "leader" };
  }
  if (value.role === "teammate" && hasExactKeys(value, ["name", "role"])) {
    return { name: normalizedString(value.name, `task "${taskId}" owner name`), role: "teammate" };
  }
  throw invalidGraph(`task "${taskId}" owner is invalid`);
}

function parsePlan(value: unknown, taskId: string): TeamTaskPlan {
  if (!isRecord(value) || !hasRequiredAndAllowedKeys(
    value,
    ["status", "steps", "submittedAt", "submittedBy", "summary"],
    ["approvedAt", "approvedBy", "decisionReason"],
  )) {
    throw invalidGraph(`task "${taskId}" plan is invalid`);
  }
  if (value.status !== "pending" && value.status !== "approved" && value.status !== "rejected") {
    throw invalidGraph(`task "${taskId}" plan status is invalid`);
  }
  if (!isRecord(value.submittedBy) || !hasExactKeys(value.submittedBy, ["name", "role", "sessionId"]) || value.submittedBy.role !== "teammate") {
    throw invalidGraph(`task "${taskId}" plan submitter is invalid`);
  }
  const approvedAt = value.approvedAt === undefined
    ? undefined
    : isoTimestamp(value.approvedAt, `task "${taskId}" plan approvedAt`);
  if (value.status === "approved" && (approvedAt === undefined || value.approvedBy !== "leader")) {
    throw invalidGraph(`approved task "${taskId}" plan requires Leader approval provenance`);
  }
  return {
    ...(approvedAt ? { approvedAt } : {}),
    ...(value.approvedBy === "leader" ? { approvedBy: "leader" as const } : {}),
    ...(value.decisionReason === undefined ? {} : { decisionReason: normalizedString(value.decisionReason, `task "${taskId}" plan decisionReason`) }),
    status: value.status,
    steps: normalizedStringArray(value.steps, `task "${taskId}" plan steps`, true),
    submittedAt: isoTimestamp(value.submittedAt, `task "${taskId}" plan submittedAt`),
    submittedBy: {
      name: normalizedString(value.submittedBy.name, `task "${taskId}" plan submitter name`),
      role: "teammate",
      sessionId: normalizedString(value.submittedBy.sessionId, `task "${taskId}" plan submitter sessionId`),
    },
    summary: normalizedString(value.summary, `task "${taskId}" plan summary`),
  };
}

function parseSubmission(value: unknown, taskId: string, kind: TeamTaskKind): TeamTaskSubmission {
  if (!isRecord(value) || !hasRequiredAndAllowedKeys(
    value,
    ["submittedAt", "submittedBy", "summary"],
    ["changedFiles", "fingerprint", "source"],
  )) {
    throw invalidGraph(`task "${taskId}" submission is invalid`);
  }
  const source = value.source === undefined ? undefined : parseSource(value.source, taskId);
  const fingerprint = value.fingerprint === undefined
    ? undefined
    : normalizedString(value.fingerprint, `task "${taskId}" submission fingerprint`);
  const changedFiles = value.changedFiles === undefined
    ? undefined
    : normalizedStringArray(value.changedFiles, `task "${taskId}" submission changedFiles`, false);
  if (kind === "edit" && (!source || !fingerprint || !changedFiles)) {
    throw invalidGraph(`edit task "${taskId}" submission requires source, changedFiles, and fingerprint`);
  }
  if (kind === "research" && (source || fingerprint || changedFiles)) {
    throw invalidGraph(`research task "${taskId}" submission cannot include an edit source`);
  }
  return {
    ...(changedFiles ? { changedFiles } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(source ? { source } : {}),
    submittedAt: isoTimestamp(value.submittedAt, `task "${taskId}" submission submittedAt`),
    submittedBy: parseIdentity(value.submittedBy, `task "${taskId}" submission submitter`),
    summary: normalizedString(value.summary, `task "${taskId}" submission summary`),
  };
}

function parseSource(value: unknown, taskId: string): TeamTaskResultSource {
  if (!isRecord(value) || !isRecord(value.workspace) || !hasExactKeys(value.workspace, ["branch", "path"])) {
    throw invalidGraph(`task "${taskId}" edit source is invalid`);
  }
  const workspace = {
    branch: normalizedString(value.workspace.branch, `task "${taskId}" source branch`),
    path: normalizedString(value.workspace.path, `task "${taskId}" source path`),
  };
  if (
    value.kind === "child"
    && hasExactKeys(value, ["childSessionId", "kind", "profile", "workspace"])
    && (value.profile === "research" || value.profile === "edit")
  ) {
    return {
      childSessionId: normalizedString(value.childSessionId, `task "${taskId}" child source sessionId`),
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
      name: normalizedString(value.name, `task "${taskId}" teammate source name`),
      profile: value.profile,
      sessionId: normalizedString(value.sessionId, `task "${taskId}" teammate source sessionId`),
      workspace,
    };
  }
  throw invalidGraph(`task "${taskId}" edit source is invalid`);
}

function parseVerdict(value: unknown, taskId: string): TeamTaskVerdict {
  if (!isRecord(value) || !hasRequiredAndAllowedKeys(
    value,
    ["decidedAt", "decidedBy", "status", "summary"],
    ["command", "fingerprint"],
  ) || value.decidedBy !== "leader" || value.status !== "passed") {
    throw invalidGraph(`task "${taskId}" verdict is invalid`);
  }
  return {
    ...(value.command === undefined ? {} : { command: normalizedString(value.command, `task "${taskId}" verdict command`) }),
    decidedAt: isoTimestamp(value.decidedAt, `task "${taskId}" verdict decidedAt`),
    decidedBy: "leader",
    ...(value.fingerprint === undefined ? {} : { fingerprint: normalizedString(value.fingerprint, `task "${taskId}" verdict fingerprint`) }),
    status: "passed",
    summary: normalizedString(value.summary, `task "${taskId}" verdict summary`),
  };
}

function parseHandoff(value: unknown, taskId: string): TeamTaskHandoff {
  if (!isRecord(value) || !hasRequiredAndAllowedKeys(value, ["from", "submittedAt", "summary"], ["references"])) {
    throw invalidGraph(`task "${taskId}" handoff is invalid`);
  }
  return {
    from: parseOwner(value.from, taskId),
    ...(value.references === undefined ? {} : { references: parseReferences(value.references, `task "${taskId}" handoff`) }),
    submittedAt: isoTimestamp(value.submittedAt, `task "${taskId}" handoff submittedAt`),
    summary: normalizedString(value.summary, `task "${taskId}" handoff summary`),
  };
}

function parseReceipt(value: unknown, taskId: string): TeamTaskIntegrationReceipt {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["fingerprint", "integratedAt", "integratedCommit", "source", "sourceCommit", "targetBefore"],
  )) {
    throw invalidGraph(`task "${taskId}" integration receipt is invalid`);
  }
  return {
    fingerprint: normalizedString(value.fingerprint, `task "${taskId}" receipt fingerprint`),
    integratedAt: isoTimestamp(value.integratedAt, `task "${taskId}" receipt integratedAt`),
    integratedCommit: normalizedString(value.integratedCommit, `task "${taskId}" receipt integratedCommit`),
    source: parseSource(value.source, taskId),
    sourceCommit: normalizedString(value.sourceCommit, `task "${taskId}" receipt sourceCommit`),
    targetBefore: normalizedString(value.targetBefore, `task "${taskId}" receipt targetBefore`),
  };
}

function parseBlocker(value: unknown, taskId: string): TeamTaskBlocker {
  if (!isRecord(value) || !hasExactKeys(value, ["code", "reason", "reportedAt", "reportedBy"])) {
    throw invalidGraph(`task "${taskId}" blocker is invalid`);
  }
  return {
    code: normalizedString(value.code, `task "${taskId}" blocker code`),
    reason: normalizedString(value.reason, `task "${taskId}" blocker reason`),
    reportedAt: isoTimestamp(value.reportedAt, `task "${taskId}" blocker reportedAt`),
    reportedBy: parseIdentity(value.reportedBy, `task "${taskId}" blocker reporter`),
  };
}

function parseTrace(value: unknown, taskId: string, index: number): TeamTaskTraceEntry {
  if (!isRecord(value) || !hasRequiredAndAllowedKeys(
    value,
    ["at", "revision", "type"],
    ["detail", "from", "owner", "snapshot", "to"],
  )) {
    throw invalidGraph(`task "${taskId}" trace ${index + 1} is invalid`);
  }
  const types: TeamTaskTraceEntry["type"][] = [
    "acquired",
    "blocked",
    "contract_updated",
    "handoff_submitted",
    "integrated",
    "plan_reviewed",
    "plan_submitted",
    "result_reviewed",
    "result_submitted",
    "transferred",
    "verification_recorded",
  ];
  if (!types.includes(value.type as TeamTaskTraceEntry["type"])) {
    throw invalidGraph(`task "${taskId}" trace ${index + 1} type is invalid`);
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw invalidGraph(`task "${taskId}" trace ${index + 1} revision is invalid`);
  }
  return {
    at: isoTimestamp(value.at, `task "${taskId}" trace ${index + 1} at`),
    ...(value.detail === undefined ? {} : { detail: normalizedString(value.detail, `task "${taskId}" trace ${index + 1} detail`) }),
    ...(value.from === undefined ? {} : { from: parseStatus(value.from, taskId) }),
    ...(value.owner === undefined ? {} : { owner: parseOwner(value.owner, taskId) }),
    revision: value.revision as number,
    ...(value.snapshot === undefined
      ? {}
      : isRecord(value.snapshot)
        ? { snapshot: structuredClone(value.snapshot) }
        : (() => {
            throw invalidGraph(`task "${taskId}" trace ${index + 1} snapshot is invalid`);
          })()),
    ...(value.to === undefined ? {} : { to: parseStatus(value.to, taskId) }),
    type: value.type as TeamTaskTraceEntry["type"],
  };
}

function parseIdentity(value: unknown, label: string): TeamTaskActorIdentity {
  if (!isRecord(value)) {
    throw invalidGraph(`${label} is invalid`);
  }
  if (value.role === "leader" && hasExactKeys(value, ["role", "sessionId"])) {
    return { role: "leader", sessionId: normalizedString(value.sessionId, `${label} sessionId`) };
  }
  if (value.role === "child" && hasExactKeys(value, ["role", "sessionId"])) {
    return { role: "child", sessionId: normalizedString(value.sessionId, `${label} sessionId`) };
  }
  if (value.role === "teammate" && hasExactKeys(value, ["name", "role", "sessionId"])) {
    return {
      name: normalizedString(value.name, `${label} name`),
      role: "teammate",
      sessionId: normalizedString(value.sessionId, `${label} sessionId`),
    };
  }
  throw invalidGraph(`${label} is invalid`);
}

function parseReferences(value: unknown, label: string): TeamTaskEvidenceReference[] {
  if (!Array.isArray(value)) {
    throw invalidGraph(`${label} references must be an array`);
  }
  return value.map((reference, index) => {
    if (!isRecord(reference) || !hasExactKeys(reference, ["kind", "value"])) {
      throw invalidGraph(`${label} reference ${index + 1} is invalid`);
    }
    if (reference.kind !== "artifact" && reference.kind !== "trace" && reference.kind !== "external") {
      throw invalidGraph(`${label} reference ${index + 1} kind is invalid`);
    }
    return {
      kind: reference.kind,
      value: normalizedString(reference.value, `${label} reference ${index + 1} value`),
    };
  });
}

function parseKind(value: unknown, taskId: string): TeamTaskKind {
  if (value !== "research" && value !== "edit") {
    throw invalidGraph(`task "${taskId}" kind is invalid`);
  }
  return value;
}

function parseStatus(value: unknown, taskId: string): TeamTaskStatus {
  if (
    value !== "pending"
    && value !== "in_progress"
    && value !== "submitted"
    && value !== "completed"
    && value !== "blocked"
  ) {
    throw invalidGraph(`task "${taskId}" status is invalid`);
  }
  return value;
}

function normalizedStringArray(value: unknown, label: string, requireNonEmpty: boolean): string[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    throw invalidGraph(`${label} must be ${requireNonEmpty ? "a non-empty" : "an"} array`);
  }
  return value.map((entry, index) => normalizedString(entry, `${label} ${index + 1}`));
}

function assertOwnerCapacity(tasks: TeamTask[]): void {
  const active = new Map<string, string>();
  for (const task of tasks) {
    if (
      task.owner?.role !== "teammate"
      || task.status === "completed"
      || task.status === "blocked"
    ) {
      continue;
    }
    const existing = active.get(task.owner.name);
    if (existing) {
      throw invalidGraph(`teammate "${task.owner.name}" owns active tasks "${existing}" and "${task.id}"`);
    }
    active.set(task.owner.name, task.id);
  }
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
  if (!Number.isSafeInteger(sequence) || sequence < 1 || `task_${String(sequence).padStart(3, "0")}` !== id) {
    throw invalidGraph(`task id "${id}" has an invalid sequence`);
  }
  return sequence;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw invalidGraph(`${label} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw invalidGraph(`${label} must be an ISO timestamp`);
  }
  return value;
}

function normalizedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw invalidGraph(`${label} must be a normalized non-empty string`);
  }
  return value;
}

function invalidGraph(message: string): TeamTaskStoreError {
  return new TeamTaskStoreError("graph_invalid", message, "degraded");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
