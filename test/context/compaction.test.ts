import { describe, expect, it } from "vitest";

import {
  buildCompactionSource,
  createInputHistoryManager,
  inspectCompactionSummary,
  type CompactableInputItem,
} from "../../src/context/compaction.js";
import type { RuntimeState } from "../../src/runtime/state.js";

const TASK_ITEM: CompactableInputItem = {
  content: "Investigate long context pressure.",
  role: "user",
};

function modelCall(callId: string, round: number): CompactableInputItem {
  return {
    arguments: JSON.stringify({ path: `docs/tutorial/c0${round}.md` }),
    call_id: callId,
    name: "read",
    type: "function_call",
  };
}

function toolOutput(callId: string, output: string): CompactableInputItem {
  return {
    call_id: callId,
    output,
    type: "function_call_output",
  };
}

function runtimeState(): RuntimeState {
  return {
    currentRound: 3,
    ended: false,
    lastToolResult: {
      callId: "call_3",
      projectedOutput: "tool: read\nstatus: completed\nobservation: read completed",
      round: 3,
      status: "completed",
      toolName: "read",
    },
    status: "running",
    task: "Investigate long context pressure.",
    taskState: {
      acceptance: ["Summarize what c12 preserves."],
      items: [
        { id: "inspect", status: "completed", title: "Read long tutorial chapters" },
        { id: "summarize", status: "in_progress", title: "Summarize compacted evidence" },
      ],
      summary: "The agent is gathering evidence before writing the answer.",
      updatedAtRound: 2,
      updatedByCallId: "call_todo",
    },
  };
}

describe("buildCompactionSource", () => {
  it("includes state anchors and trims large history items with omitted char evidence", () => {
    const largeOutput = [
      "tool: read",
      "status: completed",
      "observation: read completed",
      "content:",
      "x".repeat(80),
    ].join("\n");

    const source = buildCompactionSource({
      history: [
        {
          items: [modelCall("call_1", 1), toolOutput("call_1", largeOutput)],
          round: 1,
        },
      ],
      recentHistory: [
        {
          items: [modelCall("call_2", 2), toolOutput("call_2", "round 2 output")],
          round: 2,
        },
      ],
      sourceItemCharLimit: 60,
      state: runtimeState(),
      task: "Investigate long context pressure.",
    });

    expect(source.text).toContain("# Current Task");
    expect(source.text).toContain("Investigate long context pressure.");
    expect(source.text).toContain("# Runtime State");
    expect(source.text).toContain("status: running");
    expect(source.text).toContain("task_summary: The agent is gathering evidence before writing the answer.");
    expect(source.text).toContain("# Older History To Compact");
    expect(source.text).toContain("Recent rounds are intentionally not included here because they stay raw");
    expect(source.text).toContain("# Recent History Kept Raw");
    expect(source.text).toContain("round: 2");
    expect(source.text).toContain("tool: read");
    expect(source.text).toContain("docs/tutorial/c02.md");
    expect(source.text).toContain("round: 1");
    expect(source.text).toContain("[source item truncated");
    expect(source.omittedCharCount).toBeGreaterThan(0);
    expect(source.sourceItemCount).toBe(2);
    expect(source.sourceRoundCount).toBe(1);
  });
});

describe("InputHistoryManager", () => {
  it("replaces old rounds with one compacted summary while keeping the pinned task and recent raw rounds", () => {
    const history = createInputHistoryManager({
      pinnedTask: TASK_ITEM,
      recentRoundsToKeep: 2,
    });

    history.appendRoundItems(1, [modelCall("call_1", 1), toolOutput("call_1", "round 1 output")]);
    history.appendRoundItems(2, [modelCall("call_2", 2), toolOutput("call_2", "round 2 output")]);
    history.appendRoundItems(3, [modelCall("call_3", 3), toolOutput("call_3", "round 3 output")]);

    const result = history.applyCompaction({
      missingHeadings: [],
      sourceRoundCount: 1,
      summary: "# Compacted Context\n\n## Task\nInvestigate long context pressure.",
      trigger: "auto",
    });

    expect(result.compactedRoundCount).toBe(1);
    expect(history.modelInput()).toEqual([
      TASK_ITEM,
      {
        content: "# Compacted Context\n\n## Task\nInvestigate long context pressure.",
        role: "user",
      },
      modelCall("call_2", 2),
      toolOutput("call_2", "round 2 output"),
      modelCall("call_3", 3),
      toolOutput("call_3", "round 3 output"),
    ]);
  });

  it("replaces an existing compacted summary instead of stacking summaries", () => {
    const history = createInputHistoryManager({
      pinnedTask: TASK_ITEM,
      recentRoundsToKeep: 1,
    });

    history.appendRoundItems(1, [modelCall("call_1", 1), toolOutput("call_1", "round 1 output")]);
    history.appendRoundItems(2, [modelCall("call_2", 2), toolOutput("call_2", "round 2 output")]);
    history.applyCompaction({
      missingHeadings: [],
      sourceRoundCount: 1,
      summary: "# Compacted Context\n\n## Task\nFirst summary.",
      trigger: "auto",
    });
    history.appendRoundItems(3, [modelCall("call_3", 3), toolOutput("call_3", "round 3 output")]);
    history.applyCompaction({
      missingHeadings: ["Evidence"],
      sourceRoundCount: 1,
      summary: "# Compacted Context\n\n## Task\nSecond summary.",
      trigger: "reactive",
    });

    const input = history.modelInput();

    expect(
      input.filter(
        (item) =>
          item.role === "user" &&
          typeof item.content === "string" &&
          item.content.includes("# Compacted Context"),
      ),
    ).toHaveLength(1);
    expect(input).toContainEqual({
      content: "# Compacted Context\n\n## Task\nSecond summary.",
      role: "user",
    });
    expect(input).not.toContainEqual({
      content: "# Compacted Context\n\n## Task\nFirst summary.",
      role: "user",
    });
  });
});

describe("inspectCompactionSummary", () => {
  it("accepts non-empty summaries and reports missing fixed headings", () => {
    expect(inspectCompactionSummary("## Task\nStill working.")).toEqual({
      missingHeadings: ["Progress", "Evidence", "Open Questions", "Next Step"],
      status: "usable",
      summary: "## Task\nStill working.",
    });
  });

  it("rejects empty summaries", () => {
    expect(inspectCompactionSummary(" \n\t ")).toEqual({
      reason: "compaction summary was empty",
      status: "invalid",
    });
  });
});
