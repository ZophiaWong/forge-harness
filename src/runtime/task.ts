export const MAX_TASK_TODO_ITEMS = 12;
export const MAX_TASK_ACCEPTANCE_CRITERIA = 8;

export type TaskTodoStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface TaskTodoItem {
  id: string;
  note?: string;
  status: TaskTodoStatus;
  title: string;
}

export interface TaskState {
  acceptance: string[];
  items: TaskTodoItem[];
  summary: string;
}

export interface RuntimeTaskState extends TaskState {
  updatedAtRound: number;
  updatedByCallId: string;
}

export interface TaskStateStore {
  getState(): TaskState | undefined;
  replaceState(state: TaskState): TaskState;
}

export type TaskStateValidationResult =
  | {
      state: TaskState;
      status: "valid";
    }
  | {
      reason: string;
      status: "invalid";
    };

const TASK_TODO_STATUSES = new Set<TaskTodoStatus>(["pending", "in_progress", "completed", "blocked"]);

export function createTaskStateStore(initialState?: TaskState): TaskStateStore {
  let currentState = initialState;

  return {
    getState() {
      return currentState;
    },
    replaceState(state) {
      currentState = cloneTaskState(state);
      return currentState;
    },
  };
}

export function validateTaskState(value: unknown): TaskStateValidationResult {
  if (!isRecord(value)) {
    return invalidTaskState("todo arguments must be JSON with summary, non-empty items, and non-empty acceptance fields");
  }

  const summary = readNonEmptyString(value.summary);
  if (!summary) {
    return invalidTaskState("todo summary must be a non-empty string");
  }

  if (!Array.isArray(value.items) || value.items.length === 0) {
    return invalidTaskState("todo items must be a non-empty array");
  }

  if (value.items.length > MAX_TASK_TODO_ITEMS) {
    return invalidTaskState(`todo snapshot can have at most ${MAX_TASK_TODO_ITEMS} items`);
  }

  if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) {
    return invalidTaskState("todo acceptance must be a non-empty array");
  }

  if (value.acceptance.length > MAX_TASK_ACCEPTANCE_CRITERIA) {
    return invalidTaskState(
      `todo snapshot can have at most ${MAX_TASK_ACCEPTANCE_CRITERIA} acceptance criteria`,
    );
  }

  const acceptance: string[] = [];
  for (const [index, criterion] of value.acceptance.entries()) {
    const normalizedCriterion = readNonEmptyString(criterion);
    if (!normalizedCriterion) {
      return invalidTaskState(`todo acceptance item ${index + 1} must be a non-empty string`);
    }
    acceptance.push(normalizedCriterion);
  }

  const items: TaskTodoItem[] = [];
  const ids = new Set<string>();
  let inProgressCount = 0;

  for (const [index, item] of value.items.entries()) {
    if (!isRecord(item)) {
      return invalidTaskState(`todo item ${index + 1} must be an object`);
    }

    const id = readNonEmptyString(item.id);
    if (!id) {
      return invalidTaskState(`todo item ${index + 1} must have a non-empty id`);
    }

    if (ids.has(id)) {
      return invalidTaskState(`duplicate todo id "${id}"`);
    }
    ids.add(id);

    const title = readNonEmptyString(item.title);
    if (!title) {
      return invalidTaskState(`todo item "${id}" must have a non-empty title`);
    }

    if (!isTaskTodoStatus(item.status)) {
      const status = typeof item.status === "string" ? item.status : String(item.status);
      return invalidTaskState(`todo item "${id}" has invalid status "${status}"`);
    }

    if (item.status === "in_progress") {
      inProgressCount += 1;
    }

    const note = item.note === undefined ? undefined : readString(item.note);
    if (item.note !== undefined && note === undefined) {
      return invalidTaskState(`todo item "${id}" note must be a string`);
    }

    items.push({
      id,
      ...(note && note.length > 0 ? { note } : {}),
      status: item.status,
      title,
    });
  }

  if (inProgressCount > 1) {
    return invalidTaskState("todo snapshot can have at most one in_progress item");
  }

  return {
    state: {
      acceptance,
      items,
      summary,
    },
    status: "valid",
  };
}

export function isTaskState(value: unknown): value is TaskState {
  return validateTaskState(value).status === "valid";
}

export function countTaskItems(state: TaskState): Record<TaskTodoStatus, number> {
  return state.items.reduce<Record<TaskTodoStatus, number>>(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    {
      blocked: 0,
      completed: 0,
      in_progress: 0,
      pending: 0,
    },
  );
}

function cloneTaskState(state: TaskState): TaskState {
  return {
    acceptance: [...state.acceptance],
    items: state.items.map((item) => ({ ...item })),
    summary: state.summary,
  };
}

function invalidTaskState(reason: string): TaskStateValidationResult {
  return {
    reason,
    status: "invalid",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskTodoStatus(value: unknown): value is TaskTodoStatus {
  return typeof value === "string" && TASK_TODO_STATUSES.has(value as TaskTodoStatus);
}

function readNonEmptyString(value: unknown): string | undefined {
  const normalized = readString(value)?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
