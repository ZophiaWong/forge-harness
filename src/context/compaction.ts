import type { RuntimeState } from "../runtime/state.js";

export type ContextCompactionTrigger = "auto" | "reactive" | "manual";

export type RequiredCompactionHeading =
  | "Task"
  | "Progress"
  | "Evidence"
  | "Open Questions"
  | "Next Step";

export interface CompactableInputItem {
  call_id?: string;
  content?: string;
  output?: string;
  role?: string;
  type?: string;
  [key: string]: unknown;
}

export interface InputHistorySegment {
  items: CompactableInputItem[];
  round: number;
}

export interface CompactionSource {
  omittedCharCount: number;
  sourceItemCount: number;
  sourceRoundCount: number;
  text: string;
}

export interface BuildCompactionSourceOptions {
  history: InputHistorySegment[];
  recentHistory?: InputHistorySegment[];
  sourceItemCharLimit: number;
  state?: RuntimeState;
  task: string;
}

export interface ContextCompactionOptions {
  hardCharBudget: number;
  recentRoundsToKeep: number;
  softCharBudget: number;
  sourceItemCharLimit: number;
}

export type CompactionSummaryInspection =
  | {
      missingHeadings: RequiredCompactionHeading[];
      status: "usable";
      summary: string;
    }
  | {
      reason: string;
      status: "invalid";
    };

export interface InputHistoryManagerOptions {
  pinnedTask: CompactableInputItem;
  recentRoundsToKeep: number;
}

export interface ApplyCompactionOptions {
  missingHeadings: RequiredCompactionHeading[];
  sourceRoundCount: number;
  summary: string;
  trigger: ContextCompactionTrigger;
}

export interface ApplyCompactionResult {
  compactedRoundCount: number;
  keptRecentRoundCount: number;
}

export interface InputHistoryManager {
  appendRoundItems(round: number, items: CompactableInputItem[]): void;
  applyCompaction(options: ApplyCompactionOptions): ApplyCompactionResult;
  compactableHistory(): InputHistorySegment[];
  modelInput(): CompactableInputItem[];
  recentHistory(): InputHistorySegment[];
}

export const DEFAULT_COMPACTION_OPTIONS: ContextCompactionOptions = {
  hardCharBudget: 36_000,
  recentRoundsToKeep: 2,
  softCharBudget: 24_000,
  sourceItemCharLimit: 4_000,
};

const REQUIRED_HEADINGS: RequiredCompactionHeading[] = [
  "Task",
  "Progress",
  "Evidence",
  "Open Questions",
  "Next Step",
];

export function buildCompactionSource(options: BuildCompactionSourceOptions): CompactionSource {
  let omittedCharCount = 0;
  let sourceItemCount = 0;
  const lines = [
    "# Current Task",
    options.task,
    "",
    "# Runtime State",
    formatRuntimeStateAnchor(options.state),
    "",
    "# Recent History Kept Raw",
    "These rounds are not summarized because they stay raw in the next model input.",
    ...formatRecentHistoryIndex(options.recentHistory ?? []),
    "",
    "# Older History To Compact",
    "Recent rounds are intentionally not included here because they stay raw in the next model input.",
    "Summarize only the older history below; do not claim that omitted recent rounds are missing evidence.",
  ];

  for (const segment of options.history) {
    lines.push("", `## Round ${segment.round}`, `round: ${segment.round}`);

    for (const item of segment.items) {
      sourceItemCount += 1;
      const formatted = formatInputItemForSource(item);
      const trimmed = trimSourceItem(formatted, options.sourceItemCharLimit);
      omittedCharCount += trimmed.omittedCharCount;
      lines.push(trimmed.text);
    }
  }

  return {
    omittedCharCount,
    sourceItemCount,
    sourceRoundCount: options.history.length,
    text: lines.join("\n"),
  };
}

export function createInputHistoryManager(options: InputHistoryManagerOptions): InputHistoryManager {
  let compactedSummary: CompactableInputItem | undefined;
  let segments: InputHistorySegment[] = [];

  function recentRoundCount(): number {
    return Math.max(0, options.recentRoundsToKeep);
  }

  return {
    appendRoundItems(round, items) {
      if (items.length === 0) {
        return;
      }

      const existing = segments.find((segment) => segment.round === round);
      if (existing) {
        existing.items.push(...items);
        return;
      }

      segments.push({
        items: [...items],
        round,
      });
      segments = segments.sort((left, right) => left.round - right.round);
    },
    applyCompaction(compaction) {
      const removableRoundCount = Math.max(0, segments.length - recentRoundCount());
      const compactedRoundCount = Math.min(compaction.sourceRoundCount, removableRoundCount);

      if (compactedRoundCount > 0) {
        segments = segments.slice(compactedRoundCount);
      }

      compactedSummary = {
        content: compaction.summary,
        role: "user",
      };

      return {
        compactedRoundCount,
        keptRecentRoundCount: Math.min(segments.length, recentRoundCount()),
      };
    },
    compactableHistory() {
      const compactableRoundCount = Math.max(0, segments.length - recentRoundCount());
      return segments.slice(0, compactableRoundCount).map(cloneSegment);
    },
    modelInput() {
      return [
        options.pinnedTask,
        ...(compactedSummary ? [compactedSummary] : []),
        ...segments.flatMap((segment) => segment.items),
      ];
    },
    recentHistory() {
      return segments.slice(Math.max(0, segments.length - recentRoundCount())).map(cloneSegment);
    },
  };
}

export function estimateInputCharCount(items: CompactableInputItem[]): number {
  return items.reduce((count, item) => count + formatInputItemForCount(item).length, 0);
}

export function inspectCompactionSummary(rawSummary: string): CompactionSummaryInspection {
  const summary = rawSummary.trim();

  if (summary.length === 0) {
    return {
      reason: "compaction summary was empty",
      status: "invalid",
    };
  }

  return {
    missingHeadings: REQUIRED_HEADINGS.filter((heading) => !hasHeading(summary, heading)),
    status: "usable",
    summary,
  };
}

function cloneSegment(segment: InputHistorySegment): InputHistorySegment {
  return {
    items: segment.items.map((item) => ({ ...item })),
    round: segment.round,
  };
}

function formatRuntimeStateAnchor(state: RuntimeState | undefined): string {
  if (!state) {
    return "status: unknown";
  }

  const lines = [
    `status: ${state.status}`,
    `current_round: ${state.currentRound}`,
  ];

  if (state.task) {
    lines.push(`task: ${state.task}`);
  }

  if (state.taskState) {
    lines.push(`task_summary: ${state.taskState.summary}`);
    lines.push("todos:");
    for (const item of state.taskState.items) {
      lines.push(`- ${item.status} ${item.id}: ${item.title}${item.note ? ` (${item.note})` : ""}`);
    }
    lines.push("acceptance:");
    for (const item of state.taskState.acceptance) {
      lines.push(`- ${item}`);
    }
  }

  if (state.lastToolResult) {
    lines.push(`last_tool: ${state.lastToolResult.toolName}`);
    lines.push(`last_tool_status: ${state.lastToolResult.status}`);
  }

  if (state.lastVerificationResult) {
    lines.push(`verification: ${state.lastVerificationResult.status}`);
    lines.push(`verification_summary: ${state.lastVerificationResult.summary}`);
  }

  if (state.lastProblem) {
    lines.push(`problem: ${state.lastProblem.kind}`);
  }

  return lines.join("\n");
}

function formatInputItemForSource(item: CompactableInputItem): string {
  if (item.role === "user") {
    return ["item: user", item.content ?? ""].join("\n");
  }

  if (item.type === "function_call_output") {
    return [
      "item: function_call_output",
      item.call_id ? `call_id: ${item.call_id}` : undefined,
      item.output ?? "",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  if (item.type === "function_call") {
    return [
      "item: function_call",
      typeof item.name === "string" ? `tool: ${item.name}` : undefined,
      item.call_id ? `call_id: ${item.call_id}` : undefined,
      typeof item.arguments === "string" ? `arguments: ${item.arguments}` : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  return ["item: response_output", JSON.stringify(item)].join("\n");
}

function formatRecentHistoryIndex(history: InputHistorySegment[]): string[] {
  if (history.length === 0) {
    return ["(none)"];
  }

  const lines: string[] = [];

  for (const segment of history) {
    lines.push("", `## Recent Round ${segment.round}`, `round: ${segment.round}`);
    for (const item of segment.items) {
      lines.push(formatInputItemForRecentIndex(item));
    }
  }

  return lines;
}

function formatInputItemForRecentIndex(item: CompactableInputItem): string {
  if (item.type === "function_call") {
    return [
      "item: function_call",
      typeof item.name === "string" ? `tool: ${item.name}` : undefined,
      item.call_id ? `call_id: ${item.call_id}` : undefined,
      typeof item.arguments === "string" ? `arguments: ${item.arguments}` : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  if (item.type === "function_call_output") {
    return [
      "item: function_call_output",
      item.call_id ? `call_id: ${item.call_id}` : undefined,
      summarizeOutputForRecentIndex(item.output),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  if (item.role === "user") {
    return ["item: user", summarizeOutputForRecentIndex(item.content)].join("\n");
  }

  return ["item: response_output", summarizeOutputForRecentIndex(JSON.stringify(item))].join("\n");
}

function summarizeOutputForRecentIndex(value: string | undefined): string {
  if (!value) {
    return "(empty)";
  }

  const firstLines = value.split("\n").slice(0, 4).join("\n");
  return firstLines.length <= 400 ? firstLines : `${firstLines.slice(0, 400)}\n[recent index truncated]`;
}

function formatInputItemForCount(item: CompactableInputItem): string {
  if (item.role === "user") {
    return item.content ?? "";
  }

  if (item.type === "function_call_output") {
    return item.output ?? "";
  }

  return JSON.stringify(item);
}

function trimSourceItem(text: string, limit: number): { omittedCharCount: number; text: string } {
  if (limit < 0) {
    throw new Error("source item char limit must be non-negative.");
  }

  if (text.length <= limit) {
    return {
      omittedCharCount: 0,
      text,
    };
  }

  const omittedCharCount = text.length - limit;

  return {
    omittedCharCount,
    text: `${text.slice(0, limit)}\n[source item truncated ${omittedCharCount} chars]`,
  };
}

function hasHeading(summary: string, heading: RequiredCompactionHeading): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^#{1,3}\\s+${escaped}\\s*$`, "im");
  return pattern.test(summary);
}
