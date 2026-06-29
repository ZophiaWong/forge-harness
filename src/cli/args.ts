export interface ParsedCliArgs {
  error?: string;
  task?: string;
  verifyCommand?: string;
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  const taskParts: string[] = [];
  let verifyCommand: string | undefined;
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

    taskParts.push(arg);
  }

  return {
    ...(error ? { error } : {}),
    ...joinTask(taskParts),
    ...(verifyCommand ? { verifyCommand } : {}),
  };
}

export function parseTaskFromArgs(args: string[]): string | undefined {
  return joinTask(args).task;
}

export function usageText(binaryName: string): string {
  return [
    "Usage:",
    `  ${binaryName} "inspect this project"`,
    `  ${binaryName} --verify "npm run build" "fix the build"`,
    "",
    "Example:",
    `  ${binaryName} "inspect this project scaffold and summarize what is implemented"`,
  ].join("\n");
}

function joinTask(args: string[]): { task?: string } {
  const task = args.join(" ").trim();
  return task.length > 0 ? { task } : {};
}
