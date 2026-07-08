import {
  startBashCommand,
  type BashCommandHandle,
  type BashExecutionOptions,
  type BashExecutionResult,
} from "../tools/bashTool.js";

export type BackgroundTaskKind = "bash";
export type BackgroundTaskStatus = "running" | "completed" | "timed_out" | "failed" | "canceled";

export interface BackgroundTaskStart {
  command: string;
  id: string;
  kind: BackgroundTaskKind;
}

export interface BackgroundTaskNotification {
  command: string;
  durationMs: number | null;
  error?: string;
  exitCode: number | null;
  id: string;
  kind: BackgroundTaskKind;
  status: BackgroundTaskStatus;
  stderr: string;
  stdout: string;
}

export interface BackgroundTaskManager {
  cancelRunning(): Promise<void>;
  drainNotifications(): BackgroundTaskNotification[];
  drainRunningNotifications(): BackgroundTaskNotification[];
  flushEvents(): Promise<void>;
  startBash(input: StartBackgroundBashInput): BackgroundTaskStart;
}

export interface StartBackgroundBashInput {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export type BackgroundTaskExecutor = (command: string, options: BashExecutionOptions) => BashCommandHandle;

export interface BackgroundTaskManagerOptions {
  executor?: BackgroundTaskExecutor;
  onTaskFinished?: (task: BackgroundTaskNotification) => Promise<void> | void;
}

interface ManagedBackgroundTask {
  command: string;
  error?: string;
  handle: BashCommandHandle;
  id: string;
  kind: BackgroundTaskKind;
  order: number;
  result?: BashExecutionResult;
  runningNotified: boolean;
  settled: Promise<void>;
  status: BackgroundTaskStatus;
  terminalNotified: boolean;
}

export function createBackgroundTaskManager(options: BackgroundTaskManagerOptions = {}): BackgroundTaskManager {
  const executor = options.executor ?? startBashCommand;
  const tasks: ManagedBackgroundTask[] = [];
  const pendingEvents = new Set<Promise<void>>();
  let nextTaskNumber = 1;

  const notifyTaskFinished = (task: ManagedBackgroundTask): void => {
    if (!options.onTaskFinished) {
      return;
    }

    const eventPromise = Promise.resolve(options.onTaskFinished(toNotification(task)))
      .catch(() => undefined)
      .then(() => undefined);
    pendingEvents.add(eventPromise);
    void eventPromise.finally(() => {
      pendingEvents.delete(eventPromise);
    });
  };

  return {
    async cancelRunning() {
      const running = tasks.filter((task) => task.status === "running");

      for (const task of running) {
        task.handle.cancel();
      }

      await Promise.all(running.map((task) => task.settled));
    },
    drainNotifications() {
      return tasks
        .filter((task) => isModelNotifiableTerminalStatus(task.status) && !task.terminalNotified)
        .sort((left, right) => left.order - right.order)
        .map((task) => {
          task.terminalNotified = true;
          return toNotification(task);
        });
    },
    drainRunningNotifications() {
      return tasks
        .filter((task) => task.status === "running" && !task.runningNotified)
        .sort((left, right) => left.order - right.order)
        .map((task) => {
          task.runningNotified = true;
          return toNotification(task);
        });
    },
    async flushEvents() {
      while (pendingEvents.size > 0) {
        await Promise.all([...pendingEvents]);
      }
    },
    startBash(input) {
      const id = `bg_${String(nextTaskNumber).padStart(3, "0")}`;
      const order = nextTaskNumber;
      nextTaskNumber += 1;
      const handle = executor(input.command, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
      const task: ManagedBackgroundTask = {
        command: input.command,
        handle,
        id,
        kind: "bash",
        order,
        runningNotified: false,
        settled: Promise.resolve(),
        status: "running",
        terminalNotified: false,
      };
      task.settled = handle.promise
        .then((result) => {
          task.result = result;
          task.status = toBackgroundTaskStatus(result.status);
          notifyTaskFinished(task);
        })
        .catch((error) => {
          task.error = error instanceof Error ? error.message : String(error);
          task.status = "failed";
          notifyTaskFinished(task);
        });

      tasks.push(task);

      return {
        command: task.command,
        id: task.id,
        kind: task.kind,
      };
    },
  };
}

export function formatBackgroundTaskNotification(notification: BackgroundTaskNotification): string {
  return [
    "<task_notification>",
    `background_task_id: ${notification.id}`,
    `kind: ${notification.kind}`,
    `status: ${notification.status}`,
    `command: ${notification.command}`,
    `exit_code: ${notification.exitCode === null ? "null" : notification.exitCode}`,
    `duration_ms: ${notification.durationMs === null ? "null" : notification.durationMs}`,
    "stdout:",
    notification.stdout || "(empty)",
    "stderr:",
    notification.stderr || "(empty)",
    ...(notification.error ? ["error:", notification.error] : []),
    "</task_notification>",
  ].join("\n");
}

function toNotification(task: ManagedBackgroundTask): BackgroundTaskNotification {
  return {
    command: task.command,
    durationMs: task.result?.durationMs ?? null,
    ...(task.error ? { error: task.error } : {}),
    exitCode: task.result?.exitCode ?? null,
    id: task.id,
    kind: task.kind,
    status: task.status,
    stderr: task.result?.stderr ?? "",
    stdout: task.result?.stdout ?? "",
  };
}

function toBackgroundTaskStatus(status: BashExecutionResult["status"]): BackgroundTaskStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "timed_out":
      return "timed_out";
    case "canceled":
      return "canceled";
    case "blocked":
      return "failed";
  }
}

function isModelNotifiableTerminalStatus(status: BackgroundTaskStatus): boolean {
  return status === "completed" || status === "timed_out" || status === "failed";
}
