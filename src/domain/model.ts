export interface ModelUsage {
  cachedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface ModelCallTelemetry {
  durationMs: number;
  usage?: ModelUsage;
}
