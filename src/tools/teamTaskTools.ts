import {
  TeamTaskStoreError,
  type AddTeamTaskEvidenceInput,
  type CreateTeamTaskInput,
  type TeamTask,
  type TeamTaskActor,
  type TeamTaskGetResult,
  type TeamTaskListResult,
  type TeamTaskMutationResult,
  type UpdateTeamTaskPatch,
} from "../domain/teamTask.js";
import type { TeamTaskStore } from "../runtime/teamTaskStore.js";
import { createToolRuntime } from "./runtime.js";
import type {
  RegisteredTool,
  ToolDefinition,
  ToolResult,
  ToolRuntime,
} from "./types.js";

const TASK_LIST_TOOL_NAME = "task_list";
const TASK_GET_TOOL_NAME = "task_get";
const TASK_CREATE_TOOL_NAME = "task_create";
const TASK_UPDATE_TOOL_NAME = "task_update";
const TASK_ADD_EVIDENCE_TOOL_NAME = "task_add_evidence";
const COMMITTED_MUTATION_CLEANUP_WARNING =
  "task graph mutation committed but lock cleanup failed";

const taskIdProperty = {
  description: "Team task id, such as task_001.",
  type: "string",
};

const stringArrayProperty = {
  items: {
    type: "string",
  },
  type: "array",
};

const evidenceReferencesProperty = {
  items: {
    additionalProperties: false,
    properties: {
      kind: {
        enum: ["artifact", "trace", "external"],
        type: "string",
      },
      value: {
        type: "string",
      },
    },
    required: ["kind", "value"],
    type: "object",
  },
  type: "array",
};

export const taskListToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_LIST_TOOL_NAME,
  description: "List the root session's shared team tasks and their derived readiness.",
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
  name: TASK_GET_TOOL_NAME,
  description: "Get the full contract, evidence, and provenance for one shared team task.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: taskIdProperty,
    },
    required: ["id"],
  },
};

export const taskCreateToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_CREATE_TOOL_NAME,
  description: "Create one pending shared team task. Available only to the Leader.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      acceptance: {
        ...stringArrayProperty,
        description: "Observable criteria required before the task can be completed.",
      },
      dependencies: {
        ...stringArrayProperty,
        description: "Task ids that must be completed before this task is ready.",
      },
      description: {
        description: "Detailed task contract.",
        type: "string",
      },
      title: {
        description: "Short task title.",
        type: "string",
      },
    },
    required: ["title", "description", "acceptance"],
  },
};

export const taskUpdateToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_UPDATE_TOOL_NAME,
  description: "Update or delete one shared team task. Available only to the Leader.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      acceptance: {
        ...stringArrayProperty,
        description: "Replacement acceptance criteria.",
      },
      blockedReason: {
        description: "Required reason when moving a task to blocked.",
        type: "string",
      },
      delete: {
        description: "Delete the task; mutually exclusive with every update field.",
        type: "boolean",
      },
      dependencies: {
        ...stringArrayProperty,
        description: "Replacement dependency task ids.",
      },
      description: {
        description: "Replacement task description.",
        type: "string",
      },
      id: taskIdProperty,
      status: {
        description: "Replacement task status.",
        enum: ["pending", "in_progress", "blocked", "completed"],
        type: "string",
      },
      title: {
        description: "Replacement task title.",
        type: "string",
      },
    },
    required: ["id"],
  },
};

export const taskAddEvidenceToolDefinition: ToolDefinition = {
  type: "function",
  name: TASK_ADD_EVIDENCE_TOOL_NAME,
  description: "Append evidence to an in-progress shared team task.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: taskIdProperty,
      references: {
        ...evidenceReferencesProperty,
        description: "Optional artifact, trace, or external references supporting the evidence.",
      },
      summary: {
        description: "Short evidence summary.",
        type: "string",
      },
    },
    required: ["id", "summary"],
  },
};

export interface TeamTaskToolRuntimeOptions {
  actor: TeamTaskActor;
  store: TeamTaskStore;
}

export function createTeamTaskTools(options: TeamTaskToolRuntimeOptions): RegisteredTool[] {
  const inspectTools = [
    createTaskListTool(options.store),
    createTaskGetTool(options.store),
  ];

  if (options.actor.role === "leader") {
    return [
      ...inspectTools,
      createTaskCreateTool(options),
      createTaskUpdateTool(options),
      createTaskAddEvidenceTool(options),
    ];
  }

  return options.actor.delegatedTaskId
    ? [...inspectTools, createTaskAddEvidenceTool(options)]
    : inspectTools;
}

export function createTeamTaskToolRuntime(options: TeamTaskToolRuntimeOptions): ToolRuntime {
  return createToolRuntime(createTeamTaskTools(options));
}

function createTaskListTool(store: TeamTaskStore): RegisteredTool {
  return {
    definition: taskListToolDefinition,
    async handler({ rawArguments }) {
      return handleToolCall(TASK_LIST_TOOL_NAME, async () => {
        parseObjectArguments(rawArguments, TASK_LIST_TOOL_NAME, []);
        const result = await store.list();
        return {
          content: formatTaskList(result),
          metadata: {
            observationSummary: `listed ${result.tasks.length} team task${result.tasks.length === 1 ? "" : "s"} at revision ${result.revision}`,
            revision: result.revision,
            tasks: result.tasks,
          },
          status: "completed",
          toolName: TASK_LIST_TOOL_NAME,
        };
      });
    },
  };
}

function createTaskGetTool(store: TeamTaskStore): RegisteredTool {
  return {
    definition: taskGetToolDefinition,
    async handler({ rawArguments }) {
      return handleToolCall(TASK_GET_TOOL_NAME, async () => {
        const input = parseObjectArguments(rawArguments, TASK_GET_TOOL_NAME, ["id"]);
        const result = await store.get(readStringArgument(input, "id", TASK_GET_TOOL_NAME));
        return {
          content: formatTaskGet(result),
          metadata: {
            observationSummary: `read team task ${result.task.id} at revision ${result.revision}`,
            ready: result.ready,
            revision: result.revision,
            task: result.task,
          },
          status: "completed",
          toolName: TASK_GET_TOOL_NAME,
        };
      });
    },
  };
}

function createTaskCreateTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskCreateToolDefinition,
    async handler({ rawArguments }) {
      return handleToolCall(TASK_CREATE_TOOL_NAME, async () => {
        const input = parseObjectArguments(rawArguments, TASK_CREATE_TOOL_NAME, [
          "acceptance",
          "dependencies",
          "description",
          "title",
        ]);
        const result = await options.store.create(
          options.actor,
          input as unknown as CreateTeamTaskInput,
        );
        return completedMutationResult(TASK_CREATE_TOOL_NAME, result);
      });
    },
  };
}

function createTaskUpdateTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskUpdateToolDefinition,
    async handler({ rawArguments }) {
      return handleToolCall(TASK_UPDATE_TOOL_NAME, async () => {
        const input = parseObjectArguments(rawArguments, TASK_UPDATE_TOOL_NAME, [
          "acceptance",
          "blockedReason",
          "delete",
          "dependencies",
          "description",
          "id",
          "status",
          "title",
        ]);
        const id = readStringArgument(input, "id", TASK_UPDATE_TOOL_NAME);
        const { delete: shouldDelete, id: _id, ...patch } = input;

        if (shouldDelete !== undefined && typeof shouldDelete !== "boolean") {
          throw invalidArguments("task_update delete must be a boolean");
        }
        if (shouldDelete === true && Object.keys(patch).length > 0) {
          throw invalidArguments(
            "task_update delete: true is mutually exclusive with every patch field",
          );
        }

        const result = shouldDelete === true
          ? await options.store.delete(options.actor, id)
          : await options.store.update(
            options.actor,
            id,
            patch as unknown as UpdateTeamTaskPatch,
          );
        return completedMutationResult(TASK_UPDATE_TOOL_NAME, result);
      });
    },
  };
}

function createTaskAddEvidenceTool(options: TeamTaskToolRuntimeOptions): RegisteredTool {
  return {
    definition: taskAddEvidenceToolDefinition,
    async handler({ callId, rawArguments, round }) {
      return handleToolCall(TASK_ADD_EVIDENCE_TOOL_NAME, async () => {
        const input = parseObjectArguments(rawArguments, TASK_ADD_EVIDENCE_TOOL_NAME, [
          "id",
          "references",
          "summary",
        ]);
        const id = readStringArgument(input, "id", TASK_ADD_EVIDENCE_TOOL_NAME);
        const result = await options.store.addEvidence(options.actor, id, {
          callId: callId ?? "",
          ...(Object.prototype.hasOwnProperty.call(input, "references")
            ? {
                references: input.references as AddTeamTaskEvidenceInput["references"],
              }
            : {}),
          round: round ?? 0,
          summary: input.summary as string,
        });
        return completedMutationResult(TASK_ADD_EVIDENCE_TOOL_NAME, result);
      });
    },
  };
}

async function handleToolCall(
  toolName: string,
  action: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof TeamTaskStoreError) {
      if (error.committedMutation) {
        return completedMutationResult(toolName, error.committedMutation, {
          graphHealth: "degraded",
          warningCode: "store_io",
          warningReason: COMMITTED_MUTATION_CLEANUP_WARNING,
        });
      }
      return failedToolResult(toolName, error);
    }

    return failedToolResult(
      toolName,
      new TeamTaskStoreError(
        "store_io",
        `unexpected team task tool failure: ${errorMessage(error)}`,
        "degraded",
      ),
    );
  }
}

function failedToolResult(toolName: string, error: TeamTaskStoreError): ToolResult {
  return {
    content: [
      `failed_reason: ${error.message}`,
      `reason_code: ${error.code}`,
      `graph_health: ${error.health}`,
    ].join("\n"),
    metadata: {
      graphHealth: error.health,
      observationSummary: `${toolName} failed: ${error.code}`,
      reasonCode: error.code,
    },
    status: "failed",
    toolName,
  };
}

function parseObjectArguments(
  rawArguments: string,
  toolName: string,
  allowedFields: string[],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
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

function readStringArgument(
  input: Record<string, unknown>,
  field: string,
  toolName: string,
): string {
  if (typeof input[field] !== "string") {
    throw invalidArguments(`${toolName} ${field} must be a string`);
  }
  return input[field];
}

function invalidArguments(message: string): TeamTaskStoreError {
  return new TeamTaskStoreError("invalid_input", message, "healthy");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completedMutationResult(
  toolName: string,
  result: TeamTaskMutationResult,
  warning?: {
    graphHealth: "degraded";
    warningCode: "store_io";
    warningReason: string;
  },
) {
  const operation = mutationObservationVerb(result.operation);
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
      observationSummary: `${operation} team task ${result.task.id} at revision ${result.revision}`,
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
    status: "completed" as const,
    toolName,
  };
}

function mutationObservationVerb(operation: TeamTaskMutationResult["operation"]): string {
  switch (operation) {
    case "create":
      return "created";
    case "update":
      return "updated";
    case "add_evidence":
      return "added evidence to";
    case "delete":
      return "deleted";
  }
}

function formatMutation(result: TeamTaskMutationResult): string {
  return [
    `revision: ${result.revision}`,
    `operation: ${result.operation}`,
    ...(result.previousStatus ? [`previous_status: ${result.previousStatus}`] : []),
    ...(result.nextStatus ? [`next_status: ${result.nextStatus}`] : []),
    "task:",
    ...formatTask(result.task),
  ].join("\n");
}

function formatTaskList(result: TeamTaskListResult): string {
  if (result.tasks.length === 0) {
    return `revision: ${result.revision}\ntasks: (empty)`;
  }

  return [
    `revision: ${result.revision}`,
    "tasks:",
    ...result.tasks.map((task) => [
      `- ${task.id}`,
      `status=${task.status}`,
      `ready=${task.ready}`,
      `dependencies=${task.dependencies.length > 0 ? task.dependencies.join(",") : "(none)"}`,
      `evidence=${task.evidenceCount}`,
      task.title,
    ].join(" | ")),
  ].join("\n");
}

function formatTaskGet(result: TeamTaskGetResult): string {
  return [
    `revision: ${result.revision}`,
    "task:",
    ...formatTask(result.task, result.ready),
  ].join("\n");
}

function formatTask(task: TeamTask, ready?: boolean): string[] {
  const lines = [
    `id: ${task.id}`,
    `title: ${task.title}`,
    `description: ${task.description}`,
    `status: ${task.status}`,
    ...(ready === undefined ? [] : [`ready: ${ready}`]),
    ...(task.blockedReason ? [`blocked_reason: ${task.blockedReason}`] : []),
    `created_at: ${task.createdAt}`,
    `updated_at: ${task.updatedAt}`,
    ...(task.dependencies.length === 0
      ? ["dependencies: (none)"]
      : ["dependencies:", ...task.dependencies.map((dependency) => `- ${dependency}`)]),
    "acceptance:",
    ...task.acceptance.map((criterion) => `- ${criterion}`),
  ];

  if (task.evidence.length === 0) {
    lines.push("evidence: (none)");
    return lines;
  }

  lines.push("evidence:");
  for (const evidence of task.evidence) {
    lines.push(`- summary: ${evidence.summary}`);
    lines.push(`  reported_by_role: ${evidence.reportedByRole}`);
    lines.push(`  reported_by_session_id: ${evidence.reportedBySessionId}`);
    lines.push(`  call_id: ${evidence.callId}`);
    lines.push(`  round: ${evidence.round}`);
    lines.push(`  reported_at: ${evidence.reportedAt}`);
    if (evidence.references) {
      lines.push("  references:");
      lines.push(...evidence.references.map((reference) => `  - ${reference.kind}: ${reference.value}`));
    }
  }

  return lines;
}
