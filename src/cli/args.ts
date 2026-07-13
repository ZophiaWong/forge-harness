export interface ParsedCliArgs {
  cronWorker?: "watch" | "once";
  error?: string;
  hookLog?: boolean;
  task?: string;
  verifyCommand?: string;
  worktree?: boolean;
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  const taskParts: string[] = [];
  let cronWorker: "watch" | "once" | undefined;
  let hookLog = false;
  let verifyCommand: string | undefined;
  let worktree = false;
  let error: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--verify") {
      const command = args[index + 1]?.trim();

      if (!command) {
        error = "--verify requires a command.";
        continue;
      }

      verifyCommand = command;
      index += 1;
      continue;
    }

    if (arg === "--cron-worker" || arg === "--cron-worker-once") {
      if (cronWorker) {
        error = "Use only one cron worker mode.";
        continue;
      }

      cronWorker = arg === "--cron-worker" ? "watch" : "once";
      continue;
    }

    if (arg === "--hook-log") {
      hookLog = true;
      continue;
    }

    if (arg === "--worktree") {
      worktree = true;
      continue;
    }

    taskParts.push(arg);
  }

  const task = joinTask(taskParts);

  if (cronWorker && task.task && !error) {
    error = cronWorker === "watch" ? "--cron-worker does not accept a task." : "--cron-worker-once does not accept a task.";
  }

  if (cronWorker && verifyCommand && !error) {
    error = cronWorker === "watch" ? "--cron-worker does not accept --verify." : "--cron-worker-once does not accept --verify.";
  }

  return {
    ...(cronWorker ? { cronWorker } : {}),
    ...(error ? { error } : {}),
    ...(hookLog ? { hookLog } : {}),
    ...task,
    ...(verifyCommand ? { verifyCommand } : {}),
    ...(worktree ? { worktree } : {}),
  };
}

export function parseTaskFromArgs(args: string[]): string | undefined {
  return joinTask(args).task;
}

export function usageText(binaryName: string): string {
  return [
    "Usage:",
    `  ${binaryName} "inspect this project"`,
    `  ${binaryName} --worktree "fix docs"`,
    `  ${binaryName} --verify "npm run build" "fix the build"`,
    `  ${binaryName} --hook-log --verify "npm run build" "fix the build"`,
    `  ${binaryName} --cron-worker`,
    `  ${binaryName} --cron-worker --worktree`,
    `  ${binaryName} --cron-worker-once`,
    "",
    "Example:",
    `  ${binaryName} "inspect this project scaffold and summarize what is implemented"`,
  ].join("\n");
}

function joinTask(args: string[]): { task?: string } {
  const task = args.join(" ").trim();
  return task.length > 0 ? { task } : {};
}
