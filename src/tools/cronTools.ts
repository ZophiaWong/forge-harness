import type { CronSchedule, CronScheduleStore, ScheduleCronInput } from "../runtime/cronStore.js";
import type { RegisteredTool, ToolDefinition, ToolResult } from "./types.js";

const SCHEDULE_CRON_TOOL_NAME = "schedule_cron";
const LIST_CRONS_TOOL_NAME = "list_crons";
const CANCEL_CRON_TOOL_NAME = "cancel_cron";

export function createCronTools(store: CronScheduleStore): RegisteredTool[] {
  return [
    createScheduleCronTool(store),
    createListCronsTool(store),
    createCancelCronTool(store),
  ];
}

function createScheduleCronTool(store: CronScheduleStore): RegisteredTool {
  return {
    definition: {
      type: "function",
      name: SCHEDULE_CRON_TOOL_NAME,
      description: "Create a durable local cron schedule that a cron worker can run later.",
      strict: false,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            description: "Short human-readable schedule name.",
          },
          cron: {
            type: "string",
            description: "Five-field local-time cron expression.",
          },
          prompt: {
            type: "string",
            description: "Task prompt for the scheduled agent run.",
          },
          recurring: {
            type: "boolean",
            description: "Set false to run only on the next matching cron minute.",
          },
        },
        required: ["title", "cron", "prompt"],
      },
    },
    async handler({ rawArguments }) {
      const input = parseScheduleCronArguments(rawArguments);

      if (!input) {
        return failed(SCHEDULE_CRON_TOOL_NAME, "schedule_cron arguments must include non-empty title, cron, and prompt strings");
      }

      try {
        const task = await store.schedule(input);
        return {
          content: formatScheduledResult(task),
          metadata: {
            cronSchedule: task,
            observationSummary: "cron scheduled",
          },
          status: "completed",
          toolName: SCHEDULE_CRON_TOOL_NAME,
        };
      } catch (error) {
        return failed(SCHEDULE_CRON_TOOL_NAME, errorMessage(error));
      }
    },
  };
}

function createListCronsTool(store: CronScheduleStore): RegisteredTool {
  return {
    definition: {
      type: "function",
      name: LIST_CRONS_TOOL_NAME,
      description: "List durable local cron schedules.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
    },
    async handler() {
      try {
        const tasks = await store.list();
        return {
          content: formatListResult(tasks),
          metadata: {
            observationSummary: `listed ${tasks.length} cron schedule${tasks.length === 1 ? "" : "s"}`,
          },
          status: "completed",
          toolName: LIST_CRONS_TOOL_NAME,
        };
      } catch (error) {
        return failed(LIST_CRONS_TOOL_NAME, errorMessage(error));
      }
    },
  };
}

function createCancelCronTool(store: CronScheduleStore): RegisteredTool {
  return {
    definition: {
      type: "function",
      name: CANCEL_CRON_TOOL_NAME,
      description: "Cancel future triggers for a durable local cron schedule.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            description: "Cron schedule id, such as cron_001.",
          },
        },
        required: ["id"],
      },
    },
    async handler({ rawArguments }) {
      const id = parseCancelCronArguments(rawArguments);

      if (!id) {
        return failed(CANCEL_CRON_TOOL_NAME, "cancel_cron arguments must include a non-empty id string");
      }

      try {
        const task = await store.cancel(id);
        return {
          content: formatCanceledResult(task),
          metadata: {
            cronSchedule: task,
            observationSummary: "cron canceled",
          },
          status: "completed",
          toolName: CANCEL_CRON_TOOL_NAME,
        };
      } catch (error) {
        return failed(CANCEL_CRON_TOOL_NAME, errorMessage(error));
      }
    },
  };
}

function parseScheduleCronArguments(rawArguments: string): ScheduleCronInput | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "title" in parsed &&
      typeof parsed.title === "string" &&
      parsed.title.trim().length > 0 &&
      "cron" in parsed &&
      typeof parsed.cron === "string" &&
      parsed.cron.trim().length > 0 &&
      "prompt" in parsed &&
      typeof parsed.prompt === "string" &&
      parsed.prompt.trim().length > 0
    ) {
      return {
        cron: parsed.cron,
        prompt: parsed.prompt,
        recurring: "recurring" in parsed && parsed.recurring === false ? false : true,
        title: parsed.title,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseCancelCronArguments(rawArguments: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof parsed.id === "string" &&
      parsed.id.trim().length > 0
    ) {
      return parsed.id;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function formatScheduledResult(task: CronSchedule): string {
  return [
    "status: scheduled",
    `cron_id: ${task.id}`,
    `title: ${task.title}`,
    `cron: ${task.cron}`,
    `recurring: ${task.recurring}`,
  ].join("\n");
}

function formatListResult(tasks: CronSchedule[]): string {
  if (tasks.length === 0) {
    return "cron_schedules: (empty)";
  }

  return [
    "cron_schedules:",
    ...tasks.map((task) => {
      const cadence = task.recurring ? "recurring" : "once";
      const lastSession = task.lastSessionId ? ` last_session=${task.lastSessionId}` : "";
      return `- ${task.id} ${task.status} ${cadence} ${task.cron} ${task.title}${lastSession}`;
    }),
  ].join("\n");
}

function formatCanceledResult(task: CronSchedule): string {
  return [
    "status: canceled",
    `cron_id: ${task.id}`,
    `title: ${task.title}`,
  ].join("\n");
}

function failed(toolName: string, reason: string): ToolResult {
  return {
    content: `failed_reason: ${reason}`,
    status: "failed",
    toolName,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
