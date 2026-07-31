import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { AsyncChildSessionManager } from "../extensions/childSessions.js";
import type { TeammateManager } from "../extensions/teammates.js";
import type { BackgroundTaskManager } from "./backgroundTasks.js";
import { TeamTaskStoreError } from "../domain/teamTask.js";
import type { TeamTaskGraphHealth } from "../domain/teamTask.js";
import type { TeamTaskStore } from "./teamTaskStore.js";

const execFileAsync = promisify(execFile);

export type CompletionGateResult =
  | { status: "ready" }
  | { blockers: string[]; status: "incomplete" }
  | {
      problems: CompletionGateProblem[];
      status: "failed";
    };

export interface CompletionGateProblem {
  code: string;
  message: string;
  taskId?: string;
  teammate?: string;
}

export interface CreateCompletionGateOptions {
  backgroundTasks?: BackgroundTaskManager;
  childSessions?: AsyncChildSessionManager;
  cwd: string;
  taskGraphState?: () => {
    health: TeamTaskGraphHealth;
    lastError?: { code: string; message: string };
  } | undefined;
  taskStore?: TeamTaskStore;
  teammates?: TeammateManager;
}

export function createCompletionGate(
  options: CreateCompletionGateOptions,
): { evaluate(): Promise<CompletionGateResult> } {
  return {
    async evaluate() {
      const problems: Extract<CompletionGateResult, { status: "failed" }>["problems"] = [];
      const blockers: string[] = [];

      let graphReadFailed = false;
      if (options.taskStore) {
        try {
          const graph = await options.taskStore.read();
          for (const task of graph.tasks) {
            if (task.status === "blocked") {
              problems.push({
                code: task.blocker?.code ?? "task_blocked",
                message: task.blocker?.reason ?? `task "${task.id}" is blocked`,
                taskId: task.id,
              });
              continue;
            }
            if (task.status === "completed") {
              continue;
            }
            blockers.push(formatTaskBlocker(task));
          }
        } catch (error) {
          graphReadFailed = true;
          const code = error instanceof TeamTaskStoreError ? error.code : "graph_read_failed";
          problems.push({
            code,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!graphReadFailed) {
        const graphState = options.taskGraphState?.();
        if (graphState?.health === "degraded") {
          problems.push({
            code: graphState.lastError?.code ?? "graph_degraded",
            message: graphState.lastError?.message ?? "task graph runtime projection is degraded",
          });
        }
      }

      const members = options.teammates ? await options.teammates.list() : [];
      for (const member of members) {
        if (member.state === "failed") {
          problems.push({
            code: "owner_failure",
            message: member.failure ?? `teammate "${member.name}" failed`,
            teammate: member.name,
          });
          continue;
        }
        if (member.state !== "stopped") {
          blockers.push(
            `teammate "${member.name}" is ${member.state}; wait for idle, then call teammate_shutdown`,
          );
        }
        if (member.unreadCount > 0) {
          blockers.push(
            `teammate "${member.name}" has ${member.unreadCount} unread mailbox message(s)`,
          );
        }
      }

      const childCount = options.childSessions?.pendingCount() ?? 0;
      if (childCount > 0) {
        blockers.push(`${childCount} child session(s) are still running`);
      }
      const backgroundCount = options.backgroundTasks?.pendingCount() ?? 0;
      if (backgroundCount > 0) {
        blockers.push(`${backgroundCount} background task(s) are still running`);
      }

      try {
        if (await hasCherryPickInProgress(options.cwd)) {
          problems.push({
            code: "cherry_pick_in_progress",
            message: "Leader target has an in-progress cherry-pick",
          });
        }
      } catch (error) {
        problems.push({
          code: "git_state_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (problems.length > 0) {
        return { problems, status: "failed" };
      }
      if (blockers.length > 0) {
        return { blockers, status: "incomplete" };
      }
      return { status: "ready" };
    },
  };
}

export function formatCompletionBlockers(blockers: string[]): string {
  return [
    "<completion_gate>",
    "The team is not complete. Resolve every blocker before returning a final answer:",
    ...blockers.map((blocker) => `- ${blocker}`),
    "</completion_gate>",
  ].join("\n");
}

function formatTaskBlocker(task: {
  id: string;
  kind: "research" | "edit";
  owner?: { name?: string; role: "leader" | "teammate" };
  status: string;
  verdict?: { status: "passed" };
}): string {
  const owner = task.owner?.role === "leader"
    ? "leader"
    : task.owner?.name
      ? `teammate:${task.owner.name}`
      : "unowned";
  switch (task.status) {
    case "pending":
      return `task "${task.id}" (${task.kind}) is pending and ${owner}; assign or claim it`;
    case "in_progress":
      return `task "${task.id}" is in_progress under ${owner}; add evidence and submit its result`;
    case "submitted":
      return task.kind === "research"
        ? `task "${task.id}" is submitted; Leader must review_result`
        : task.verdict?.status === "passed"
          ? `task "${task.id}" is verified; Leader must task_integrate`
          : `task "${task.id}" is submitted; Leader must task_verify`;
    default:
      return `task "${task.id}" is ${task.status}`;
  }
}

async function hasCherryPickInProgress(cwd: string): Promise<boolean> {
  const result = await execFileAsync(
    "git",
    ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"],
    { cwd, encoding: "utf8" },
  ).catch(() => undefined);
  if (!result) {
    return false;
  }
  const gitPath = result.stdout.trim();
  const pathname = path.isAbsolute(gitPath) ? gitPath : path.join(cwd, gitPath);
  return fs.access(pathname).then(
    () => true,
    () => false,
  );
}
