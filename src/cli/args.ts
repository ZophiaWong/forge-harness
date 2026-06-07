export interface ParsedCliArgs {
  showHistory: boolean;
  task: string | undefined;
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  const showHistory = args.includes("--show-history");
  const taskArgs = args.filter((arg) => arg !== "--show-history");

  return {
    showHistory,
    task: parseTaskFromArgs(taskArgs),
  };
}

export function parseTaskFromArgs(args: string[]): string | undefined {
  const task = args.join(" ").trim();
  return task.length > 0 ? task : undefined;
}

export function usageText(commandName = "forge-harness"): string {
  return [
    "Usage:",
    `  ${commandName} "inspect this project scaffold"`,
    `  ${commandName} --show-history "inspect this project scaffold"`,
    "",
    "Environment:",
    "  OPENAI_API_KEY  Required OpenAI API key.",
    "  OPENAI_MODEL    Optional model override. Defaults to gpt-5.4-mini.",
  ].join("\n");
}
