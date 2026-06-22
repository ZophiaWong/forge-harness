#!/usr/bin/env node

import "dotenv/config";

import { createCliApprover } from "./approval.js";
import { parseTaskFromArgs, usageText } from "./args.js";
import { formatFunctionCallTranscript, formatPermissionDecisionTranscript } from "./transcript.js";
import { runMinimalLoop } from "../core/minimalLoop.js";

const task = parseTaskFromArgs(process.argv.slice(2));

if (!task) {
  console.error(usageText("forge-harness"));
  process.exitCode = 1;
} else {
  await runMinimalLoop({
    approver: createCliApprover(),
    cwd: process.cwd(),
    task,
    transcript: {
      roundStart(round, model) {
        console.log(`\n[round ${round}] model=${model}`);
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
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`forge-harness failed: ${message}`);
    process.exitCode = 1;
  });
}
