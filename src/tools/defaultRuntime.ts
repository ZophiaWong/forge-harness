import { createBashTool } from "./bashTool.js";
import { createEditTool } from "./editTool.js";
import { createFindTool } from "./findTool.js";
import { createGrepTool } from "./grepTool.js";
import { createLsTool } from "./lsTool.js";
import { createReadTool } from "./readTool.js";
import { createToolRuntime } from "./runtime.js";
import { createTodoTool } from "./todoTool.js";
import type { ToolRuntime } from "./types.js";
import { createWriteTool } from "./writeTool.js";

export interface DefaultToolRuntimeOptions {
  cwd: string;
}

export function createDefaultToolRuntime(options: DefaultToolRuntimeOptions): ToolRuntime {
  return createToolRuntime([
    createBashTool(options.cwd),
    createReadTool(options.cwd),
    createLsTool(options.cwd),
    createGrepTool(options.cwd),
    createFindTool(options.cwd),
    createEditTool(options.cwd),
    createWriteTool(options.cwd),
    createTodoTool(),
  ]);
}
