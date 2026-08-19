import {
  countTaskItems,
  createTaskStateStore,
  type TaskState,
  type TaskStateStore,
  validateTaskState,
} from "../runtime/task.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

const TODO_TOOL_NAME = "todo";

export const todoToolDefinition: ToolDefinition = {
  type: "function",
  name: TODO_TOOL_NAME,
  description: [
    "Replace the current session-local todo snapshot for multi-step work.",
    "Each call must submit the full current snapshot and preserve existing item ids.",
    "Update item statuses as soon as direct evidence changes the work state.",
    "Before a candidate final answer, if a snapshot already exists, reconcile every item",
    "and call todo when the snapshot has changed.",
    "Do not create a todo only for this final check.",
    "Todo does not determine Runtime or TaskGraph completion.",
  ].join(" "),
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      acceptance: {
        type: "array",
        description: "Observable acceptance criteria for the task. These are not verifier results.",
        items: {
          type: "string",
        },
      },
      items: {
        type: "array",
        description: [
          "Complete replacement snapshot. Preserve existing items and stable ids.",
          "Do not omit an item to hide unfinished work or reduce the open count;",
          "remove one only when the task scope has genuinely changed.",
        ].join(" "),
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              description: "Stable todo id reused across later snapshots.",
            },
            note: {
              type: "string",
              description: "Optional short factual note recording direct evidence, current progress, or a blocker.",
            },
            status: {
              type: "string",
              description: [
                "pending means not started; in_progress means currently active;",
                "completed requires direct evidence that the item is done;",
                "blocked means an unresolved blocker prevents progress.",
                "At most one item may be in_progress.",
              ].join(" "),
              enum: ["pending", "in_progress", "completed", "blocked"],
            },
            title: {
              type: "string",
              description: "Short todo title.",
            },
          },
          required: ["id", "title", "status"],
        },
      },
      summary: {
        type: "string",
        description: "Short current progress summary.",
      },
    },
    required: ["summary", "items", "acceptance"],
  },
};

export function createTodoTool(store: TaskStateStore = createTaskStateStore()): RegisteredTool {
  return {
    definition: todoToolDefinition,
    async handler({ rawArguments }) {
      const parsed = parseTodoArguments(rawArguments);

      if (!parsed) {
        return failedTodoResult(
          "todo arguments must be JSON with summary, non-empty items, and non-empty acceptance fields",
        );
      }

      const validation = validateTaskState(parsed);

      if (validation.status === "invalid") {
        return failedTodoResult(validation.reason);
      }

      const taskState = store.replaceState(validation.state);

      return completedTodoResult(taskState);
    },
  };
}

function parseTodoArguments(rawArguments: string): unknown | undefined {
  try {
    return JSON.parse(rawArguments) as unknown;
  } catch {
    return undefined;
  }
}

function completedTodoResult(taskState: TaskState): ToolResult {
  return {
    content: formatTaskState(taskState),
    metadata: {
      observationSummary: formatTaskObservationSummary(taskState),
      taskState,
    },
    status: "completed",
    toolName: TODO_TOOL_NAME,
  };
}

function failedTodoResult(reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    metadata: {
      observationSummary: "todo failed",
    },
    status: "failed",
    toolName: TODO_TOOL_NAME,
  };
}

function formatTaskState(taskState: TaskState): string {
  const lines = [`summary: ${taskState.summary}`, "todos:"];

  for (const item of taskState.items) {
    lines.push(`- ${item.status} ${item.id}: ${item.title}`);

    if (item.note) {
      lines.push(`  note: ${item.note}`);
    }
  }

  lines.push("acceptance:");
  lines.push(...taskState.acceptance.map((criterion) => `- ${criterion}`));

  return lines.join("\n");
}

function formatTaskObservationSummary(taskState: TaskState): string {
  const counts = countTaskItems(taskState);

  return [
    `task plan updated: ${taskState.items.length} ${taskState.items.length === 1 ? "item" : "items"}`,
    `${counts.in_progress} in_progress`,
    `${counts.completed} completed`,
    `${counts.blocked} blocked`,
  ].join(", ");
}
