import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runMinimalLoop, type MinimalResponse, type ResponseCreate } from "../core/minimalLoop.js";
import { createCompletionGate } from "../runtime/completionGate.js";
import { createGitIntegrationService } from "../runtime/gitIntegration.js";
import { createFileTeamTaskStore } from "../runtime/teamTaskStore.js";
import { createGitTeammateWorkspace } from "../runtime/workspace.js";
import { createCommandVerifier } from "../runtime/verification.js";
import type { PermissionPolicy } from "../governance/types.js";
import type { RegisteredTool, ToolRuntime } from "../tools/types.js";

const execFileAsync = promisify(execFile);

export type PortfolioScene =
  | "action-boundary"
  | "verification-recovery"
  | "coordination-completion";

export interface PortfolioDemoOptions {
  explain?: boolean;
  failScene?: PortfolioScene;
}

export interface PortfolioDemoLine {
  label: `scene.${PortfolioScene}`;
  receipt: string;
  status: "PASS" | "FAIL";
}

export interface PortfolioDemoResult {
  cleaned: boolean;
  explanations: string[];
  exitCode: 0 | 1;
  lines: PortfolioDemoLine[];
}

export interface PortfolioCliDependencies {
  error(message: string): void;
  log(message: string): void;
  runDemo(options: PortfolioDemoOptions): Promise<PortfolioDemoResult>;
}

interface PortfolioSceneExecution {
  facts: string[];
  receipt: string;
}

/**
 * Run the recruiter walkthrough without a provider, .env, network, or model.
 * Each scene owns its own temporary resources and emits only stable aliases.
 */
export async function runPortfolioDemo(
  options: PortfolioDemoOptions = {},
): Promise<PortfolioDemoResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-portfolio-demo-"));
  const explanations: string[] = [];
  const lines: PortfolioDemoLine[] = [];
  let cleaned = false;
  let exitCode: 0 | 1 = 1;

  try {
    await runScene("action-boundary", options, lines, explanations, () => runActionBoundaryScene(root));
    if (lines.at(-1)?.status !== "FAIL") {
      await runScene(
        "verification-recovery",
        options,
        lines,
        explanations,
        () => runVerificationRecoveryScene(root),
      );
    }
    if (lines.at(-1)?.status !== "FAIL") {
      await runScene(
        "coordination-completion",
        options,
        lines,
        explanations,
        () => runCoordinationCompletionScene(root),
      );
    }
    exitCode = lines.length === 3 && lines.every((line) => line.status === "PASS") ? 0 : 1;
  } finally {
    await fs.rm(root, { force: true, recursive: true });
    cleaned = true;
  }
  return { cleaned, explanations, exitCode, lines };
}

export async function main(
  args: string[] = process.argv.slice(2),
  dependencies: PortfolioCliDependencies = defaultCliDependencies(),
): Promise<0 | 1 | 2> {
  let explain = false;
  try {
    explain = parsePortfolioArgs(args);
  } catch (error) {
    dependencies.error(`Usage error: ${error instanceof Error ? error.message : String(error)}`);
    dependencies.error(portfolioUsage());
    return 2;
  }
  if (args[0] === "--help") {
    dependencies.log(portfolioUsage());
    return 0;
  }

  const result = await dependencies.runDemo({ explain });
  for (const line of result.lines) {
    dependencies.log(`${line.label} ${line.status} ${line.receipt}`);
  }
  if (explain) {
    for (const explanation of result.explanations) {
      dependencies.log(explanation);
    }
  }
  return result.exitCode;
}

export function portfolioUsage(): string {
  return [
    "Usage: npm run demo:portfolio -- [--explain]",
    "",
    "Run the deterministic, no-model recruiter walkthrough.",
    "  --explain  Add sanitized evidence annotations after the three receipts.",
    "  --help     Show this help without creating a walkthrough fixture.",
  ].join("\n");
}

function parsePortfolioArgs(args: string[]): boolean {
  if (args.length === 1 && args[0] === "--help") {
    return false;
  }
  if (args.includes("--help")) {
    throw new Error("--help must be used alone");
  }
  let explain = false;
  for (const arg of args) {
    if (arg !== "--explain") {
      throw new Error(`unknown option ${JSON.stringify(arg)}`);
    }
    if (explain) {
      throw new Error("duplicate option --explain");
    }
    explain = true;
  }
  return explain;
}

function defaultCliDependencies(): PortfolioCliDependencies {
  return {
    error(message) {
      console.error(message);
    },
    log(message) {
      console.log(message);
    },
    runDemo: runPortfolioDemo,
  };
}

async function runScene(
  scene: PortfolioScene,
  options: PortfolioDemoOptions,
  lines: PortfolioDemoLine[],
  explanations: string[],
  run: () => Promise<PortfolioSceneExecution>,
): Promise<void> {
  if (options.failScene === scene) {
    lines.push({ label: `scene.${scene}`, receipt: "scripted-failure", status: "FAIL" });
    return;
  }

  try {
    const execution = await run();
    lines.push({ label: `scene.${scene}`, receipt: execution.receipt, status: "PASS" });
    if (options.explain) {
      explanations.push(`explain.${scene} ${execution.facts.join(" ")}`);
    }
  } catch {
    lines.push({ label: `scene.${scene}`, receipt: "assertion-failed", status: "FAIL" });
  }
}

async function runActionBoundaryScene(root: string): Promise<PortfolioSceneExecution> {
  const cwd = path.join(root, "boundary");
  await fs.mkdir(cwd, { recursive: true });
  let dispatchCount = 0;
  const facts: string[] = [];
  const writeTool: RegisteredTool = {
    definition: {
      description: "portfolio write probe",
      name: "write",
      parameters: {
        additionalProperties: false,
        properties: { content: { type: "string" }, path: { type: "string" } },
        required: ["content", "path"],
        type: "object",
      },
      strict: true,
      type: "function",
    },
    async handler() {
      dispatchCount += 1;
      return { content: "unexpected dispatch", status: "completed", toolName: "write" };
    },
  };
  const toolRuntime: ToolRuntime = {
    execute: async (toolCall, context) => writeTool.handler({
      callId: context?.callId,
      rawArguments: toolCall.arguments,
      round: context?.round,
    }),
    toolDefinitions: () => [writeTool.definition],
  };
  const policy: PermissionPolicy = {
    decide() {
      const decision = {
        action: "deny" as const,
        reason: "portfolio policy denies out-of-scope write",
        risk: "mutating" as const,
      };
      facts.push(`policy=${decision.action === "deny" ? "denied" : decision.action}`);
      return decision;
    },
  };
  let responseIndex = 0;
  const responseCreate: ResponseCreate = async (): Promise<MinimalResponse> => {
    responseIndex += 1;
    if (responseIndex === 1) {
      return {
        output: [{
          arguments: JSON.stringify({ content: "blocked", path: "outside-scope.txt" }),
          call_id: "portfolio-boundary-1",
          name: "write",
          type: "function_call",
        }],
        output_text: "",
      };
    }
    return { output: [], output_text: "write denied before dispatch" };
  };

  await runMinimalLoop({
    apiKey: "",
    baseURL: "",
    contextCompaction: false,
    cwd,
    maxToolRounds: 2,
    model: "portfolio-script",
    permissionPolicy: policy,
    promptAssets: { skills: [] },
    responseCreate,
    task: "Demonstrate the action boundary.",
    toolRuntime,
  });
  if (dispatchCount !== 0) {
    throw new Error("write handler dispatched before policy denial");
  }
  facts.push(`dispatches=${dispatchCount}`);
  return { facts, receipt: "deny-before-dispatch" };
}

async function runVerificationRecoveryScene(root: string): Promise<PortfolioSceneExecution> {
  const cwd = path.join(root, "verification");
  await fs.mkdir(cwd, { recursive: true });
  const facts: string[] = [];
  let responseIndex = 0;
  const responseCreate: ResponseCreate = async (): Promise<MinimalResponse> => {
    responseIndex += 1;
    return {
      output: [],
      output_text: responseIndex === 1 ? "candidate-before-recovery" : "candidate-after-recovery",
    };
  };
  const verifier = createCommandVerifier({
    command: "if [ -e .portfolio-verifier-recovered ]; then exit 0; else touch .portfolio-verifier-recovered; exit 1; fi",
    cwd,
  });

  await runMinimalLoop({
    apiKey: "",
    baseURL: "",
    contextCompaction: false,
    cwd,
    maxRecoveryAttempts: 1,
    maxToolRounds: 3,
    model: "portfolio-script",
    promptAssets: { skills: [] },
    responseCreate,
    task: "Demonstrate verification recovery.",
    toolRuntime: emptyToolRuntime,
    transcript: {
      finalAnswer(answer) {
        if (answer === "candidate-after-recovery") {
          facts.push("final=accepted");
        }
      },
      recoveryAttempt() {
        facts.push("recovery=attempted");
      },
      roundStart() {
        // Stable demo output intentionally omits round numbers.
      },
      toolCall() {
        // No scripted tool calls in this scene.
      },
      toolResult() {
        // No scripted tool calls in this scene.
      },
    },
    verifier: {
      async verify(context) {
        const result = await verifier.verify(context);
        facts.push(`verification=${result.status}`);
        return result;
      },
    },
  });
  const recoveryIndex = facts.indexOf("recovery=attempted");
  const finalIndex = facts.indexOf("final=accepted");
  if (recoveryIndex < 0 || finalIndex < 0 || recoveryIndex > finalIndex) {
    throw new Error("final answer was accepted before recovery");
  }
  if (facts.join(" ") !== "verification=failed recovery=attempted verification=passed final=accepted") {
    throw new Error("verification recovery facts were not observed in order");
  }
  return { facts, receipt: "recovery-before-final" };
}

async function runCoordinationCompletionScene(root: string): Promise<PortfolioSceneExecution> {
  const repo = path.join(root, "coordination");
  const facts: string[] = [];
  await fs.mkdir(repo, { recursive: true });
  await git(["init", "-q"], repo);
  await fs.appendFile(path.join(repo, ".git", "info", "exclude"), ".forge/worktrees/\n", "utf8");
  await git(["config", "user.email", "portfolio@example.invalid"], repo);
  await git(["config", "user.name", "Forge Portfolio Demo"], repo);
  await fs.writeFile(path.join(repo, "README.md"), "portfolio demo\n", "utf8");
  await git(["add", "README.md"], repo);
  await git(["commit", "--no-gpg-sign", "-qm", "initial"], repo);

  const rootSessionId = "portfolio-session";
  const teammateWorkspace = await createGitTeammateWorkspace({
    baseCwd: repo,
    name: "editor",
    rootSessionId,
  });
  const graphPath = path.join(root, "coordination-state", "task-graph.json");
  const store = createFileTeamTaskStore({ graphPath });
  await store.initialize();
  const leader = { role: "leader" as const, sessionId: rootSessionId };
  const teammate = {
    name: "editor",
    profile: "edit" as const,
    role: "teammate" as const,
    sessionId: "editor-session",
  };
  const created = await store.create(leader, {
    acceptance: ["portfolio.txt exists"],
    description: "Create the deterministic portfolio artifact.",
    kind: "edit",
    title: "Write portfolio artifact",
    verificationCommand: "test -f portfolio.txt",
  });
  const taskId = created.task.id;
  await store.transition(leader, {
    action: "assign",
    assignee: { name: "editor", profile: "edit", role: "teammate" },
    id: taskId,
  });
  await store.transition(teammate, {
    action: "submit_plan",
    id: taskId,
    steps: ["write portfolio.txt", "run verification"],
    summary: "Editor will write and verify the artifact in its worktree.",
  });
  await store.transition(leader, {
    action: "review_plan",
    decision: "approve",
    id: taskId,
    reason: "Plan is scoped to the editor worktree.",
  });
  if ((await store.get(taskId)).task.plan?.status !== "approved") {
    throw new Error("task plan was not approved before the editor write");
  }
  facts.push("task=approved");

  const earlyGate = createCompletionGate({ cwd: repo, taskStore: store });
  const early = await earlyGate.evaluate();
  if (early.status !== "incomplete") {
    throw new Error("completion gate allowed an early final");
  }
  facts.push("gate=incomplete");

  await fs.writeFile(path.join(teammateWorkspace.path, "portfolio.txt"), "ready\n", "utf8");
  facts.push("worktree=written");
  const gitIntegration = createGitIntegrationService({ targetCwd: repo });
  const source = {
    kind: "teammate" as const,
    name: "editor",
    profile: "edit" as const,
    sessionId: teammate.sessionId,
    workspace: { branch: teammateWorkspace.branch, path: teammateWorkspace.path },
  };
  const snapshot = await gitIntegration.capture(source);
  if (!snapshot.fingerprint) {
    throw new Error("fingerprint was not captured from the editor worktree");
  }
  facts.push("fingerprint=captured");
  await store.addEvidence(teammate, taskId, {
    callId: "portfolio-editor-write",
    references: [{ kind: "artifact", value: "portfolio.txt" }],
    round: 1,
    summary: "Editor worktree contains the requested artifact.",
  });
  await store.transition(teammate, {
    action: "submit_result",
    changedFiles: snapshot.changedFiles,
    fingerprint: snapshot.fingerprint,
    id: taskId,
    source,
    summary: "Artifact written in the editor worktree.",
  });
  const taskAfterSubmit = (await store.get(taskId)).task;
  const verification = await gitIntegration.verify(taskAfterSubmit, "test -f portfolio.txt");
  if (verification.exitCode !== 0 || verification.sourceDrifted) {
    throw new Error("editor worktree verification did not pass");
  }
  facts.push("verification=passed");
  await store.recordVerification(leader, taskId, {
    command: "test -f portfolio.txt",
    exitCode: verification.exitCode,
    fingerprint: verification.actualFingerprint,
    summary: "verification passed",
  });
  const receipt = await gitIntegration.integrate((await store.get(taskId)).task);
  await store.recordIntegration(leader, taskId, receipt);
  facts.push("integration=recorded");
  const final = await createCompletionGate({ cwd: repo, taskStore: store }).evaluate();
  if (final.status !== "ready") {
    throw new Error("completion gate did not become ready after receipt");
  }
  if (!receipt.fingerprint || !(await store.get(taskId)).task.integrationReceipt) {
    throw new Error("integration receipt missing before ready gate");
  }
  facts.push("gate=ready");
  await git(["worktree", "remove", "--force", teammateWorkspace.path], repo);
  return { facts, receipt: "receipt-before-ready" };
}

const emptyToolRuntime: ToolRuntime = {
  execute: async (toolCall) => ({
    content: `blocked_reason: no scripted tool ${toolCall.name}`,
    status: "blocked",
    toolName: toolCall.name,
  }),
  toolDefinitions: () => [],
};

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}
