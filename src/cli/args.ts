export function parseTaskFromArgs(args: string[]): string | undefined {
  const task = args.join(" ").trim();
  return task.length > 0 ? task : undefined;
}

export function usageText(commandName = "forge-harness"): string {
  return [
    "Usage:",
    `  ${commandName} "inspect this project scaffold"`,
    "",
    "Environment:",
    "  OPENAI_API_KEY  Required OpenAI API key.",
    "  OPENAI_MODEL    Optional model override. Defaults to gpt-5.4-mini.",
  ].join("\n");
}
