import {
  TeamTaskStoreError,
  type AddTeamTaskEvidenceInput,
  type CreateTeamTaskInput,
  type TeamTask,
  type TeamTaskActor,
  type TeamTaskAvailableAction,
  type TeamTaskGetResult,
  type TeamTaskListResult,
  type TeamTaskMutationResult,
  type TeamTaskResultSource,
  type TeamTaskTransitionInput,
  type UpdateTeamTaskPatch,
} from "../domain/teamTask.js";
import type { AsyncChildSessionManager } from "../extensions/childSessions.js";
import type { TeammateManager } from "../extensions/teammates.js";
import {
  GitIntegrationError,
  type GitIntegrationService,
  type GitReviewPreview,
} from "../runtime/gitIntegration.js";
import type { TeamTaskStore } from "../runtime/teamTaskStore.js";
import { createToolRuntime } from "./runtime.js";
import type { RegisteredTool, ToolDefinition, ToolResult, ToolRuntime } from "./types.js";

const TASK_LIST = "task_list";
const TASK_GET = "task_get";
const TASK_CREATE = "task_create";
const TASK_UPDATE = "task_update";
const TASK_ADD_EVIDENCE = "task_add_evidence";
const TASK_TRANSITION = "task_transition";
const TASK_VERIFY = "task_verify";
const TASK_INTEGRATE = "task_integrate";
const COMMITTED_MUTATION_CLEANUP_WARNING =
  "task graph mutation committed but lock cleanup failed";

const idProperty = {
  description: "Team task id, such as task_001.",
  type: "string",
};
const stringArray = { items: { type: "string" }, type: "array" };
const evidenceReferences = {
  items: {
    additionalProperties: false,
    properties: {
      kind: { enum: ["artifact", "trace", "external"], type: "string" },
      value: { type: "string" },
    },
    required: ["kind", "value"],
    type: "object",
  },
  type: "array",
};

export const taskListToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_LIST,
  description: "List team tasks with derived readiness and currently available protocol actions.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
    required: [],
  },
};

export const taskGetToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_GET,
  description: "Get one task contract, ownership, protocol state, evidence, and trace.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { id: idProperty },
    required: ["id"],
  },
};

export const taskCreateToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_CREATE,
  description: "Create one pending research or edit task. Edit tasks require verificationCommand.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      acceptance: stringArray,
      dependencies: stringArray,
      description: { type: "string" },
      kind: { enum: ["research", "edit"], type: "string" },
      title: { type: "string" },
      verificationCommand: { type: "string" },
    },
    required: ["title", "description", "acceptance", "kind"],
  },
};

export const taskUpdateToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_UPDATE,
  description: "Modify or delete only an unacquired pending task contract.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      acceptance: stringArray,
      delete: { type: "boolean" },
      dependencies: stringArray,
      description: { type: "string" },
      id: idProperty,
      kind: { enum: ["research", "edit"], type: "string" },
      title: { type: "string" },
      verificationCommand: { type: "string" },
    },
    required: ["id"],
  },
};

export const taskAddEvidenceToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_ADD_EVIDENCE,
  description: "Append evidence to an owned or delegated in-progress task.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: idProperty,
      references: evidenceReferences,
      summary: { type: "string" },
    },
    required: ["id", "summary"],
  },
};

export const taskTransitionToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_TRANSITION,
  description:
    "Perform one coordination protocol action. Ownership, status, plans, reviews, handoff, transfer, and blocking cannot be changed through task_update.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        enum: [
          "assign",
          "claim",
          "submit_plan",
          "review_plan",
          "submit_result",
          "review_result",
          "submit_handoff",
          "transfer",
          "block",
        ],
        type: "string",
      },
      assignee: { type: "string" },
      childSessionId: { type: "string" },
      code: { type: "string" },
      decision: { enum: ["approve", "reject", "pass"], type: "string" },
      id: idProperty,
      reason: { type: "string" },
      references: evidenceReferences,
      steps: stringArray,
      summary: { type: "string" },
    },
    required: ["action", "id"],
  },
};

export const taskVerifyToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_VERIFY,
  description:
    "Run the submitted edit task's exact verification command in its registered source workspace.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      id: idProperty,
    },
    required: ["id", "command"],
  },
};

export const taskIntegrateToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_INTEGRATE,
  description:
    "Commit the current verified source using Forge trailers and cherry-pick it into the clean Leader target.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { id: idProperty },
    required: ["id"],
  },
};

export interface TeamTaskToolRuntimeOptions {
  actor: TeamTaskActor;
  childSessions?: AsyncChildSessionManager;
  gitIntegration?: GitIntegrationService;
  ownWorkspace?: { branch: string; path: string };
  store: TeamTaskStore;
  teammates?: TeammateManager;
}

export function createTeamTaskTools(options: TeamTaskToolRuntimeOptions): RegisteredTool[] {
  const inspect = [createListTool(options), createGetTool(options)];
  if (options.actor.role === "child") {
    return options.actor.delegatedTaskId
      ? [...inspect, createEvidenceTool(options)]
      : inspect;
  }
  if (options.actor.role === "teammate") {
    return [
      ...inspect,
      createEvidenceTool(options),
      createTransitionTool(options),
    ];
  }
  return [
    ...inspect,
    createCreateTool(options),
    createUpdateTool(options),
    createEvidenceTool(options),
    createTransitionTool(options),
    createVerifyTool(options),
    createIntegrateTool(options),
  ];
}

export function createTeamTaskToolRuntime(options: TeamTaskToolRuntimeOptions): ToolRuntime {
  return createToolRuntime(createTeamTaskTools(options));
}

function createListTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskListToolDefinition,
    async handler({ rawArguments }) {
      return handle(TASK_LIST, async () => {
        parseObject(rawArguments, TASK_LIST, []);
        const result = filterListActions(await options.store.list(), options.actor);
        return completedRead(
          TASK_LIST,
          formatList(result),
          `listed ${result.tasks.length} team task${result.tasks.length === 1 ? "" : "s"} at revision ${result.revision}`,
          { revision: result.revision, tasks: result.tasks },
        );
      });
    },
  };
}

function createGetTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskGetToolDefinition,
    async handler({ rawArguments }) {
      return handle(TASK_GET, async () => {
        const input = parseObject(rawArguments, TASK_GET, ["id"]);
        const id = requiredString(input.id, `${TASK_GET} id`);
        const result = filterGetActions(await options.store.get(id), options.actor);
        let review: GitReviewPreview | { error: string } | undefined;
        if (
          options.actor.role === "leader"
          && result.task.kind === "edit"
          && result.task.status === "submitted"
          && options.gitIntegration
        ) {
          try {
            review = await options.gitIntegration.review(result.task);
          } catch (error) {
            review = { error: errorMessage(error) };
          }
        }
        return completedRead(
          TASK_GET,
          formatGet(result, review),
          `read team task ${id} at revision ${result.revision}`,
          {
            availableActions: result.availableActions,
            ready: result.ready,
            ...(review ? { review } : {}),
            revision: result.revision,
            task: result.task,
          },
        );
      });
    },
  };
}

function createCreateTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskCreateToolDefinition,
    async handler({ rawArguments }) {
      return handle(TASK_CREATE, async () => {
        const input = parseObject(rawArguments, TASK_CREATE, [
          "acceptance",
          "dependencies",
          "description",
          "kind",
          "title",
          "verificationCommand",
        ]);
        return completedMutation(
          TASK_CREATE,
          await options.store.create(options.actor, input as unknown as CreateTeamTaskInput),
        );
      });
    },
  };
}

function createUpdateTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskUpdateToolDefinition,
    async handler({ rawArguments }) {
      return handle(TASK_UPDATE, async () => {
        const input = parseObject(rawArguments, TASK_UPDATE, [
          "acceptance",
          "delete",
          "dependencies",
          "description",
          "id",
          "kind",
          "title",
          "verificationCommand",
        ]);
        const id = requiredString(input.id, `${TASK_UPDATE} id`);
        const { delete: shouldDelete, id: _id, ...patch } = input;
        if (shouldDelete !== undefined && typeof shouldDelete !== "boolean") {
          throw invalidArguments("task_update delete must be a boolean");
        }
        if (shouldDelete === true && Object.keys(patch).length > 0) {
          throw invalidArguments("task_update delete is mutually exclusive with contract fields");
        }
        const result = shouldDelete === true
          ? await options.store.delete(options.actor, id)
          : await options.store.update(
            options.actor,
            id,
            patch as unknown as UpdateTeamTaskPatch,
          );
        return completedMutation(TASK_UPDATE, result);
      });
    },
  };
}

function createEvidenceTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskAddEvidenceToolDefinition,
    async handler({ callId, rawArguments, round }) {
      return handle(TASK_ADD_EVIDENCE, async () => {
        const input = parseObject(rawArguments, TASK_ADD_EVIDENCE, [
          "id",
          "references",
          "summary",
        ]);
        const id = requiredString(input.id, `${TASK_ADD_EVIDENCE} id`);
        return completedMutation(
          TASK_ADD_EVIDENCE,
          await options.store.addEvidence(options.actor, id, {
            callId: callId ?? "",
            ...(input.references === undefined
              ? {}
              : { references: input.references as AddTeamTaskEvidenceInput["references"] }),
            round: round ?? 0,
            summary: input.summary as string,
          }),
        );
      });
    },
  };
}

function createTransitionTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskTransitionToolDefinition,
    async handler({ rawArguments }) {
      return handle(TASK_TRANSITION, async () => {
        const input = parseObject(rawArguments, TASK_TRANSITION, [
          "action",
          "assignee",
          "childSessionId",
          "code",
          "decision",
          "id",
          "reason",
          "references",
          "steps",
          "summary",
        ]);
        const transition = await buildTransitionInput(options, input);
        return completedMutation(
          TASK_TRANSITION,
          await options.store.transition(options.actor, transition),
        );
      });
    },
  };
}

function createVerifyTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskVerifyToolDefinition,
    async handler({ rawArguments }) {
      return handle(TASK_VERIFY, async () => {
        if (!options.gitIntegration) {
          throw invalidArguments("task_verify requires Git integration");
        }
        const input = parseObject(rawArguments, TASK_VERIFY, ["command", "id"]);
        const id = requiredString(input.id, `${TASK_VERIFY} id`);
        const command = requiredString(input.command, `${TASK_VERIFY} command`);
        const task = (await options.store.get(id)).task;
        const outcome = await options.gitIntegration.verify(task, command);
        const expectedFingerprint = task.submission?.fingerprint ?? "";
        const result = await options.store.recordVerification(options.actor, id, {
          command,
          exitCode: outcome.exitCode,
          fingerprint: outcome.sourceDrifted ? expectedFingerprint : outcome.actualFingerprint,
          summary: outcome.sourceDrifted
            ? `source drift: ${outcome.output}`
            : outcome.output,
        });
        const toolResult = completedMutation(TASK_VERIFY, result);
        if (outcome.exitCode !== 0 || outcome.sourceDrifted) {
          return {
            ...toolResult,
            content: [
              formatMutation(result),
              `verification_failed: ${outcome.sourceDrifted ? "source drift" : "command failed"}`,
              outcome.output,
            ].join("\n"),
            status: "failed",
          };
        }
        return toolResult;
      });
    },
  };
}

function createIntegrateTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskIntegrateToolDefinition,
    async handler({ rawArguments }) {
      return handle(TASK_INTEGRATE, async () => {
        if (!options.gitIntegration) {
          throw invalidArguments("task_integrate requires Git integration");
        }
        const input = parseObject(rawArguments, TASK_INTEGRATE, ["id"]);
        const id = requiredString(input.id, `${TASK_INTEGRATE} id`);
        const task = (await options.store.get(id)).task;
        try {
          const receipt = await options.gitIntegration.integrate(task);
          return completedMutation(
            TASK_INTEGRATE,
            await options.store.recordIntegration(options.actor, id, receipt),
          );
        } catch (error) {
          if (error instanceof GitIntegrationError && error.code === "source_drift") {
            const reset = await options.store.recordVerification(options.actor, id, {
              command: task.verificationCommand as string,
              exitCode: 1,
              fingerprint: task.submission?.fingerprint as string,
              summary: error.message,
            });
            const result = completedMutation(TASK_INTEGRATE, reset);
            return {
              ...result,
              content: [
                `failed_reason: ${error.message}`,
                `reason_code: ${error.code}`,
                formatMutation(reset),
              ].join("\n"),
              metadata: {
                ...result.metadata,
                reasonCode: error.code,
              },
              status: "failed",
            };
          }
          if (error instanceof GitIntegrationError && error.code === "integration_conflict") {
            const blocked = await options.store.transition(options.actor, {
              action: "block",
              code: error.code,
              id,
              reason: [
                error.message,
                ...(error.sourceCommit ? [`source commit retained: ${error.sourceCommit}`] : []),
              ].join("; "),
            });
            return {
              ...completedMutation(TASK_INTEGRATE, blocked),
              content: [
                `failed_reason: ${error.message}`,
                `reason_code: ${error.code}`,
                ...(error.sourceCommit ? [`source_commit: ${error.sourceCommit}`] : []),
                formatMutation(blocked),
              ].join("\n"),
              status: "failed",
            };
          }
          throw error;
        }
      });
    },
  };
}

async function buildTransitionInput(
  options: TeamTaskToolRuntimeOptions,
  input: Record<string, unknown>,
): Promise<TeamTaskTransitionInput> {
  const action = requiredString(input.action, "task_transition action");
  const id = requiredString(input.id, "task_transition id");
  const leaderActions = new Set([
    "assign",
    "review_plan",
    "review_result",
    "submit_result",
    "submit_handoff",
    "transfer",
    "block",
  ]);
  const teammateActions = new Set([
    "claim",
    "submit_plan",
    "submit_result",
    "submit_handoff",
  ]);
  if (
    (options.actor.role === "leader" && !leaderActions.has(action))
    || (options.actor.role === "teammate" && !teammateActions.has(action))
    || options.actor.role === "child"
  ) {
    throw invalidArguments(`${options.actor.role} cannot perform task_transition ${action}`);
  }

  switch (action) {
    case "assign": {
      const assigneeName = requiredString(input.assignee, "task_transition assignee");
      const assignee = assigneeName === "leader"
        ? { role: "leader" as const }
        : await requireTeammates(options).resolveAssignee(assigneeName);
      return { action, assignee, id };
    }
    case "claim":
      return { action, id };
    case "submit_plan":
      return {
        action,
        id,
        steps: input.steps as string[],
        summary: requiredString(input.summary, "task_transition summary"),
      };
    case "review_plan": {
      if (input.decision !== "approve" && input.decision !== "reject") {
        throw invalidArguments("review_plan decision must be approve or reject");
      }
      return {
        action,
        decision: input.decision,
        id,
        reason: requiredString(input.reason, "task_transition reason"),
      };
    }
    case "submit_result": {
      const task = (await options.store.get(id)).task;
      const summary = requiredString(input.summary, "task_transition summary");
      if (task.kind === "research") {
        return { action, id, summary };
      }
      const source = await resolveEditSource(options, id, input.childSessionId);
      const snapshot = await requireGit(options).capture(source);
      return {
        action,
        changedFiles: snapshot.changedFiles,
        fingerprint: snapshot.fingerprint,
        id,
        source,
        summary,
      };
    }
    case "review_result": {
      if (input.decision !== "pass" && input.decision !== "reject") {
        throw invalidArguments("review_result decision must be pass or reject");
      }
      return {
        action,
        decision: input.decision,
        id,
        reason: requiredString(input.reason, "task_transition reason"),
      };
    }
    case "submit_handoff":
      return {
        action,
        id,
        ...(input.references === undefined
          ? {}
          : { references: input.references as AddTeamTaskEvidenceInput["references"] }),
        summary: requiredString(input.summary, "task_transition summary"),
      };
    case "transfer": {
      const assigneeName = requiredString(input.assignee, "task_transition assignee");
      if (assigneeName === "leader") {
        throw invalidArguments("transfer assignee must be a teammate");
      }
      const manager = requireTeammates(options);
      const current = (await options.store.get(id)).task.owner;
      if (current?.role === "teammate") {
        const source = (await manager.list()).find((member) => member.name === current.name);
        if (!source || source.state !== "idle") {
          throw invalidArguments(`current owner "${current.name}" must be idle before transfer`);
        }
      }
      return {
        action,
        assignee: await manager.resolveAssignee(assigneeName, true),
        id,
      };
    }
    case "block":
      return {
        action,
        code: requiredString(input.code, "task_transition blocker code"),
        id,
        reason: requiredString(input.reason, "task_transition blocker reason"),
      };
    default:
      throw invalidArguments(`unsupported task_transition action "${action}"`);
  }
}

async function resolveEditSource(
  options: TeamTaskToolRuntimeOptions,
  taskId: string,
  childSessionIdValue: unknown,
): Promise<TeamTaskResultSource> {
  if (options.actor.role === "teammate") {
    if (!options.ownWorkspace) {
      throw invalidArguments("teammate edit submission has no registered workspace");
    }
    return {
      kind: "teammate",
      name: options.actor.name,
      profile: options.actor.profile,
      sessionId: options.actor.sessionId,
      workspace: { ...options.ownWorkspace },
    };
  }
  if (options.actor.role === "leader") {
    const childSessionId = requiredString(childSessionIdValue, "task_transition childSessionId");
    if (!options.childSessions) {
      throw invalidArguments("Leader edit submission requires the root child-session registry");
    }
    try {
      return options.childSessions.resolveEditSource(childSessionId, taskId);
    } catch (error) {
      throw new TeamTaskStoreError("child_source_invalid", errorMessage(error), "healthy");
    }
  }
  throw invalidArguments("child sessions cannot submit task results");
}

function requireGit(options: TeamTaskToolRuntimeOptions): GitIntegrationService {
  if (!options.gitIntegration) {
    throw invalidArguments("edit task protocol requires Git integration");
  }
  return options.gitIntegration;
}

function requireTeammates(options: TeamTaskToolRuntimeOptions): TeammateManager {
  if (!options.teammates) {
    throw invalidArguments("task assignment or transfer requires the teammate registry");
  }
  return options.teammates;
}

function filterListActions(
  result: TeamTaskListResult,
  actor: TeamTaskActor,
): TeamTaskListResult {
  return {
    revision: result.revision,
    tasks: result.tasks.map((task) => ({
      ...task,
      availableActions: filterActions(task.availableActions, task, actor),
    })),
  };
}

function filterGetActions(
  result: TeamTaskGetResult,
  actor: TeamTaskActor,
): TeamTaskGetResult {
  const summary = {
    availableActions: result.availableActions,
    kind: result.task.kind,
    owner: result.task.owner,
    status: result.task.status,
  };
  return {
    ...result,
    availableActions: filterActions(result.availableActions, summary, actor),
  };
}

function filterActions(
  actions: TeamTaskAvailableAction[],
  task: {
    kind: TeamTask["kind"];
    owner?: TeamTask["owner"];
    status: TeamTask["status"];
  },
  actor: TeamTaskActor,
): TeamTaskAvailableAction[] {
  if (actor.role === "leader") {
    return actions.filter((action) =>
      [
        "assign",
        "update",
        "delete",
        "add_evidence",
        "review_plan",
        "review_result",
        "submit_result",
        "verify",
        "integrate",
        "submit_handoff",
        "transfer",
        "block",
      ].includes(action));
  }
  if (actor.role === "child") {
    return actor.delegatedTaskId
      ? actions.filter((action) => action === "add_evidence")
      : [];
  }
  const owns = task.owner?.role === "teammate" && task.owner.name === actor.name;
  return actions.filter((action) => {
    if (action === "claim") {
      return task.kind === actor.profile;
    }
    return owns && ["add_evidence", "submit_plan", "submit_result", "submit_handoff"].includes(action);
  });
}

async function handle(
  toolName: string,
  action: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof TeamTaskStoreError) {
      if (error.committedMutation) {
        return completedMutation(toolName, error.committedMutation, {
          graphHealth: "degraded",
          warningCode: "store_io",
          warningReason: COMMITTED_MUTATION_CLEANUP_WARNING,
        });
      }
      return failed(toolName, error.code, error.message, error.health);
    }
    if (error instanceof GitIntegrationError) {
      return failed(
        toolName,
        toTaskFailureCode(error.code),
        error.message,
        "healthy",
        error.sourceCommit,
      );
    }
    return failed(toolName, "invalid_input", errorMessage(error), "healthy");
  }
}

function completedRead(
  toolName: string,
  content: string,
  observationSummary: string,
  metadata: Record<string, unknown>,
): ToolResult {
  return {
    content,
    metadata: { observationSummary, ...metadata },
    status: "completed",
    toolName,
  };
}

function completedMutation(
  toolName: string,
  result: TeamTaskMutationResult,
  warning?: {
    graphHealth: "degraded";
    warningCode: "store_io";
    warningReason: string;
  },
): ToolResult {
  return {
    content: [
      formatMutation(result),
      ...(warning
        ? [
            `warning_reason: ${warning.warningReason}`,
            `warning_code: ${warning.warningCode}`,
            `graph_health: ${warning.graphHealth}`,
          ]
        : []),
    ].join("\n"),
    metadata: {
      observationSummary: `${mutationVerb(result.operation)} team task ${result.task.id} at revision ${result.revision}`,
      revision: result.revision,
      task: result.task,
      taskGraphMutation: {
        ...(result.nextStatus ? { nextStatus: result.nextStatus } : {}),
        operation: result.operation,
        ...(result.previousStatus ? { previousStatus: result.previousStatus } : {}),
        revision: result.revision,
        taskId: result.task.id,
      },
      ...(warning ?? {}),
    },
    status: "completed",
    toolName,
  };
}

function failed(
  toolName: string,
  code: ConstructorParameters<typeof TeamTaskStoreError>[0],
  message: string,
  health: "healthy" | "degraded",
  sourceCommit?: string,
): ToolResult {
  return {
    content: [
      `failed_reason: ${message}`,
      `reason_code: ${code}`,
      `graph_health: ${health}`,
      ...(sourceCommit ? [`source_commit: ${sourceCommit}`] : []),
    ].join("\n"),
    metadata: {
      graphHealth: health,
      observationSummary: `${toolName} failed: ${code}`,
      reasonCode: code,
      ...(sourceCommit ? { sourceCommit } : {}),
    },
    status: "failed",
    toolName,
  };
}

function formatList(result: TeamTaskListResult): string {
  if (result.tasks.length === 0) {
    return `revision: ${result.revision}\ntasks: (empty)`;
  }
  return [
    `revision: ${result.revision}`,
    "tasks:",
    ...result.tasks.map((task) =>
      [
        `- ${task.id}`,
        `kind=${task.kind}`,
        `status=${task.status}`,
        `owner=${formatOwner(task.owner)}`,
        `ready=${task.ready}`,
        `actions=${task.availableActions.join(",") || "(none)"}`,
        task.title,
      ].join(" | ")
    ),
  ].join("\n");
}

function formatGet(
  result: TeamTaskGetResult,
  review?: GitReviewPreview | { error: string },
): string {
  return [
    `revision: ${result.revision}`,
    `ready: ${result.ready}`,
    `available_actions: ${result.availableActions.join(",") || "(none)"}`,
    "task:",
    JSON.stringify(result.task, null, 2),
    ...(review
      ? [
          "review:",
          "error" in review
            ? `review_error: ${review.error}`
            : [
                `fingerprint_status: ${review.fingerprintStatus}`,
                `fingerprint: ${review.fingerprint}`,
                `changed_files: ${review.changedFiles.join(",")}`,
                "diff:",
                review.diff,
              ].join("\n"),
        ]
      : []),
  ].join("\n");
}

function formatMutation(result: TeamTaskMutationResult): string {
  return [
    `revision: ${result.revision}`,
    `operation: ${result.operation}`,
    ...(result.previousStatus ? [`previous_status: ${result.previousStatus}`] : []),
    ...(result.nextStatus ? [`next_status: ${result.nextStatus}`] : []),
    "task:",
    JSON.stringify(result.task, null, 2),
  ].join("\n");
}

function formatOwner(owner: TeamTask["owner"]): string {
  if (!owner) {
    return "(unowned)";
  }
  return owner.role === "leader" ? "leader" : `teammate:${owner.name}`;
}

function mutationVerb(operation: TeamTaskMutationResult["operation"]): string {
  switch (operation) {
    case "create":
      return "created";
    case "update":
      return "updated";
    case "add_evidence":
      return "added evidence to";
    case "delete":
      return "deleted";
    case "transition":
      return "transitioned";
    case "verify":
      return "verified";
    case "integrate":
      return "integrated";
  }
}

function parseObject(
  raw: string,
  toolName: string,
  allowedFields: string[],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidArguments(`${toolName} arguments must be a valid JSON object`);
  }
  if (!isRecord(parsed)) {
    throw invalidArguments(`${toolName} arguments must be a JSON object`);
  }
  const allowed = new Set(allowedFields);
  if (Object.keys(parsed).some((field) => !allowed.has(field))) {
    throw invalidArguments(`${toolName} arguments contain unsupported fields`);
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidArguments(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function invalidArguments(message: string): TeamTaskStoreError {
  return new TeamTaskStoreError("invalid_input", message, "healthy");
}

function toTaskFailureCode(
  code: GitIntegrationError["code"],
): ConstructorParameters<typeof TeamTaskStoreError>[0] {
  switch (code) {
    case "cherry_pick_in_progress":
    case "dirty_target":
    case "git_identity_missing":
    case "integration_conflict":
    case "source_drift":
      return code;
    case "unsupported_source":
    case "git_failure":
      return "invalid_input";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
