export function formatFunctionCallTranscript(
  round: number,
  toolName: string,
  argumentsText: string,
): string {
  return `[round ${round}] function_call: ${toolName} ${argumentsText}`;
}

