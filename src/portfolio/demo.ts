import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runMinimalLoop, type MinimalResponse, type ResponseCreate } from "../core/minimalLoop.js";
import { createDefaultPermissionPolicy } from "../governance/defaultPolicy.js";
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
  failScene?: PortfolioScene;
}

export interface PortfolioDemoLine {
  label: `scene.${PortfolioScene}`;
  receipt: string;
  status: "PASS" | "FAIL";
}

export interface PortfolioDemoResult {
  cleaned: boolean;
  exitCode: 0 | 1;
  lines: PortfolioDemoLine[];
}

/**
 * Run the recruiter walkthrough without a provider, .env, network, or model.
 * Each scene owns its own temporary resources and emits only stable aliases.
 */
export async function runPortfolioDemo(
  options: PortfolioDemoOptions = {},
): Promise<PortfolioDemoResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-portfolio-demo-"));
  const lines: PortfolioDemoLine[] = [];
  let cleaned = false;
  let exitCode: 0 | 1 = 1;

  try {
    await runScene("action-boundary", options, lines, () => runActionBoundaryScene(root));
    if (lines.at(-1)?.status !== "FAIL") {
      await runScene("verification-recovery", options, lines, () => runVerificationRecoveryScene(root));
    }
    if (lines.at(-1)?.status !== "FAIL") {
      await runScene("coordination-completion", options, lines, () => runCoordinationCompletionScene(root));
    }
    exitCode = lines.length === 3 && lines.every((line) => line.status === "PASS") ? 0 : 1;
  } finally {
    await fs.rm(root, { force: true, recursive: true });
    cleaned = true;
  }
  return { cleaned, exitCode, lines };
}

export async function main(): Promise<number> {
  const result = await runPortfolioDemo();
  for (const line of result.lines) {
    console.log(`${line.label} ${line.status} ${line.receipt}`);
  }
  return result.exitCode;
}

async function runScene(
  scene: PortfolioScene,
  options: PortfolioDemoOptions,
  lines: PortfolioDemoLine[],
  run: () => Promise<string>,
): Promise<void> {
  if (options.failScene === scene) {
    lines.push({ label: `scene.${scene}`, receipt: "scripted-failure", status: "FAIL" });
    return;
  }

  try {
    lines.push({ label: `scene.${scene}`, receipt: await run(), status: "PASS" });
  } catch {
    lines.push({ label: `scene.${scene}`, receipt: "assertion-failed", status: "FAIL" });
  }
}

async function runActionBoundaryScene(root: string): Promise<string> {
  const cwd = path.join(root, "boundary");
  await fs.mkdir(cwd, { recursive: true });
  let dispatchCount = 0;
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
      return { action: "deny", reason: "portfolio policy denies out-of-scope write", risk: "mutating" };
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
  return "deny-before-dispatch";
}

async function runVerificationRecoveryScene(root: string): Promise<string> {
  const cwd = path.join(root, "verification");
  await fs.mkdir(cwd, { recursive: true });
  const events: string[] = [];
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
        events.push(`final:${answer}`);
      },
      recoveryAttempt() {
        events.push("recovery");
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
        events.push(`verification:${result.status}`);
        return result;
      },
    },
  });
  const recoveryIndex = events.indexOf("recovery");
  const finalIndex = events.findIndex((event) => event.startsWith("final:"));
  if (recoveryIndex < 0 || finalIndex < 0 || recoveryIndex > finalIndex) {
    throw new Error("final answer was accepted before recovery");
  }
  return "recovery-before-final";
}

async function runCoordinationCompletionScene(root: string): Promise<string> {
  const repo = path.join(root, "coordination");
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

  const earlyGate = createCompletionGate({ cwd: repo, taskStore: store });
  const early = await earlyGate.evaluate();
  if (early.status !== "incomplete") {
    throw new Error("completion gate allowed an early final");
  }

  await fs.writeFile(path.join(teammateWorkspace.path, "portfolio.txt"), "ready\n", "utf8");
  const gitIntegration = createGitIntegrationService({ targetCwd: repo });
  const source = {
    kind: "teammate" as const,
    name: "editor",
    profile: "edit" as const,
    sessionId: teammate.sessionId,
    workspace: { branch: teammateWorkspace.branch, path: teammateWorkspace.path },
  };
  const snapshot = await gitIntegration.capture(source);
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
  await store.recordVerification(leader, taskId, {
    command: "test -f portfolio.txt",
    exitCode: verification.exitCode,
    fingerprint: verification.actualFingerprint,
    summary: "verification passed",
  });
  const receipt = await gitIntegration.integrate((await store.get(taskId)).task);
  await store.recordIntegration(leader, taskId, receipt);
  const final = await createCompletionGate({ cwd: repo, taskStore: store }).evaluate();
  if (final.status !== "ready") {
    throw new Error("completion gate did not become ready after receipt");
  }
  if (!receipt.fingerprint || !(await store.get(taskId)).task.integrationReceipt) {
    throw new Error("integration receipt missing before ready gate");
  }
  await git(["worktree", "remove", "--force", teammateWorkspace.path], repo);
  return "receipt-before-ready";
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
