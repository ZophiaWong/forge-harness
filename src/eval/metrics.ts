import type { ModelUsage } from "../domain/model.js";
import type { TraceEventPayload } from "../runtime/trace.js";
import type { EvalModelMetrics, MetricAvailability } from "./types.js";

export function aggregateModelMetrics(traces: TraceEventPayload[][]): EvalModelMetrics {
  let callCount = 0;
  let durationKnownCalls = 0;
  let durationTotalMs = 0;
  let tokenKnownCalls = 0;
  let cachedInputTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let sawCachedInputTokens = false;
  let sawReasoningTokens = false;

  for (const event of traces.flat()) {
    if (event.type !== "model_response" && event.type !== "context_compacted") {
      continue;
    }
    callCount += 1;

    if (event.telemetry && Number.isFinite(event.telemetry.durationMs)) {
      durationKnownCalls += 1;
      durationTotalMs += event.telemetry.durationMs;
    }

    const usage = event.telemetry?.usage;
    if (!usage) {
      continue;
    }
    tokenKnownCalls += 1;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    totalTokens += usage.totalTokens;
    if (usage.cachedInputTokens !== undefined) {
      sawCachedInputTokens = true;
      cachedInputTokens += usage.cachedInputTokens;
    }
    if (usage.reasoningTokens !== undefined) {
      sawReasoningTokens = true;
      reasoningTokens += usage.reasoningTokens;
    }
  }

  const totals: ModelUsage | undefined = tokenKnownCalls > 0
    ? {
        ...(sawCachedInputTokens ? { cachedInputTokens } : {}),
        inputTokens,
        outputTokens,
        ...(sawReasoningTokens ? { reasoningTokens } : {}),
        totalTokens,
      }
    : undefined;

  return {
    callCount,
    duration: {
      knownCalls: durationKnownCalls,
      status: coverageStatus(durationKnownCalls, callCount),
      totalMs: durationTotalMs,
    },
    tokens: {
      knownCalls: tokenKnownCalls,
      status: coverageStatus(tokenKnownCalls, callCount),
      ...(totals ? { totals } : {}),
    },
  };
}

function coverageStatus(knownCalls: number, callCount: number): MetricAvailability {
  if (knownCalls === 0) {
    return "unavailable";
  }
  return knownCalls === callCount ? "complete" : "partial";
}
