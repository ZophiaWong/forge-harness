import { createBashTool } from "./bashTool.js";
import { createDelegateTool, type DelegateChildSessionRunner } from "./delegateTool.js";
import { createEditTool } from "./editTool.js";
import { createFindTool } from "./findTool.js";
import { createGrepTool } from "./grepTool.js";
import { createLsTool } from "./lsTool.js";
import { createReadTool } from "./readTool.js";
import { createToolRuntime } from "./runtime.js";
import { createTodoTool } from "./todoTool.js";
import { createCronTools } from "./cronTools.js";
import type { ToolRuntime } from "./types.js";
import { createWriteTool } from "./writeTool.js";
import type { BackgroundTaskManager } from "../runtime/backgroundTasks.js";
import type { CronScheduleStore } from "../runtime/cronStore.js";

export interface DefaultToolRuntimeOptions {
  backgroundTasks?: BackgroundTaskManager;
  childSessionRunner?: DelegateChildSessionRunner;
  cronSchedules?: CronScheduleStore;
  cwd: string;
  maxToolRounds?: number;
  parentCallId?: () => string;
  parentRound?: () => number;
}

export function createDefaultToolRuntime(options: DefaultToolRuntimeOptions): ToolRuntime {
  return createToolRuntime([
    createBashTool(options.cwd, { backgroundTasks: options.backgroundTasks }),
    createReadTool(options.cwd),
    createLsTool(options.cwd),
    createGrepTool(options.cwd),
    createFindTool(options.cwd),
    createEditTool(options.cwd),
    createWriteTool(options.cwd),
    createTodoTool(),
    ...(options.childSessionRunner
      ? [
          createDelegateTool({
            maxToolRounds: options.maxToolRounds ?? 8,
            ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
            ...(options.parentRound ? { parentRound: options.parentRound } : {}),
            runner: options.childSessionRunner,
          }),
        ]
      : []),
    ...(options.cronSchedules ? createCronTools(options.cronSchedules) : []),
  ]);
}
