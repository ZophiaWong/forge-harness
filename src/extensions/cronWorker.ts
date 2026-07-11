import { cronMatchesDate, formatCronMinuteKey, parseCronExpression } from "../runtime/cron.js";
import type { CronSchedule, CronScheduleStore, CronRunStatus } from "../runtime/cronStore.js";
import type { TraceRecorder } from "../runtime/trace.js";

export interface ScheduledRunResult {
  error?: string;
  sessionId: string;
  status: CronRunStatus;
}

export type ScheduledTaskRunner = (task: CronSchedule) => Promise<ScheduledRunResult>;

export interface CronWorkerOptions {
  beforeRun?: (task: CronSchedule) => Promise<void> | void;
  cwd: string;
  now?: () => Date;
  onLog?: (message: string) => void;
  recorder?: TraceRecorder;
  runScheduledTask: ScheduledTaskRunner;
  store: CronScheduleStore;
}

export interface CronWorker {
  runForever(): Promise<void>;
  runOnce(): Promise<void>;
  stop(): void;
}

interface QueuedCronWork {
  cronId: string;
}

export function createCronWorker(options: CronWorkerOptions): CronWorker {
  const now = options.now ?? (() => new Date());
  const queue: QueuedCronWork[] = [];
  let stopped = false;

  const runTick = async (): Promise<void> => {
    const tickDate = now();
    const minuteKey = formatCronMinuteKey(tickDate);
    const tasks = await options.store.list();

    options.onLog?.(`[cron-worker] loaded ${tasks.length} schedule${tasks.length === 1 ? "" : "s"}`);

    for (const task of tasks) {
      if (task.status !== "active" || task.lastFiredMinute === minuteKey) {
        continue;
      }

      if (!cronMatchesDate(parseCronExpression(task.cron), tickDate)) {
        continue;
      }

      await options.store.markFired(task.id, minuteKey);
      queue.push({ cronId: task.id });
      options.onLog?.(`[cron-worker] fired ${task.id} ${task.title}`);
      await options.recorder?.record({
        cron: task.cron,
        cronId: task.id,
        minuteKey,
        title: task.title,
        type: "cron_fired",
      });
    }

    await drainQueue(options, queue);
  };

  return {
    async runForever() {
      await options.recorder?.record({
        cwd: options.cwd,
        mode: "watch",
        type: "cron_worker_started",
      });

      try {
        while (!stopped) {
          await runTick();
          await delay(1_000);
        }
      } finally {
        await options.recorder?.record({
          mode: "watch",
          type: "cron_worker_stopped",
        });
      }
    },
    async runOnce() {
      await options.recorder?.record({
        cwd: options.cwd,
        mode: "once",
        type: "cron_worker_started",
      });
      await runTick();
      await options.recorder?.record({
        mode: "once",
        type: "cron_worker_stopped",
      });
    },
    stop() {
      stopped = true;
    },
  };
}

async function drainQueue(options: CronWorkerOptions, queue: QueuedCronWork[]): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift()!;
    const task = await options.store.get(item.cronId);

    if (!task || task.status !== "active") {
      continue;
    }

    await options.beforeRun?.(task);

    const refreshedTask = await options.store.get(item.cronId);

    if (!refreshedTask || refreshedTask.status !== "active") {
      continue;
    }

    const result = await options.runScheduledTask(refreshedTask);
    await options.store.recordRunFinished(refreshedTask.id, result);
    options.onLog?.(`[cron-worker] session=${result.sessionId} status=${result.status}`);
    await options.recorder?.record({
      cronId: refreshedTask.id,
      error: result.error,
      sessionId: result.sessionId,
      status: result.status,
      title: refreshedTask.title,
      type: "cron_run_finished",
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
