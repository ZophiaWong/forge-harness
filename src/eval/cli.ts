#!/usr/bin/env node

import "dotenv/config";

import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";

import {
  promoteEvalBaseline,
  type PromoteEvalBaselineOptions,
  type PromoteEvalBaselineResult,
} from "./baseline.js";
import {
  cleanEvalRuns,
  type CleanEvalRunsOptions,
  type CleanEvalRunsResult,
} from "./cleanup.js";
import {
  runEvalSuite,
  type RunEvalSuiteOptions,
  type RunEvalSuiteResult,
} from "./suite.js";
import type { EvalCountDiff } from "./types.js";

export type ParsedEvalCliArgs =
  | {
      command: "clean";
      yes: boolean;
    }
  | {
      command: "promote";
      from: string;
      replace: boolean;
    }
  | {
      command: "run";
      model: string;
      providerId?: string;
      scenarioId?: string;
    };

export interface EvalCliDependencies {
  cleanRuns(options: CleanEvalRunsOptions): Promise<CleanEvalRunsResult>;
  confirm(question: string): Promise<boolean>;
  env: Record<string, string | undefined>;
  error(message: string): void;
  log(message: string): void;
  promoteBaseline(options: PromoteEvalBaselineOptions): Promise<PromoteEvalBaselineResult>;
  repositoryRoot: string;
  runSuite(options: RunEvalSuiteOptions): Promise<RunEvalSuiteResult>;
}

export function parseEvalCliArgs(args: string[]): ParsedEvalCliArgs {
  const [command, ...rest] = args;
  if (command === "run") {
    const values = parseOptions(rest, new Set(["--model", "--provider-id", "--scenario"]), new Set());
    const model = values.strings.get("--model");
    if (!model) {
      throw new Error("eval run requires --model <model>");
    }
    const providerId = values.strings.get("--provider-id");
    const scenarioId = values.strings.get("--scenario");
    return {
      command: "run",
      model,
      ...(providerId ? { providerId } : {}),
      ...(scenarioId ? { scenarioId } : {}),
    };
  }
  if (command === "promote") {
    const values = parseOptions(rest, new Set(["--from"]), new Set(["--replace"]));
    const from = values.strings.get("--from");
    if (!from) {
      throw new Error("eval promote requires --from <summary.json>");
    }
    return { command: "promote", from, replace: values.booleans.has("--replace") };
  }
  if (command === "clean") {
    const values = parseOptions(rest, new Set(), new Set(["--yes"]));
    return { command: "clean", yes: values.booleans.has("--yes") };
  }
  throw new Error(`unknown eval command ${JSON.stringify(command ?? "")}`);
}

export async function runEvalCli(
  args: string[],
  dependencies: EvalCliDependencies = defaultDependencies(),
): Promise<0 | 1 | 2> {
  try {
    const parsed = parseEvalCliArgs(args);
    if (parsed.command === "run") {
      const result = await dependencies.runSuite({
        ...(dependencies.env.OPENAI_API_KEY ? { apiKey: dependencies.env.OPENAI_API_KEY } : {}),
        ...(dependencies.env.OPENAI_BASE_URL ? { baseURL: dependencies.env.OPENAI_BASE_URL } : {}),
        model: parsed.model,
        ...(parsed.providerId ? { providerId: parsed.providerId } : {}),
        repositoryRoot: dependencies.repositoryRoot,
        ...(parsed.scenarioId ? { scenarioId: parsed.scenarioId } : {}),
      });
      dependencies.log(`Forge eval verdict: ${result.report.verdict}`);
      dependencies.log(`Report: ${path.relative(dependencies.repositoryRoot, result.artifactPaths.markdownPath)}`);
      return result.report.exitCode;
    }
    if (parsed.command === "promote") {
      const result = await dependencies.promoteBaseline({
        from: path.resolve(dependencies.repositoryRoot, parsed.from),
        onReplacementDiff(diffs, baselinePath) {
          dependencies.log(`Replacing baseline: ${path.relative(dependencies.repositoryRoot, baselinePath)}`);
          dependencies.log(formatReplacementDiffs(diffs));
        },
        replace: parsed.replace,
        repositoryRoot: dependencies.repositoryRoot,
      });
      dependencies.log(`${result.replaced ? "Replaced" : "Promoted"} baseline: ${path.relative(
        dependencies.repositoryRoot,
        result.baselinePath,
      )}`);
      return 0;
    }

    const confirmed = parsed.yes || await dependencies.confirm(
      "Delete completed or invalid marked Forge eval runs? [y/N] ",
    );
    if (!confirmed) {
      dependencies.error("Eval clean canceled.");
      return 2;
    }
    const result = await dependencies.cleanRuns({
      confirmed: true,
      evalRoot: path.join(dependencies.repositoryRoot, ".forge", "evals"),
      repositoryRoot: dependencies.repositoryRoot,
    });
    dependencies.log(`Removed ${result.removedRunIds.length} eval run(s).`);
    if (result.skippedActiveRunIds.length > 0) {
      dependencies.log(`Skipped active runs: ${result.skippedActiveRunIds.join(", ")}`);
    }
    return 0;
  } catch (error) {
    dependencies.error(error instanceof Error ? error.message : String(error));
    dependencies.error(evalUsage());
    return 2;
  }
}

export function evalUsage(): string {
  return [
    "Usage:",
    "  npm run eval -- run --model <model> [--provider-id <id>] [--scenario <id>]",
    "  npm run eval -- promote --from <summary.json> [--replace]",
    "  npm run eval -- clean [--yes]",
  ].join("\n");
}

function parseOptions(
  args: string[],
  stringOptions: Set<string>,
  booleanOptions: Set<string>,
): { booleans: Set<string>; strings: Map<string, string> } {
  const booleans = new Set<string>();
  const strings = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index] as string;
    if (booleanOptions.has(option)) {
      if (booleans.has(option)) {
        throw new Error(`duplicate option ${option}`);
      }
      booleans.add(option);
      continue;
    }
    if (!stringOptions.has(option)) {
      throw new Error(`unknown option ${option}`);
    }
    if (strings.has(option)) {
      throw new Error(`duplicate option ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    strings.set(option, value);
    index += 1;
  }
  return { booleans, strings };
}

function formatReplacementDiffs(diffs: EvalCountDiff[]): string {
  return [
    "Scenario | Contract | Old | New | Delta",
    ...diffs.map((diff) => [
      diff.scenarioId,
      diff.assertionId ?? "scenario pass",
      diff.baseline,
      diff.candidate,
      diff.delta > 0 ? `+${diff.delta}` : diff.delta,
    ].join(" | ")),
  ].join("\n");
}

function defaultDependencies(): EvalCliDependencies {
  return {
    cleanRuns: cleanEvalRuns,
    async confirm(question) {
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await terminal.question(question);
        return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
      } finally {
        terminal.close();
      }
    },
    env: process.env,
    error(message) {
      console.error(message);
    },
    log(message) {
      console.log(message);
    },
    promoteBaseline: promoteEvalBaseline,
    repositoryRoot: process.cwd(),
    runSuite: runEvalSuite,
  };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runEvalCli(process.argv.slice(2));
}
