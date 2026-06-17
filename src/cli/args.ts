export function parseTaskFromArgs(args: string[]): string | undefined {
  const task = args.join(" ").trim();
  return task.length > 0 ? task : undefined;
}

export function usageText(binaryName: string): string {
  return [
    "Usage:",
    `  ${binaryName} "inspect this project"`,
    "",
    "Example:",
    `  ${binaryName} "inspect this project scaffold and summarize what is implemented"`,
  ].join("\n");
}

