#!/usr/bin/env node

import "dotenv/config";
import path from "node:path";

import { createCliApprover } from "./approval.js";
import { parseTaskFromArgs, usageText } from "./args.js";
import {
  formatFunctionCallTranscript,
  formatPermissionDecisionTranscript,
  formatRuntimeStateTranscript,
  formatSessionTranscript,
} from "./transcript.js";
import { DEFAULT_MAX_TOOL_ROUNDS, DEFAULT_MODEL, runMinimalLoop } from "../core/minimalLoop.js";
import { createCliSessionTrace } from "../runtime/session.js";
import { createRuntimeStateRecorder, type RuntimeState } from "../runtime/state.js";

const task = parseTaskFromArgs(process.argv.slice(2));

if (!task) {
  console.error(usageText("forge-harness"));
  process.exitCode = 1;
} else {
  let getRuntimeState: (() => RuntimeState) | undefined;

  try {
    const cwd = process.cwd();
    const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    const maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS;
    const sessionTrace = await createCliSessionTrace({
      cwd,
      maxToolRounds,
      model,
      task,
    });
    const runtimeStateTrace = createRuntimeStateRecorder(sessionTrace.recorder);
    getRuntimeState = runtimeStateTrace.getState;
    const displayTracePath = path.relative(cwd, sessionTrace.paths.tracePath);

    console.log(formatSessionTranscript(sessionTrace.metadata.id, displayTracePath));

    await runMinimalLoop({
      approver: createCliApprover(),
      cwd,
      maxToolRounds,
      model,
      runtimeState: runtimeStateTrace.getState,
      task,
      traceRecorder: runtimeStateTrace.recorder,
      transcript: {
        roundStart(round, modelName) {
          console.log(`\n[round ${round}] model=${modelName}`);
        },
        roundState(round, state) {
          console.log(formatRuntimeStateTranscript(state, round));
        },
        toolCall(round, toolName, argumentsText) {
          console.log(formatFunctionCallTranscript(round, toolName, argumentsText));
        },
        permissionDecision(round, decision) {
          console.log(formatPermissionDecisionTranscript(round, decision));
        },
        toolResult(round, resultText) {
          console.log(`[round ${round}] tool_result:\n${resultText}`);
        },
        finalAnswer(answer) {
          console.log(`\n[final]\n${answer}`);
        },
        finalState(state) {
          console.log(formatRuntimeStateTranscript(state));
        },
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (getRuntimeState) {
      console.error(formatRuntimeStateTranscript(getRuntimeState()));
    }
    console.error(`forge-harness failed: ${message}`);
    process.exitCode = 1;
  }
}
