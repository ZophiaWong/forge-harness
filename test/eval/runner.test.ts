import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MinimalResponse,
  ResponseCreate,
  ResponseCreateRequest,
} from "../../src/core/minimalLoop.js";
import { aggregateAttempts } from "../../src/eval/aggregate.js";
import type { RunC17cRuntimeOptions } from "../../src/eval/c17c.js";
import { compareEvalSummary } from "../../src/eval/compare.js";
import { EvalInfrastructureError } from "../../src/eval/errors.js";
import * as evalRunnerModule from "../../src/eval/runner.js";
import {
  classifyEvalExecutionError,
  runEvalAttempt,
} from "../../src/eval/runner.js";
import type { EvalScenario } from "../../src/eval/scenario.js";
import { getEvalScenario } from "../../src/eval/scenarios.js";
import type { EvalAttemptResult, EvalSuiteSummary } from "../../src/eval/types.js";

const runC17cRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/eval/c17c.js", () => ({
  runC17cRuntime: runC17cRuntimeMock,
}));

const tempRoots: string[] = [];

afterEach(async () => {
  runC17cRuntimeMock.mockReset();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

function scriptedResponseCreate(responses: MinimalResponse[]): ResponseCreate & {
  calls: ResponseCreateRequest[];
} {
  const calls: ResponseCreateRequest[] = [];
  const create = vi.fn(async (request: ResponseCreateRequest) => {
    calls.push(request);
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected model request");
    }
    return response;
  }) as unknown as ResponseCreate & { calls: ResponseCreateRequest[] };
  create.calls = calls;
  return create;
}

function directlyObservedHardScenario(): EvalScenario {
  const base = getEvalScenario("governed-read-only");
  return {
    ...base,
    grade(evidence) {
      const mechanismExercised = evidence.sessions.some((session) => (
        session.events.some((event) => event.type === "tool_call")
      ));
      return {
        assertions: [{
          evidenceRefs: [],
          id: "direct-hard-evidence",
          kind: "hard",
          status: mechanismExercised ? "failed" : "unavailable",
        }],
        outcome: "unavailable",
      };
    },
  };
}

function compareAttempt(attempt: EvalAttemptResult) {
  const summary: EvalSuiteSummary = {
    aggregates: aggregateAttempts([attempt]),
    artifactType: "forge-eval-suite-summary",
    attempts: [attempt],
    canonical: false,
    diagnostics: {},
    generatedAt: "2026-08-04T00:00:00.000Z",
    identity: {
      endpointHash: "endpoint",
      fingerprint: "experiment",
      model: "gpt-test",
      providerId: "test",
      requestFingerprint: "request",
      suiteFingerprint: "suite",
    },
    issues: ["provider_error"],
    metrics: attempt.metrics,
    runId: "test-run",
    schemaVersion: 1,
    scope: "scenario",
    valid: false,
  };
  return compareEvalSummary(summary);
}

describe("eval attempt runner", () => {
  it("preserves the exact late provider rejection as the timeout cause", async () => {
    const runWithWorkflowDeadline = Reflect.get(
      evalRunnerModule,
      "runWithWorkflowDeadline",
    ) as undefined | (<T>(
      operation: (signal: AbortSignal) => Promise<T>,
      timeoutMs: number,
    ) => Promise<T>);
    expect(runWithWorkflowDeadline).toBeTypeOf("function");
    if (!runWithWorkflowDeadline) {
      return;
    }
    const providerError = new Error("late provider failure");
    const error = await runWithWorkflowDeadline(
      (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => reject(providerError), 5);
        }, { once: true });
      }),
      10,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvalInfrastructureError);
    expect(error).toMatchObject({
      cause: providerError,
      reasonCode: "workflow_timeout",
    });
  });

  it("does not invent a timeout cause when the operation resolves after abort", async () => {
    const runWithWorkflowDeadline = Reflect.get(
      evalRunnerModule,
      "runWithWorkflowDeadline",
    ) as undefined | (<T>(
      operation: (signal: AbortSignal) => Promise<T>,
      timeoutMs: number,
    ) => Promise<T>);
    expect(runWithWorkflowDeadline).toBeTypeOf("function");
    if (!runWithWorkflowDeadline) {
      return;
    }
    const error = await runWithWorkflowDeadline(
      (signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => resolve("late success"), 5);
        }, { once: true });
      }),
      10,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvalInfrastructureError);
    expect(error).toMatchObject({ reasonCode: "workflow_timeout" });
    expect(error).not.toHaveProperty("cause");
  });

  it("preserves a combined teammate and plugin cleanup aggregate as the timeout cause", async () => {
    const runWithWorkflowDeadline = Reflect.get(
      evalRunnerModule,
      "runWithWorkflowDeadline",
    ) as undefined | (<T>(
      operation: (signal: AbortSignal) => Promise<T>,
      timeoutMs: number,
    ) => Promise<T>);
    expect(runWithWorkflowDeadline).toBeTypeOf("function");
    if (!runWithWorkflowDeadline) {
      return;
    }
    const teammateError = new Error("teammate termination failed");
    const pluginError = new Error("plugin close failed");
    const cleanupError = new AggregateError(
      [teammateError, pluginError],
      "c17c cleanup failed",
    );
    const error = await runWithWorkflowDeadline(
      (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => reject(cleanupError), 5);
        }, { once: true });
      }),
      10,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvalInfrastructureError);
    expect(error).toMatchObject({
      cause: cleanupError,
      reasonCode: "workflow_timeout",
    });
    expect((error as Error & { cause: AggregateError }).cause.errors).toEqual([
      teammateError,
      pluginError,
    ]);
  });

  it("distinguishes a blocked verifier from a provider failure", () => {
    expect(classifyEvalExecutionError(new Error("Verification blocked."))).toEqual({
      reasonCode: "verifier_blocked",
      status: "invalid",
    });
    expect(classifyEvalExecutionError(new Error("verifier_timeout"))).toEqual({
      reasonCode: "verifier_timeout",
      status: "invalid",
    });
  });

  it("keeps an observed compaction failure in the behavioral grading path", () => {
    expect(classifyEvalExecutionError(new Error(
      "Context compaction failed: summary is missing required headings.",
    ))).toEqual({ status: "completed" });
  });

  it("drives a committed fixture through the production Runtime, trace, grader, and private evidence", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-runner-"));
    tempRoots.push(attemptRoot);
    const responseCreate = scriptedResponseCreate([
      {
        output: [{
          arguments: '{"path":"facts.txt"}',
          call_id: "call_read",
          name: "read",
          type: "function_call",
        }],
        output_text: "",
        telemetry: {
          durationMs: 7,
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        },
      },
      {
        output: [],
        output_text: "RELEASE_CHANNEL=stable",
        telemetry: {
          durationMs: 5,
          usage: { inputTokens: 120, outputTokens: 5, totalTokens: 125 },
        },
      },
    ]);

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/governed-read-only/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario: getEvalScenario("governed-read-only"),
    });

    expect(result.attempt).toMatchObject({
      attemptId: "governed-read-only-1",
      execution: { status: "completed" },
      metrics: {
        callCount: 2,
        duration: { knownCalls: 2, status: "complete", totalMs: 12 },
        tokens: {
          knownCalls: 2,
          status: "complete",
          totals: { inputTokens: 220, outputTokens: 15, totalTokens: 235 },
        },
      },
      outcome: "passed",
      scenarioId: "governed-read-only",
    });
    expect(result.attempt.assertions.every((assertion) => assertion.status === "passed")).toBe(true);
    expect(result.attempt.evidenceRefs).toEqual([
      "attempts/governed-read-only/1/grade.json",
      "attempts/governed-read-only/1/root-trace.jsonl",
    ]);
    expect(await fs.readFile(path.join(attemptRoot, "grade.json"), "utf8")).toContain("final-exact");
    expect(await fs.readFile(path.join(attemptRoot, "root-trace.jsonl"), "utf8")).toContain(
      '"type":"permission_decision"',
    );
    expect(responseCreate.calls[0]?.tools.map((tool) => tool.name)).toContain("read");
  });

  it("classifies provider failure as invalid without fabricating a hard regression", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-invalid-"));
    tempRoots.push(attemptRoot);
    const responseCreate: ResponseCreate = async () => {
      throw new Error("401 invalid api key");
    };

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/compaction-retention/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario: getEvalScenario("compaction-retention"),
    });

    expect(result.attempt).toMatchObject({
      execution: { reasonCode: "provider_error", status: "invalid" },
      outcome: "unavailable",
    });
    expect(result.attempt.assertions.filter((assertion) => assertion.kind === "hard"))
      .not.toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("preserves directly observed hard failure through provider invalidation and comparison", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-direct-hard-"));
    tempRoots.push(attemptRoot);
    let call = 0;
    const responseCreate: ResponseCreate = async () => {
      call += 1;
      if (call === 1) {
        return {
          output: [{
            arguments: '{"path":"facts.txt"}',
            call_id: "observe-hard-evidence",
            name: "read",
            type: "function_call",
          }],
          output_text: "",
        };
      }
      throw new Error("provider failed after direct hard evidence");
    };

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/governed-read-only/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario: directlyObservedHardScenario(),
    });

    expect(result.attempt).toMatchObject({
      assertions: [expect.objectContaining({
        id: "direct-hard-evidence",
        status: "failed",
      })],
      execution: { reasonCode: "provider_error", status: "invalid" },
      outcome: "unavailable",
    });
    expect(compareAttempt(result.attempt)).toMatchObject({
      exitCode: 1,
      verdict: "REGRESSED",
    });
  });

  it("keeps hard evidence unavailable when provider failure precedes mechanism exercise", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-no-hard-evidence-"));
    tempRoots.push(attemptRoot);
    const responseCreate: ResponseCreate = async () => {
      throw new Error("provider failed before direct hard evidence");
    };

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/governed-read-only/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario: directlyObservedHardScenario(),
    });

    expect(result.attempt).toMatchObject({
      assertions: [expect.objectContaining({
        id: "direct-hard-evidence",
        status: "unavailable",
      })],
      execution: { reasonCode: "provider_error", status: "invalid" },
      outcome: "unavailable",
    });
    expect(compareAttempt(result.attempt)).toMatchObject({
      exitCode: 2,
      verdict: "INVALID",
    });
  });

  it("preserves a provider setup error when the Runtime trace is still empty", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-no-key-"));
    tempRoots.push(attemptRoot);

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/governed-read-only/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      scenario: getEvalScenario("governed-read-only"),
    });

    expect(result.attempt).toMatchObject({
      execution: { reasonCode: "provider_error", status: "invalid" },
      outcome: "unavailable",
    });
    expect(result.sessions).toEqual([expect.objectContaining({
      events: [],
      role: "root",
    })]);
    expect(result.attempt.evidenceRefs).toContain(
      "attempts/governed-read-only/1/root-trace.jsonl",
    );
  });

  it("awaits aborted workflow teardown before returning timeout evidence", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-timeout-"));
    tempRoots.push(attemptRoot);
    const base = getEvalScenario("governed-read-only");
    const events: string[] = [];
    const scenario = {
      ...base,
      manifest: {
        ...base.manifest,
        runtime: { ...base.manifest.runtime, workflowTimeoutMs: 100 },
      },
    };
    const responseCreate: ResponseCreate = async (_request, options) => (
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          events.push("aborted");
          setTimeout(() => {
            events.push("settled");
            reject(options.signal?.reason);
          }, 5);
        }, { once: true });
      })
    );

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/governed-read-only/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario,
    });
    events.push("returned");

    expect(result.attempt.execution).toEqual({
      reasonCode: "workflow_timeout",
      status: "invalid",
    });
    expect(events).toEqual(["aborted", "settled", "returned"]);
    expect(result.sessions[0]?.events.at(-1)).toMatchObject({
      status: "failed",
      type: "session_ended",
    });
  });

  it("keeps timeout ownership when the aborted model resolves later", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-timeout-resolve-"));
    tempRoots.push(attemptRoot);
    const base = getEvalScenario("governed-read-only");
    const events: string[] = [];
    const markerPath = path.join(attemptRoot, "workspace", "teardown.marker");
    const scenario = {
      ...base,
      manifest: {
        ...base.manifest,
        runtime: { ...base.manifest.runtime, workflowTimeoutMs: 100 },
      },
    };
    const responseCreate: ResponseCreate = async (_request, options) => (
      new Promise((resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          events.push("aborted");
          setTimeout(() => {
            void fs.writeFile(markerPath, "settled\n", "utf8").then(() => {
              events.push("settled");
              resolve({ output: [], output_text: "late success" });
            }, reject);
          }, 5);
        }, { once: true });
      })
    );

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/governed-read-only/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario,
    });
    events.push("returned");
    const grade = JSON.parse(await fs.readFile(path.join(attemptRoot, "grade.json"), "utf8")) as {
      git: { after: { statusEntries: string[] } };
    };

    expect(result.attempt.execution).toEqual({
      reasonCode: "workflow_timeout",
      status: "invalid",
    });
    expect(events).toEqual(["aborted", "settled", "returned"]);
    expect(grade.git.after.statusEntries).toContain("?? teardown.marker");
  });

  it("keeps timeout ownership when the aborted model rejects with another error", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-timeout-reject-"));
    tempRoots.push(attemptRoot);
    const base = getEvalScenario("governed-read-only");
    const events: string[] = [];
    const scenario = {
      ...base,
      manifest: {
        ...base.manifest,
        runtime: { ...base.manifest.runtime, workflowTimeoutMs: 100 },
      },
    };
    const responseCreate: ResponseCreate = async (_request, options) => (
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          events.push("aborted");
          setTimeout(() => {
            events.push("rejected");
            reject(new Error("late provider failure"));
          }, 5);
        }, { once: true });
      })
    );

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/governed-read-only/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario,
    });
    events.push("returned");

    expect(result.attempt.execution).toEqual({
      reasonCode: "workflow_timeout",
      status: "invalid",
    });
    expect(events).toEqual(["aborted", "rejected", "returned"]);
  });

  it("clears the losing deadline and reuses one root signal", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-deadline-loses-"));
    tempRoots.push(attemptRoot);
    const base = getEvalScenario("governed-read-only");
    const observedSignals: AbortSignal[] = [];
    let aborted = false;
    let round = 0;
    const scenario = {
      ...base,
      manifest: {
        ...base.manifest,
        runtime: { ...base.manifest.runtime, workflowTimeoutMs: 50 },
      },
    };
    const responseCreate: ResponseCreate = async (_request, options) => {
      if (!options?.signal) {
        throw new Error("missing root workflow signal");
      }
      observedSignals.push(options.signal);
      options.signal.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      round += 1;
      return round === 1
        ? {
            output: [{
              arguments: '{"path":"facts.txt"}',
              call_id: "call_read",
              name: "read",
              type: "function_call",
            }],
            output_text: "",
          }
        : { output: [], output_text: "RELEASE_CHANNEL=stable" };
    };

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/governed-read-only/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(result.attempt.execution).toEqual({ status: "completed" });
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals[1]).toBe(observedSignals[0]);
    expect(aborted).toBe(false);
  });

  it("passes the c17c deadline signal and awaits its abort cleanup", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-c17c-timeout-"));
    tempRoots.push(attemptRoot);
    const base = getEvalScenario("c17c-team-completion");
    const events: string[] = [];
    const scenario = {
      ...base,
      manifest: {
        ...base.manifest,
        runtime: { ...base.manifest.runtime, workflowTimeoutMs: 10 },
      },
    };
    let runtimeSignal: AbortSignal | undefined;
    runC17cRuntimeMock.mockImplementation(async (runtimeOptions: RunC17cRuntimeOptions) => {
      runtimeSignal = runtimeOptions.signal;
      if (!runtimeSignal) {
        throw new Error("missing c17c workflow signal");
      }
      return new Promise((_resolve, reject) => {
        runtimeSignal?.addEventListener("abort", () => {
          events.push("aborted");
          setTimeout(() => {
            events.push("teammates_terminated");
            events.push("plugin_closed");
            reject(new Error("late c17c cleanup failure"));
          }, 5);
        }, { once: true });
      });
    });

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/c17c-team-completion/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate: async () => ({ output: [], output_text: "unused" }),
      scenario,
    });
    events.push("returned");

    expect(runtimeSignal).toBeDefined();
    expect(result.attempt.execution).toEqual({
      reasonCode: "workflow_timeout",
      status: "invalid",
    });
    expect(events).toEqual([
      "aborted",
      "teammates_terminated",
      "plugin_closed",
      "returned",
    ]);
  });

  it("runs the deterministic verifier failure and one Runtime recovery", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-recovery-"));
    tempRoots.push(attemptRoot);
    const responseCreate = scriptedResponseCreate([
      { output: [], output_text: "RECOVERY_OK" },
      { output: [], output_text: "RECOVERY_OK" },
    ]);

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/verification-recovery/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario: getEvalScenario("verification-recovery"),
    });

    expect(result.attempt.outcome).toBe("passed");
    expect(result.sessions[0]?.events.filter((event) => event.type === "recovery_attempt")).toHaveLength(1);
    await expect(fs.stat(path.join(attemptRoot, "private", "recovery.marker"))).resolves.toBeDefined();
  });

  it("observes automatic compaction while retaining the pinned task", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-compaction-"));
    tempRoots.push(attemptRoot);
    let normalRound = 0;
    const paths = ["alpha.txt", "bravo.txt", "charlie.txt"];
    const responseCreate: ResponseCreate = async (request) => {
      if (request.tools.length === 0) {
        return {
          output: [],
          output_text: [
            "## Task",
            "retain all tokens",
            "## Progress",
            "read alpha and bravo",
            "## Evidence",
            "FORGE-COMPACTION-7319 BRAVO-204",
            "## Open Questions",
            "none",
            "## Next Step",
            "read charlie",
          ].join("\n"),
        };
      }
      const current = normalRound;
      normalRound += 1;
      if (current < paths.length) {
        return {
          output: [{
            arguments: JSON.stringify({ path: paths[current] }),
            call_id: `read_${current}`,
            name: "read",
            type: "function_call",
          }],
          output_text: "",
        };
      }
      return {
        output: [],
        output_text: "FORGE-COMPACTION-7319 BRAVO-204 CHARLIE-518",
      };
    };

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/compaction-retention/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario: getEvalScenario("compaction-retention"),
    });

    expect(result.attempt.outcome).toBe("passed");
    expect(result.attempt.assertions).toContainEqual(expect.objectContaining({
      id: "pinned-task-retained",
      status: "passed",
    }));
    expect(result.sessions[0]?.events.some((event) => event.type === "context_compacted")).toBe(true);
  });

  it("uses the production asynchronous child runner and collects its separate trace", async () => {
    const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-async-child-"));
    tempRoots.push(attemptRoot);
    let rootRound = 0;
    let childRound = 0;
    const responseCreate: ResponseCreate = async (request) => {
      const pinned = request.input[0];
      const isChild = pinned !== undefined
        && "content" in pinned
        && typeof pinned.content === "string"
        && pinned.content.includes("fresh research child session");
      if (isChild) {
        const current = childRound;
        childRound += 1;
        return current === 0
          ? {
              output: [{
                arguments: '{"path":"child.txt"}',
                call_id: "child_read",
                name: "read",
                type: "function_call",
              }],
              output_text: "",
            }
          : { output: [], output_text: "CHILD_TOKEN=delta" };
      }
      const current = rootRound;
      rootRound += 1;
      if (current === 0) {
        return {
          output: [{
            arguments: '{"path":"parent.txt"}',
            call_id: "parent_read",
            name: "read",
            type: "function_call",
          }],
          output_text: "",
        };
      }
      if (current === 1) {
        return {
          output: [{
            arguments: JSON.stringify({
              maxToolRounds: 4,
              profile: "research",
              runInBackground: true,
              task: "Read child.txt and return only CHILD_TOKEN=delta.",
              taskId: null,
            }),
            call_id: "delegate_child",
            name: "delegate",
            type: "function_call",
          }],
          output_text: "",
        };
      }
      if (current === 2) {
        return { output: [], output_text: "waiting for child" };
      }
      return { output: [], output_text: "PARENT_TOKEN=alpha CHILD_TOKEN=delta" };
    };

    const result = await runEvalAttempt({
      attemptRoot,
      evidenceRefPrefix: "attempts/async-child-handoff/1",
      model: "gpt-test",
      ordinal: 1,
      repositoryRoot: process.cwd(),
      responseCreate,
      scenario: getEvalScenario("async-child-handoff"),
    });

    expect(result.attempt.outcome).toBe("passed");
    expect(result.sessions.map((session) => session.role)).toEqual(["root", "child"]);
    expect(result.attempt.evidenceRefs).toContain("attempts/async-child-handoff/1/child-1-trace.jsonl");
  });
});
