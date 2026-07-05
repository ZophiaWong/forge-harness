import { describe, expect, it } from "vitest";

import {
  formatContextCompactionTranscript,
  formatFunctionCallTranscript,
  formatHookLogTranscript,
  formatPermissionDecisionTranscript,
  formatPromptAssemblyTranscript,
  formatRecoveryTranscript,
  formatRuntimeStateTranscript,
  formatSessionTranscript,
  formatVerificationTranscript,
} from "../../src/cli/transcript.js";
import type { RuntimeContextCompactionState } from "../../src/runtime/state.js";
import type { RuntimeState } from "../../src/runtime/state.js";
import type { VerificationResult } from "../../src/runtime/verification.js";

describe("formatFunctionCallTranscript", () => {
  it("prints the model tool request as a function_call", () => {
    expect(formatFunctionCallTranscript(1, "bash", '{"command":"ls -la"}')).toBe(
      '[round 1] function_call: bash {"command":"ls -la"}',
    );
  });
});

describe("formatPermissionDecisionTranscript", () => {
  it("prints the permission decision concisely", () => {
    expect(
      formatPermissionDecisionTranscript(2, {
        action: "ask",
        reason: "bash command may modify files or external state",
        risk: "mutating",
      }),
    ).toBe("[round 2] permission: ask risk=mutating reason=bash command may modify files or external state");
  });
});

describe("formatPromptAssemblyTranscript", () => {
  it("prints compact prompt assembly evidence", () => {
    expect(
      formatPromptAssemblyTranscript(1, {
        catalogSkillIds: ["chapter-handoff", "tutorial-writing", "verification-reporting"],
        instructionCharCount: 1234,
        sectionNames: [
          "base_instructions",
          "tool_rules",
          "project_memory",
          "skill_catalog",
          "selected_skills",
        ],
        selectedSkillIds: ["chapter-handoff", "verification-reporting"],
      }),
    ).toBe(
      "[round 1] prompt: sections=base_instructions,tool_rules,project_memory,skill_catalog,selected_skills catalogSkills=3 selectedSkills=chapter-handoff,verification-reporting chars=1234",
    );
  });
});

describe("formatContextCompactionTranscript", () => {
  it("prints compact context compaction evidence without the summary body", () => {
    const compaction: RuntimeContextCompactionState = {
      afterCharCount: 9_200,
      beforeCharCount: 25_200,
      compactedRoundCount: 2,
      keptRecentRoundCount: 2,
      missingHeadings: ["Evidence"],
      reason: "input chars 25200 exceeded soft budget 24000",
      round: 4,
      sourceItemCount: 6,
      sourceRoundCount: 2,
      summaryCharCount: 42,
      trigger: "auto",
    };

    expect(formatContextCompactionTranscript(compaction)).toBe(
      "[round 4] compact: trigger=auto beforeChars=25200 afterChars=9200 sourceRounds=2 keptRounds=2 sourceItems=6 summaryChars=42 missingHeadings=Evidence reason=input chars 25200 exceeded soft budget 24000",
    );
  });
});

describe("formatSessionTranscript", () => {
  it("prints the session id and trace path", () => {
    expect(formatSessionTranscript("20260625-160102-a1b2c3d4", ".forge/sessions/20260625-160102-a1b2c3d4/trace.jsonl")).toBe(
      "[session] id=20260625-160102-a1b2c3d4 trace=.forge/sessions/20260625-160102-a1b2c3d4/trace.jsonl",
    );
  });
});

describe("formatVerificationTranscript", () => {
  it("prints a compact verification result", () => {
    const result: VerificationResult = {
      command: "npm run build",
      exitCode: 0,
      name: "command",
      recoverable: false,
      status: "passed",
      summary: "status: completed\ncommand: npm run build\nexit_code: 0",
    };

    expect(formatVerificationTranscript(result)).toBe('[verify] status=passed command="npm run build" exitCode=0');
  });
});

describe("formatRecoveryTranscript", () => {
  it("prints the recovery attempt count", () => {
    expect(formatRecoveryTranscript(1, 1)).toBe("[recovery] attempt=1/1");
  });
});

describe("formatHookLogTranscript", () => {
  it("prints compact hook event summaries without payload text", () => {
    expect(
      formatHookLogTranscript({
        command: "npm run build",
        exitCode: 0,
        name: "command",
        round: 1,
        status: "passed",
        summary: "very long verification output that should not be printed",
        type: "verification_result",
      }),
    ).toBe("[hook] event=verification_result round=1 status=passed");
  });
});

describe("formatRuntimeStateTranscript", () => {
  it("prints a compact round state summary when a tool result exists", () => {
    const state: RuntimeState = {
      currentRound: 1,
      ended: false,
      lastToolResult: {
        callId: "call_find",
        projectedOutput: "tool: find\nstatus: completed",
        round: 1,
        status: "completed",
        toolName: "find",
      },
      status: "running",
    };

    expect(formatRuntimeStateTranscript(state, 1)).toBe(
      "[round 1] state: status=running lastTool=find lastToolStatus=completed",
    );
  });

  it("prints a compact final state summary with rounds and problem kind when present", () => {
    const state: RuntimeState = {
      currentRound: 1,
      ended: true,
      lastProblem: {
        kind: "session_failed",
        message: "stopped without final answer",
      },
      rounds: 1,
      status: "failed",
    };

    expect(formatRuntimeStateTranscript(state)).toBe("[state] status=failed rounds=1 problem=session_failed");
  });

  it("prints verification and recovery fields when present", () => {
    const state: RuntimeState = {
      currentRound: 2,
      ended: true,
      lastVerificationResult: {
        command: "npm run build",
        exitCode: 0,
        name: "command",
        round: 2,
        status: "passed",
        summary: "status: completed\ncommand: npm run build\nexit_code: 0",
      },
      recoveryAttempts: 1,
      rounds: 2,
      status: "completed",
    };

    expect(formatRuntimeStateTranscript(state)).toBe(
      "[state] status=completed rounds=2 verification=passed recoveryAttempts=1",
    );
  });

  it("prints compaction count and trigger when compaction happened", () => {
    const state: RuntimeState = {
      compactionCount: 1,
      currentRound: 4,
      ended: false,
      lastCompaction: {
        afterCharCount: 9_200,
        beforeCharCount: 25_200,
        compactedRoundCount: 2,
        keptRecentRoundCount: 2,
        missingHeadings: [],
        reason: "input chars 25200 exceeded soft budget 24000",
        round: 4,
        sourceItemCount: 6,
        sourceRoundCount: 2,
        summaryCharCount: 42,
        trigger: "auto",
      },
      status: "running",
    };

    expect(formatRuntimeStateTranscript(state, 4)).toBe(
      "[round 4] state: status=running compacted=1 lastCompact=auto",
    );
  });

  it("prints compact task state counters when a todo snapshot exists", () => {
    const state: RuntimeState = {
      currentRound: 2,
      ended: false,
      lastToolResult: {
        callId: "call_todo",
        projectedOutput: "tool: todo\nstatus: completed",
        round: 2,
        status: "completed",
        toolName: "todo",
      },
      status: "running",
      taskState: {
        acceptance: ["npm run build exits with code 0"],
        items: [
          { id: "inspect", status: "completed", title: "Inspect the current failure" },
          { id: "patch", status: "in_progress", title: "Patch the source file" },
          { id: "verify", status: "pending", title: "Run the build check" },
          { id: "blocked", status: "blocked", title: "Wait for approval" },
        ],
        summary: "Fix the build with a focused patch.",
        updatedAtRound: 2,
        updatedByCallId: "call_todo",
      },
    };

    expect(formatRuntimeStateTranscript(state, 2)).toBe(
      "[round 2] state: status=running lastTool=todo lastToolStatus=completed todos=3/4 blocked=1",
    );
  });
});
