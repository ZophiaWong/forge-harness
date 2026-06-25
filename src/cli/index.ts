#!/usr/bin/env node

import "dotenv/config";
import path from "node:path";

import { createCliApprover } from "./approval.js";
import { parseTaskFromArgs, usageText } from "./args.js";
import { formatFunctionCallTranscript, formatPermissionDecisionTranscript, formatSessionTranscript } from "./transcript.js";
import { DEFAULT_MAX_TOOL_ROUNDS, DEFAULT_MODEL, runMinimalLoop } from "../core/minimalLoop.js";
import { createCliSessionTrace } from "../runtime/session.js";

const task = parseTaskFromArgs(process.argv.slice(2));

if (!task) {
  console.error(usageText("forge-harness"));
  process.exitCode = 1;
} else {
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
    const displayTracePath = path.relative(cwd, sessionTrace.paths.tracePath);

    console.log(formatSessionTranscript(sessionTrace.metadata.id, displayTracePath));

    await runMinimalLoop({
      approver: createCliApprover(),
      cwd,
      maxToolRounds,
      model,
      task,
      traceRecorder: sessionTrace.recorder,
      transcript: {
        roundStart(round, modelName) {
          console.log(`\n[round ${round}] model=${modelName}`);
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
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`forge-harness failed: ${message}`);
    process.exitCode = 1;
  }
}
