import fs from "node:fs/promises";
import path from "node:path";

import {
  createOpenAIResponseCreate,
  type ResponseCreate,
  type ResponseCreateRequest,
} from "../core/minimalLoop.js";
import { createLifecycleEmitter } from "../extensions/lifecycle.js";
import type { Verifier, VerificationResult } from "../runtime/verification.js";
import { evalRuntimeBootstrap } from "./bootstrap.js";
import { runC17cRuntime, type C17cRuntimeResult } from "./c17c.js";
import { EvalInfrastructureError } from "./errors.js";
import { aggregateModelMetrics } from "./metrics.js";
import {
  collectEvalTraceSessions,
} from "./evidence.js";
import {
  createEvalFixture,
  readEvalGitSnapshot,
} from "./fixture.js";
import {
  createEvalApprover,
  createEvalPermissionPolicy,
} from "./policy.js";
import type {
  EvalAttemptEvidence,
  EvalGrade,
  EvalScenario,
  EvalTraceSession,
} from "./scenario.js";
import { C17C_ARTIFACT_PATH } from "./scenarios.js";
import type { EvalAttemptResult } from "./types.js";

export interface RunEvalAttemptOptions {
  apiKey?: string;
  attemptRoot: string;
  baseURL?: string;
  evidenceRefPrefix: string;
  model: string;
  ordinal: number;
  repositoryRoot: string;
  responseCreate?: ResponseCreate;
  scenario: EvalScenario;
}

export interface RunEvalAttemptResult {
  attempt: EvalAttemptResult;
  sessions: EvalTraceSession[];
  workspace: string;
}

interface EvalExecutionResult {
  finalAnswer?: string;
  reasonCode?: string;
  status: "completed" | "invalid";
}

export async function runEvalAttempt(
  options: RunEvalAttemptOptions,
): Promise<RunEvalAttemptResult> {
  const attemptRoot = path.resolve(options.attemptRoot);
  await fs.mkdir(attemptRoot, { recursive: true });
  const fixture = await createEvalFixture({
    attemptRoot,
    repositoryRoot: options.repositoryRoot,
    scenario: options.scenario,
  });
  const rootTrace = await evalRuntimeBootstrap.createCliSessionTrace({
    cwd: fixture.cwd,
    maxToolRounds: options.scenario.manifest.runtime.rootMaxToolRounds,
    model: options.model,
    task: options.scenario.manifest.task,
  });
  const lifecycleEmitter = createLifecycleEmitter({ recorder: rootTrace.recorder });
  const approver = createEvalApprover(options.scenario);
  const modelRequestChecks: EvalAttemptEvidence["modelRequestChecks"] = [];
  let execution: EvalExecutionResult;
  let c17cResult: C17cRuntimeResult | undefined;

  try {
    const baseResponseCreate = options.responseCreate
      ?? createOpenAIResponseCreate(options.apiKey, options.baseURL);
    const responseCreate = observeResponseCreate(
      baseResponseCreate,
      options.scenario.manifest.task,
      modelRequestChecks,
    );
    const result = await runWithWorkflowDeadline(
      async (signal) => {
        const childRunner = options.scenario.id === "async-child-handoff"
          ? evalRuntimeBootstrap.createChildSessionRunner({
              ...(options.apiKey ? { apiKey: options.apiKey } : {}),
              approver,
              baseCwd: fixture.cwd,
              ...(options.baseURL ? { baseURL: options.baseURL } : {}),
              model: options.model,
              parentLifecycleEmitter: lifecycleEmitter,
              parentSessionId: rootTrace.metadata.id,
              permissionPolicy: createEvalPermissionPolicy({
                scenario: options.scenario,
                session: {
                  profile: "research",
                  role: "child",
                  sessionId: "eval-child",
                },
              }),
              responseCreate,
              signal,
              taskGraph: rootTrace.metadata.taskGraph,
            })
          : undefined;
        const verifier = options.scenario.id === "verification-recovery"
          ? createRecoveryVerifier(attemptRoot, options.scenario.manifest.runtime.verifierTimeoutMs)
          : undefined;
        if (options.scenario.id === "c17c-team-completion") {
          const c17c = await runC17cRuntime({
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
            approver,
            ...(options.baseURL ? { baseURL: options.baseURL } : {}),
            model: options.model,
            responseCreate,
            rootTrace,
            scenario: options.scenario,
            signal,
            workspace: fixture.cwd,
          });
          c17cResult = c17c;
          return { finalAnswer: c17c.finalAnswer };
        }
        return evalRuntimeBootstrap.runMinimalLoop({
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          approver,
          ...(options.baseURL ? { baseURL: options.baseURL } : {}),
          ...(childRunner ? { childSessionRunner: childRunner } : {}),
          ...(options.scenario.manifest.runtime.contextCompaction
            ? { contextCompaction: options.scenario.manifest.runtime.contextCompaction }
            : {}),
          cwd: fixture.cwd,
          lifecycleEmitter,
          maxRecoveryAttempts: 1,
          maxToolRounds: options.scenario.manifest.runtime.rootMaxToolRounds,
          model: options.model,
          permissionPolicy: createEvalPermissionPolicy({
            base: evalRuntimeBootstrap.createDefaultPermissionPolicy(),
            scenario: options.scenario,
            session: { role: "root", sessionId: rootTrace.metadata.id },
          }),
          promptAssets: await evalRuntimeBootstrap.loadRepoPromptAssets(fixture.cwd),
          responseCreate,
          signal,
          task: options.scenario.manifest.task,
          ...(verifier ? { verifier } : {}),
        });
      },
      options.scenario.manifest.runtime.workflowTimeoutMs,
    );
    execution = { finalAnswer: result.finalAnswer, status: "completed" };
  } catch (error) {
    execution = classifyEvalExecutionError(error);
  }

  let sessions: EvalTraceSession[];
  let after;
  try {
    [sessions, after] = await Promise.all([
      collectEvalTraceSessions({
        attemptRoot,
        ...(execution.status === "invalid"
          ? { emptyRootSessionId: rootTrace.metadata.id }
          : {}),
        rootTracePath: rootTrace.paths.tracePath,
      }),
      readEvalGitSnapshot(fixture.cwd),
    ]);
  } catch {
    sessions = [];
    after = fixture.initial;
    execution = { reasonCode: "evidence_corrupt", status: "invalid" };
  }

  const evidence: EvalAttemptEvidence = {
    artifacts: {
      ...(options.scenario.id === "c17c-team-completion"
        ? { [C17C_ARTIFACT_PATH]: await readOptionalFile(path.join(fixture.cwd, C17C_ARTIFACT_PATH)) }
        : {}),
    },
    ...(execution.finalAnswer !== undefined ? { finalAnswer: execution.finalAnswer } : {}),
    git: { after, before: fixture.initial },
    modelRequestChecks,
    scenarioId: options.scenario.id,
    sessions,
    ...(c17cResult?.taskGraph ? { taskGraph: c17cResult.taskGraph } : {}),
    ...(c17cResult?.team ? { team: c17cResult.team } : {}),
  };
  let grade = sessions.length > 0
    ? options.scenario.grade(evidence)
    : unavailableGrade(options.scenario);
  if (execution.status === "invalid") {
    grade = gradeForInvalidExecution(grade);
  }

  const evidenceRefs = await writeAttemptEvidence({
    attemptRoot,
    evidence,
    evidenceRefPrefix: options.evidenceRefPrefix,
    execution,
    grade,
  });
  const metrics = aggregateModelMetrics(sessions.map((session) => session.events));
  const assertions = grade.assertions.map((assertion) => ({
    ...assertion,
    evidenceRefs: [...evidenceRefs],
  }));
  const attempt: EvalAttemptResult = {
    assertions,
    attemptId: `${options.scenario.id}-${options.ordinal}`,
    evidenceRefs,
    execution: execution.status === "invalid"
      ? {
          ...(execution.reasonCode ? { reasonCode: execution.reasonCode } : {}),
          status: "invalid",
        }
      : { status: "completed" },
    metrics,
    ordinal: options.ordinal,
    outcome: execution.status === "invalid" ? "unavailable" : grade.outcome,
    scenarioId: options.scenario.id,
  };
  return { attempt, sessions, workspace: fixture.cwd };
}

function observeResponseCreate(
  base: ResponseCreate,
  pinnedTask: string,
  checks: EvalAttemptEvidence["modelRequestChecks"],
): ResponseCreate {
  let compactionCompleted = false;
  return async (request, options) => {
    const compactionRequest = isCompactionRequest(request);
    if (!compactionRequest && compactionCompleted) {
      checks.push({
        afterCompaction: true,
        pinnedTaskPresent: hasPinnedTask(request, pinnedTask),
        round: checks.length + 1,
      });
    }
    const response = await base(request, options);
    if (compactionRequest) {
      compactionCompleted = true;
    }
    return response;
  };
}

function isCompactionRequest(request: ResponseCreateRequest): boolean {
  return request.tools.length === 0
    && request.instructions.includes("compacting the active context");
}

function hasPinnedTask(request: ResponseCreateRequest, pinnedTask: string): boolean {
  const first = request.input[0];
  return first !== undefined
    && "role" in first
    && first.role === "user"
    && "content" in first
    && first.content === pinnedTask;
}

function createRecoveryVerifier(attemptRoot: string, timeoutMs: number): Verifier {
  const markerPath = path.join(attemptRoot, "private", "recovery.marker");
  let invocation = 0;
  return {
    async verify(): Promise<VerificationResult> {
      return withVerifierTimeout((async () => {
        invocation += 1;
        if (invocation === 1) {
          await fs.mkdir(path.dirname(markerPath), { recursive: true });
          await fs.writeFile(markerPath, "first verification observed\n", "utf8");
          return {
            exitCode: 1,
            name: "eval-recovery",
            recoverable: true,
            status: "failed",
            summary: "first verification intentionally failed after writing the trusted marker",
          };
        }
        await fs.access(markerPath);
        return {
          exitCode: 0,
          name: "eval-recovery",
          recoverable: false,
          status: "passed",
          summary: "trusted recovery marker observed",
        };
      })(), timeoutMs, "verifier_timeout");
    },
  };
}

export function classifyEvalExecutionError(error: unknown): EvalExecutionResult {
  if (error instanceof EvalInfrastructureError) {
    return { reasonCode: error.reasonCode, status: "invalid" };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Minimal loop stopped after")
    || message.includes("Verification failed after")
    || message.includes("Completion gate failed")
    || message.includes("Context compaction failed")
  ) {
    return { status: "completed" };
  }
  if (message.includes("verifier_timeout")) {
    return { reasonCode: "verifier_timeout", status: "invalid" };
  }
  if (message.includes("Verification blocked.")) {
    return { reasonCode: "verifier_blocked", status: "invalid" };
  }
  if (message.includes("workflow_timeout")) {
    return { reasonCode: "workflow_timeout", status: "invalid" };
  }
  return { reasonCode: "provider_error", status: "invalid" };
}

function gradeForInvalidExecution(grade: EvalGrade): EvalGrade {
  return {
    assertions: grade.assertions,
    outcome: "unavailable",
  };
}

function unavailableGrade(scenario: EvalScenario): EvalGrade {
  const assertionIds = scenario.grade({
    artifacts: {},
    git: {
      after: { head: "unavailable", statusEntries: [] },
      before: { head: "unavailable", statusEntries: [] },
    },
    modelRequestChecks: [],
    scenarioId: scenario.id,
    sessions: [{ events: [], role: "root", sessionId: "unavailable" }],
  }).assertions.map((assertion) => ({ ...assertion, status: "unavailable" as const }));
  return { assertions: assertionIds, outcome: "unavailable" };
}

async function writeAttemptEvidence(options: {
  attemptRoot: string;
  evidence: EvalAttemptEvidence;
  evidenceRefPrefix: string;
  execution: EvalExecutionResult;
  grade: EvalGrade;
}): Promise<string[]> {
  const refs = [`${options.evidenceRefPrefix}/grade.json`];
  await fs.writeFile(path.join(options.attemptRoot, "grade.json"), `${JSON.stringify({
    assertions: options.grade.assertions,
    execution: options.execution.status === "invalid"
      ? { reasonCode: options.execution.reasonCode, status: "invalid" }
      : { status: "completed" },
    git: options.evidence.git,
    outcome: options.grade.outcome,
  }, null, 2)}\n`, "utf8");

  const roleCounts = new Map<string, number>();
  for (const session of options.evidence.sessions) {
    const count = (roleCounts.get(session.role) ?? 0) + 1;
    roleCounts.set(session.role, count);
    const stem = session.role === "root"
      ? "root-trace"
      : `${session.role}-${count}-trace`;
    const filename = `${stem}.jsonl`;
    await fs.writeFile(
      path.join(options.attemptRoot, filename),
      session.events.length > 0
        ? `${session.events.map((event) => JSON.stringify(event)).join("\n")}\n`
        : "",
      "utf8",
    );
    refs.push(`${options.evidenceRefPrefix}/${filename}`);
  }
  return refs;
}

async function readOptionalFile(pathname: string): Promise<string | undefined> {
  try {
    return await fs.readFile(pathname, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** @internal Exported for deterministic deadline ownership tests. */
export async function runWithWorkflowDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("workflow_timeout"));
  }, timeoutMs);
  try {
    let result: T;
    try {
      result = await operation(controller.signal);
    } catch (error) {
      if (timedOut) {
        throw new EvalInfrastructureError(
          "workflow_timeout",
          "workflow_timeout",
          { cause: error },
        );
      }
      throw error;
    }
    if (timedOut) {
      throw new EvalInfrastructureError("workflow_timeout", "workflow_timeout");
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function withVerifierTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
