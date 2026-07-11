import fs from "node:fs/promises";
import path from "node:path";

import { parseCronExpression } from "./cron.js";

export type CronScheduleStatus = "active" | "canceled" | "completed" | "failed";
export type CronRunStatus = "completed" | "failed";

export interface CronSchedule {
  createdAt: string;
  cron: string;
  id: string;
  lastError?: string;
  lastFiredMinute?: string;
  lastRunStatus?: CronRunStatus;
  lastSessionId?: string;
  prompt: string;
  recurring: boolean;
  runCount: number;
  status: CronScheduleStatus;
  title: string;
  updatedAt: string;
}

export interface ScheduleCronInput {
  cron: string;
  prompt: string;
  recurring?: boolean;
  title: string;
}

export interface CronRunFinishedInput {
  error?: string;
  sessionId: string;
  status: CronRunStatus;
}

export interface CronScheduleStore {
  cancel(id: string): Promise<CronSchedule>;
  get(id: string): Promise<CronSchedule | undefined>;
  list(): Promise<CronSchedule[]>;
  markFired(id: string, minuteKey: string): Promise<CronSchedule>;
  recordRunFinished(id: string, input: CronRunFinishedInput): Promise<CronSchedule>;
  schedule(input: ScheduleCronInput): Promise<CronSchedule>;
}

export interface FileCronScheduleStoreOptions {
  cwd: string;
  now?: () => Date;
  storePath?: string;
}

interface CronScheduleFile {
  tasks: CronSchedule[];
}

export function createFileCronScheduleStore(options: FileCronScheduleStoreOptions): CronScheduleStore {
  const now = options.now ?? (() => new Date());
  const storePath = options.storePath ?? path.join(options.cwd, ".forge", "scheduled_tasks.json");

  const load = async (): Promise<CronScheduleFile> => {
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return parseScheduleFile(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { tasks: [] };
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read scheduled tasks: ${message}`);
    }
  };

  const save = async (file: CronScheduleFile): Promise<void> => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  };

  return {
    async cancel(id) {
      const file = await load();
      const task = findTask(file.tasks, id);
      const updated = {
        ...task,
        status: task.status === "active" ? "canceled" as const : task.status,
        updatedAt: now().toISOString(),
      };
      replaceTask(file.tasks, updated);
      await save(file);
      return cloneSchedule(updated);
    },
    async get(id) {
      const file = await load();
      const task = file.tasks.find((candidate) => candidate.id === id);
      return task ? cloneSchedule(task) : undefined;
    },
    async list() {
      const file = await load();
      return file.tasks.map(cloneSchedule);
    },
    async markFired(id, minuteKey) {
      const file = await load();
      const task = findTask(file.tasks, id);
      const updated = {
        ...task,
        lastFiredMinute: minuteKey,
        updatedAt: now().toISOString(),
      };
      replaceTask(file.tasks, updated);
      await save(file);
      return cloneSchedule(updated);
    },
    async recordRunFinished(id, input) {
      const file = await load();
      const task = findTask(file.tasks, id);
      const nextStatus = toNextScheduleStatus(task, input.status);
      const updated: CronSchedule = {
        ...task,
        ...(input.error ? { lastError: input.error } : withoutLastError()),
        lastRunStatus: input.status,
        lastSessionId: input.sessionId,
        runCount: task.runCount + 1,
        status: nextStatus,
        updatedAt: now().toISOString(),
      };
      replaceTask(file.tasks, updated);
      await save(file);
      return cloneSchedule(updated);
    },
    async schedule(input) {
      validateScheduleInput(input);
      const file = await load();
      const timestamp = now().toISOString();
      const task: CronSchedule = {
        createdAt: timestamp,
        cron: input.cron,
        id: nextCronId(file.tasks),
        prompt: input.prompt.trim(),
        recurring: input.recurring ?? true,
        runCount: 0,
        status: "active",
        title: input.title.trim(),
        updatedAt: timestamp,
      };
      file.tasks.push(task);
      await save(file);
      return cloneSchedule(task);
    },
  };
}

function validateScheduleInput(input: ScheduleCronInput): void {
  if (!input.title.trim()) {
    throw new Error("title must be a non-empty string");
  }

  if (!input.prompt.trim()) {
    throw new Error("prompt must be a non-empty string");
  }

  parseCronExpression(input.cron);
}

function parseScheduleFile(value: unknown): CronScheduleFile {
  if (typeof value !== "object" || value === null || !("tasks" in value) || !Array.isArray(value.tasks)) {
    throw new Error("scheduled tasks file must contain a tasks array");
  }

  return {
    tasks: value.tasks.map(parseSchedule),
  };
}

function parseSchedule(value: unknown): CronSchedule {
  if (typeof value !== "object" || value === null) {
    throw new Error("scheduled task must be an object");
  }

  const task = value as Record<string, unknown>;
  const requiredStrings = ["createdAt", "cron", "id", "prompt", "status", "title", "updatedAt"];

  for (const key of requiredStrings) {
    if (typeof task[key] !== "string") {
      throw new Error(`scheduled task field ${key} must be a string`);
    }
  }

  if (typeof task.recurring !== "boolean") {
    throw new Error("scheduled task field recurring must be a boolean");
  }

  if (typeof task.runCount !== "number") {
    throw new Error("scheduled task field runCount must be a number");
  }

  if (!isScheduleStatus(task.status)) {
    throw new Error("scheduled task status is invalid");
  }

  return {
    createdAt: task.createdAt as string,
    cron: task.cron as string,
    id: task.id as string,
    ...(typeof task.lastError === "string" ? { lastError: task.lastError } : {}),
    ...(typeof task.lastFiredMinute === "string" ? { lastFiredMinute: task.lastFiredMinute } : {}),
    ...(isRunStatus(task.lastRunStatus) ? { lastRunStatus: task.lastRunStatus } : {}),
    ...(typeof task.lastSessionId === "string" ? { lastSessionId: task.lastSessionId } : {}),
    prompt: task.prompt as string,
    recurring: task.recurring,
    runCount: task.runCount,
    status: task.status,
    title: task.title as string,
    updatedAt: task.updatedAt as string,
  };
}

function nextCronId(tasks: CronSchedule[]): string {
  const max = tasks.reduce((currentMax, task) => {
    const match = /^cron_(\d+)$/.exec(task.id);
    return match ? Math.max(currentMax, Number(match[1])) : currentMax;
  }, 0);

  return `cron_${String(max + 1).padStart(3, "0")}`;
}

function findTask(tasks: CronSchedule[], id: string): CronSchedule {
  const task = tasks.find((candidate) => candidate.id === id);

  if (!task) {
    throw new Error(`cron schedule "${id}" was not found`);
  }

  return task;
}

function replaceTask(tasks: CronSchedule[], task: CronSchedule): void {
  const index = tasks.findIndex((candidate) => candidate.id === task.id);

  if (index === -1) {
    tasks.push(task);
    return;
  }

  tasks[index] = task;
}

function toNextScheduleStatus(task: CronSchedule, runStatus: CronRunStatus): CronScheduleStatus {
  if (task.status !== "active") {
    return task.status;
  }

  if (task.recurring) {
    return "active";
  }

  return runStatus === "completed" ? "completed" : "failed";
}

function cloneSchedule(task: CronSchedule): CronSchedule {
  return { ...task };
}

function isScheduleStatus(value: unknown): value is CronScheduleStatus {
  return value === "active" || value === "canceled" || value === "completed" || value === "failed";
}

function isRunStatus(value: unknown): value is CronRunStatus {
  return value === "completed" || value === "failed";
}

function withoutLastError(): { lastError?: never } {
  return {};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
