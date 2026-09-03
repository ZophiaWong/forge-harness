#!/usr/bin/env node

import "dotenv/config";

import path from "node:path";
import { pathToFileURL } from "node:url";

import { runEvalEvidence } from "../eval/releaseEvidence.js";
import { runLiveEvidence } from "../portfolio/liveEvidence.js";
import {
  prepareEvidenceIntent,
  promoteEvidenceIntent,
  verifyPublishedEvidence,
  writeEvidenceIntent,
  type EvidenceCaptureResult,
  type PrepareEvidenceIntentOptions,
} from "../runtime/evidenceBundle.js";

export type ParsedEvidenceCliArgs =
  | {
      command: "eval";
      baseline?: string;
      intent: string;
      retryOf?: string;
      role: "baseline" | "candidate" | "observation";
    }
  | {
      command: "live";
      intent: string;
      retryOf?: string;
    }
  | {
      command: "prepare";
      mode: "observation" | "regression";
      output?: string;
      ref: string;
      subject: string;
    }
  | {
      command: "promote";
      intent: string;
    }
  | {
      archives: string[];
      command: "verify";
      manifest: string;
    };

export interface EvidenceCommandRunResult {
  capture: EvidenceCaptureResult;
  exitCode: 0 | 1 | 2;
}

export interface EvidenceCliDependencies {
  env: Record<string, string | undefined>;
  error(message: string): void;
  log(message: string): void;
  prepareIntent(options: PrepareEvidenceIntentOptions): ReturnType<typeof prepareEvidenceIntent>;
  promote(options: { intentPath: string }): Promise<{ releaseManifestPath: string }>;
  repositoryRoot: string;
  runEval(options: {
    baselinePath?: string;
    intentPath: string;
    retryOf?: string;
    role: "baseline" | "candidate" | "observation";
  }): Promise<EvidenceCommandRunResult>;
  runLive(options: {
    intentPath: string;
    retryOf?: string;
  }): Promise<EvidenceCommandRunResult>;
  verify(options: {
    archivePaths: string[];
    manifestPath: string;
  }): Promise<{ runCount: number }>;
  writeIntent(
    intent: Awaited<ReturnType<typeof prepareEvidenceIntent>>,
    requestedOutput: string | undefined,
    repositoryRoot: string,
  ): Promise<string>;
}

export function parseEvidenceCliArgs(args: string[]): ParsedEvidenceCliArgs {
  const [command, ...rest] = args;
  if (command === "prepare") {
    const values = parseOptions(rest, ["--subject", "--ref", "--mode", "--output"]);
    const subject = required(values, "--subject", "evidence prepare");
    const ref = required(values, "--ref", "evidence prepare");
    const mode = required(values, "--mode", "evidence prepare");
    if (mode !== "observation" && mode !== "regression") {
      throw new Error("evidence prepare --mode must be observation or regression");
    }
    const output = first(values, "--output");
    return { command, mode, ...(output ? { output } : {}), ref, subject };
  }
  if (command === "live") {
    const values = parseOptions(rest, ["--intent", "--retry-of"]);
    const retryOf = first(values, "--retry-of");
    return {
      command,
      intent: required(values, "--intent", "evidence live"),
      ...(retryOf ? { retryOf } : {}),
    };
  }
  if (command === "eval") {
    const values = parseOptions(rest, ["--intent", "--role", "--baseline", "--retry-of"]);
    const role = required(values, "--role", "evidence eval");
    if (role !== "observation" && role !== "baseline" && role !== "candidate") {
      throw new Error("evidence eval --role must be observation, baseline, or candidate");
    }
    const baseline = first(values, "--baseline");
    if (role === "candidate" && !baseline) {
      throw new Error("evidence eval candidate requires --baseline <baseline.json>");
    }
    if (role !== "candidate" && baseline) {
      throw new Error("evidence eval --baseline is valid only for candidate runs");
    }
    const retryOf = first(values, "--retry-of");
    return {
      ...(baseline ? { baseline } : {}),
      command,
      intent: required(values, "--intent", "evidence eval"),
      ...(retryOf ? { retryOf } : {}),
      role,
    };
  }
  if (command === "promote") {
    const values = parseOptions(rest, ["--intent"]);
    return { command, intent: required(values, "--intent", "evidence promote") };
  }
  if (command === "verify") {
    const values = parseOptions(rest, ["--manifest", "--archive"], new Set(["--archive"]));
    const archives = values.get("--archive") ?? [];
    if (archives.length === 0) {
      throw new Error("evidence verify requires at least one --archive <archive.tgz>");
    }
    return {
      archives,
      command,
      manifest: required(values, "--manifest", "evidence verify"),
    };
  }
  throw new Error(`unknown evidence command ${JSON.stringify(command ?? "")}`);
}

export async function runEvidenceCli(
  args: string[],
  dependencies: EvidenceCliDependencies = defaultDependencies(),
): Promise<0 | 1 | 2> {
  try {
    const parsed = parseEvidenceCliArgs(args);
    if (parsed.command === "prepare") {
      const intent = await dependencies.prepareIntent({
        collectorRoot: dependencies.repositoryRoot,
        endpoint: nonEmpty(dependencies.env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1",
        mode: parsed.mode,
        model: nonEmpty(dependencies.env.EVIDENCE_MODEL)
          ?? nonEmpty(dependencies.env.OPENAI_MODEL)
          ?? "gpt-5.4-mini",
        providerId: nonEmpty(dependencies.env.EVIDENCE_PROVIDER_ID) ?? "my-gateway",
        ref: parsed.ref,
        subjectRoot: path.resolve(dependencies.repositoryRoot, parsed.subject),
      });
      const intentPath = await dependencies.writeIntent(
        intent,
        parsed.output,
        dependencies.repositoryRoot,
      );
      dependencies.log(`Evidence intent: ${displayPath(dependencies.repositoryRoot, intentPath)}`);
      return 0;
    }
    if (parsed.command === "live") {
      const result = await dependencies.runLive({
        intentPath: path.resolve(dependencies.repositoryRoot, parsed.intent),
        ...(parsed.retryOf ? { retryOf: parsed.retryOf } : {}),
      });
      logCapture(dependencies, result.capture);
      return result.exitCode;
    }
    if (parsed.command === "eval") {
      const result = await dependencies.runEval({
        ...(parsed.baseline
          ? { baselinePath: path.resolve(dependencies.repositoryRoot, parsed.baseline) }
          : {}),
        intentPath: path.resolve(dependencies.repositoryRoot, parsed.intent),
        ...(parsed.retryOf ? { retryOf: parsed.retryOf } : {}),
        role: parsed.role,
      });
      logCapture(dependencies, result.capture);
      return result.exitCode;
    }
    if (parsed.command === "promote") {
      const result = await dependencies.promote({
        intentPath: path.resolve(dependencies.repositoryRoot, parsed.intent),
      });
      dependencies.log(`Release manifest: ${displayPath(dependencies.repositoryRoot, result.releaseManifestPath)}`);
      return 0;
    }
    const result = await dependencies.verify({
      archivePaths: parsed.archives.map((archive) => path.resolve(dependencies.repositoryRoot, archive)),
      manifestPath: path.resolve(dependencies.repositoryRoot, parsed.manifest),
    });
    dependencies.log(`Verified ${result.runCount} evidence run(s).`);
    return 0;
  } catch (error) {
    dependencies.error(error instanceof Error ? error.message : String(error));
    dependencies.error(evidenceUsage());
    return 2;
  }
}

export function evidenceUsage(): string {
  return [
    "Usage:",
    "  npm run evidence -- prepare --subject <checkout> --ref <tag> --mode <observation|regression> [--output <intent.json>]",
    "  npm run evidence -- live --intent <intent.json> [--retry-of <run-id>]",
    "  npm run evidence -- eval --intent <intent.json> --role <observation|baseline|candidate> [--baseline <baseline.json>] [--retry-of <run-id>]",
    "  npm run evidence -- promote --intent <intent.json>",
    "  npm run evidence -- verify --manifest <manifest.json> --archive <archive.tgz> [--archive <archive.tgz> ...]",
  ].join("\n");
}

function parseOptions(
  args: string[],
  allowed: string[],
  repeatable: Set<string> = new Set(),
): Map<string, string[]> {
  const allowedSet = new Set(allowed);
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index] as string;
    if (!allowedSet.has(option)) {
      throw new Error(`unknown option ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    if (values.has(option) && !repeatable.has(option)) {
      throw new Error(`duplicate option ${option}`);
    }
    values.set(option, [...values.get(option) ?? [], value]);
    index += 1;
  }
  return values;
}

function required(values: Map<string, string[]>, option: string, command: string): string {
  const value = first(values, option);
  if (!value) {
    throw new Error(`${command} requires ${option} <value>`);
  }
  return value;
}

function first(values: Map<string, string[]>, option: string): string | undefined {
  return values.get(option)?.[0];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function displayPath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : candidate;
}

function logCapture(
  dependencies: Pick<EvidenceCliDependencies, "log">,
  capture: EvidenceCaptureResult,
): void {
  dependencies.log(`Evidence run: ${capture.runId}`);
  dependencies.log(`Evidence capture: ${capture.captureStatus}`);
  dependencies.log(`Behavioral verdict: ${capture.behavioralVerdict}`);
  dependencies.log(`Promotion eligible: ${String(capture.promotionEligible)}`);
}

function defaultDependencies(): EvidenceCliDependencies {
  return {
    env: process.env,
    error: (message) => console.error(message),
    log: (message) => console.log(message),
    prepareIntent: prepareEvidenceIntent,
    promote: promoteEvidenceIntent,
    repositoryRoot: process.cwd(),
    runEval: runEvalEvidence,
    runLive: runLiveEvidence,
    verify: verifyPublishedEvidence,
    writeIntent: writeEvidenceIntent,
  };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runEvidenceCli(process.argv.slice(2));
}
