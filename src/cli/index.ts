#!/usr/bin/env node

import "dotenv/config";

import { parseTaskFromArgs, usageText } from "./args.js";
import { runMinimalLoop } from "../core/minimalLoop.js";

const task = parseTaskFromArgs(process.argv.slice(2));

if (!task) {
  console.error(usageText("forge-harness"));
  process.exitCode = 1;
} else {
  await runMinimalLoop({
    cwd: process.cwd(),
    task,
    transcript: {
      roundStart(round, model) {
        console.log(`\n[round ${round}] model=${model}`);
      },
      toolCall(round, command) {
        console.log(`[round ${round}] bash: ${command}`);
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
