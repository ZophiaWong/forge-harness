#!/usr/bin/env node

import "dotenv/config";

import { parseCliArgs, usageText } from "./args.js";
import { formatHistorySnapshot } from "../core/historyInspector.js";
import { runMinimalLoop } from "../core/minimalLoop.js";

const cliArgs = parseCliArgs(process.argv.slice(2));

if (!cliArgs.task) {
  console.error(usageText("forge-harness"));
  process.exitCode = 1;
} else {
  await runMinimalLoop({
    cwd: process.cwd(),
    task: cliArgs.task,
    transcript: {
      roundStart(round, model) {
        console.log(`\n[round ${round}] model=${model}`);
      },
      historySnapshot(round, input) {
        if (cliArgs.showHistory) {
          console.log(`[round ${round}] input_history:\n${formatHistorySnapshot(input)}`);
        }
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
