import { describe, expect, it } from "vitest";

import { aggregateModelMetrics } from "../../src/eval/metrics.js";
import type { TraceEventPayload } from "../../src/runtime/trace.js";

describe("eval model metrics", () => {
  it("aggregates root child teammate and compaction calls without treating missing usage as zero", () => {
    const root: TraceEventPayload[] = [
      {
        functionCallCount: 1,
        outputText: "",
        round: 1,
        telemetry: {
          durationMs: 10,
          usage: {
            cachedInputTokens: 60,
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
          },
        },
        type: "model_response",
      },
      {
        afterCharCount: 500,
        beforeCharCount: 1_000,
        compactedRoundCount: 1,
        keptRecentRoundCount: 1,
        missingHeadings: [],
        omittedSourceCharCount: 0,
        reason: "soft budget",
        round: 3,
        sourceItemCount: 2,
        sourceRoundCount: 1,
        summary: "summary",
        summaryCharCount: 7,
        telemetry: {
          durationMs: 5,
          usage: {
            inputTokens: 50,
            outputTokens: 10,
            reasoningTokens: 5,
            totalTokens: 60,
          },
        },
        trigger: "auto",
        type: "context_compacted",
      },
    ];
    const child: TraceEventPayload[] = [{
      functionCallCount: 0,
      outputText: "child done",
      round: 1,
      telemetry: { durationMs: 7 },
      type: "model_response",
    }];
    const teammate: TraceEventPayload[] = [{
      functionCallCount: 0,
      outputText: "teammate done",
      round: 1,
      type: "model_response",
    }];

    expect(aggregateModelMetrics([root, child, teammate])).toEqual({
      callCount: 4,
      duration: {
        knownCalls: 3,
        status: "partial",
        totalMs: 22,
      },
      tokens: {
        knownCalls: 2,
        status: "partial",
        totals: {
          cachedInputTokens: 60,
          inputTokens: 150,
          outputTokens: 30,
          reasoningTokens: 5,
          totalTokens: 180,
        },
      },
    });
  });

  it("reports unavailable coverage when no model calls contain telemetry", () => {
    const trace: TraceEventPayload[] = [{
      functionCallCount: 0,
      outputText: "done",
      round: 1,
      type: "model_response",
    }];

    expect(aggregateModelMetrics([trace])).toEqual({
      callCount: 1,
      duration: {
        knownCalls: 0,
        status: "unavailable",
        totalMs: 0,
      },
      tokens: {
        knownCalls: 0,
        status: "unavailable",
      },
    });
  });
});
