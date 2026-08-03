import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MinimalResponse,
  ResponseCreate,
  ResponseCreateRequest,
} from "../../src/core/minimalLoop.js";
import {
  classifyEvalExecutionError,
  runEvalAttempt,
} from "../../src/eval/runner.js";
import { getEvalScenario } from "../../src/eval/scenarios.js";

const tempRoots: string[] = [];

afterEach(async () => {
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

describe("eval attempt runner", () => {
  it("distinguishes a blocked verifier from a provider failure", () => {
    expect(classifyEvalExecutionError(new Error("Verification blocked."))).toEqual({
      reasonCode: "verifier_blocked",
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
