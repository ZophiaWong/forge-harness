import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type {
  PluginMcpSessionLike,
  StartApprovedPluginMcpOptions,
} from "../../src/extensions/pluginActivation.js";
import type { TeammateManager } from "../../src/extensions/teammates.js";
import { createCliSessionTrace } from "../../src/runtime/session.js";
import { runC17cRuntime } from "../../src/eval/c17c.js";
import { readEvalTrace } from "../../src/eval/evidence.js";
import { createEvalFixture } from "../../src/eval/fixture.js";
import { runEvalAttempt, runWithWorkflowDeadline } from "../../src/eval/runner.js";
import {
  C17C_ARTIFACT_CONTENT,
  C17C_ARTIFACT_PATH,
  getEvalScenario,
} from "../../src/eval/scenarios.js";

const startApprovedPluginMcpServersMock = vi.hoisted(() => vi.fn());
const createTeammateManagerMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/extensions/pluginActivation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/extensions/pluginActivation.js")>()),
  startApprovedPluginMcpServers: startApprovedPluginMcpServersMock,
}));

vi.mock("../../src/extensions/teammates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/extensions/teammates.js")>()),
  createTeammateManager: createTeammateManagerMock,
}));

const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  startApprovedPluginMcpServersMock.mockReset();
  createTeammateManagerMock.mockReset();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

it("owns plugin cleanup when an activation-event await rejects after abort", async () => {
  const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-c17c-cleanup-"));
  tempRoots.push(attemptRoot);
  const scenario = getEvalScenario("c17c-team-completion");
  const fixture = await createEvalFixture({
    attemptRoot,
    repositoryRoot: process.cwd(),
    scenario,
  });
  const trace = await createCliSessionTrace({
    cwd: fixture.cwd,
    maxToolRounds: scenario.manifest.runtime.rootMaxToolRounds,
    model: "gpt-test",
    task: scenario.manifest.task,
  });
  const controller = new AbortController();
  const activationError = new Error("activation event rejected after abort");
  const closeGate = deferred<void>();
  const events: string[] = [];
  let settled = false;
  const recorder = trace.recorder;
  trace.recorder = {
    async record(event) {
      await recorder.record(event);
      if (event.type === "plugin_activation_result") {
        events.push("activation_event");
        controller.abort(new Error("workflow_timeout"));
        throw activationError;
      }
    },
  };
  startApprovedPluginMcpServersMock.mockImplementation(async ({
    decisions,
  }: StartApprovedPluginMcpOptions) => {
    const plugin = decisions.find((decision) => decision.descriptor.name === "issue-workflow");
    const descriptor = plugin?.descriptor.mcpServers.find((server) => (
      server.server.id === "issue-workflow-demo"
    ));
    if (!plugin || !descriptor) {
      throw new Error("missing canonical issue-workflow descriptor");
    }
    const session = fakeSession();
    return {
      async close() {
        events.push("plugin_close_started");
        await closeGate.promise;
        events.push("plugin_close_settled");
      },
      servers: [{
        descriptor,
        diagnostics: session.diagnostics,
        pluginName: plugin.descriptor.name,
        session,
        status: "active" as const,
      }],
      sessions: [session],
    };
  });

  const running = runC17cRuntime({
    approver: { async approve() { return { approved: false }; } },
    model: "gpt-test",
    responseCreate: async () => ({ output: [], output_text: "unused" }),
    rootTrace: trace,
    scenario,
    signal: controller.signal,
    workspace: fixture.cwd,
  });
  void running.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  await vi.waitFor(() => {
    expect(events).toContain("plugin_close_started");
  });
  expect(settled).toBe(false);
  closeGate.resolve();

  await expect(running).rejects.toBe(activationError);
  expect(events).toEqual([
    "activation_event",
    "plugin_close_started",
    "plugin_close_settled",
  ]);
});

it("keeps a completed root terminal while preserving later orchestration and cleanup failures", async () => {
  const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-c17c-layered-"));
  tempRoots.push(attemptRoot);
  const scenario = getEvalScenario("c17c-team-completion");
  const fixture = await createEvalFixture({
    attemptRoot,
    repositoryRoot: process.cwd(),
    scenario,
  });
  await fs.writeFile(
    path.join(fixture.cwd, C17C_ARTIFACT_PATH),
    C17C_ARTIFACT_CONTENT,
    "utf8",
  );
  const trace = await createCliSessionTrace({
    cwd: fixture.cwd,
    maxToolRounds: scenario.manifest.runtime.rootMaxToolRounds,
    model: "gpt-test",
    task: scenario.manifest.task,
  });
  const orchestrationError = new Error("post-root orchestration failed after abort");
  const teammateError = new Error("teammate termination failed");
  const pluginError = new Error("plugin close failed");
  const teammateCleanupError = new AggregateError([teammateError], "teammate cleanup failed");
  const pluginCleanupError = new AggregateError([pluginError], "plugin cleanup failed");
  const cleanupEvents: string[] = [];
  let flushCount = 0;
  const manager = fakeTeammateManager({
    async flushEvents() {
      flushCount += 1;
      if (flushCount !== 1) {
        return;
      }
      vi.advanceTimersByTime(100);
      throw orchestrationError;
    },
    async terminateAll() {
      cleanupEvents.push("teammates_terminated");
      throw teammateCleanupError;
    },
  });
  createTeammateManagerMock.mockReturnValue(manager);
  startApprovedPluginMcpServersMock.mockImplementation(async ({
    decisions,
  }: StartApprovedPluginMcpOptions) => {
    const plugin = decisions.find((decision) => decision.descriptor.name === "issue-workflow");
    const descriptor = plugin?.descriptor.mcpServers.find((server) => (
      server.server.id === "issue-workflow-demo"
    ));
    if (!plugin || !descriptor) {
      throw new Error("missing canonical issue-workflow descriptor");
    }
    const session = fakeSession();
    return {
      async close() {
        cleanupEvents.push("plugin_closed");
        throw pluginCleanupError;
      },
      servers: [{
        descriptor,
        diagnostics: session.diagnostics,
        pluginName: plugin.descriptor.name,
        session,
        status: "active" as const,
      }],
      sessions: [session],
    };
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const error = await runWithWorkflowDeadline((signal) => (
    runC17cRuntime({
      approver: { async approve() { return { approved: false }; } },
      model: "gpt-test",
      responseCreate: async () => ({ output: [], output_text: "root completed" }),
      rootTrace: trace,
      scenario,
      signal,
      workspace: fixture.cwd,
    })
  ), 100).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ reasonCode: "workflow_timeout" });
  const c17cFailure = (error as Error & { cause: AggregateError }).cause;
  expect(c17cFailure).toBeInstanceOf(AggregateError);
  expect(c17cFailure.errors).toEqual([
    orchestrationError,
    teammateCleanupError,
    pluginCleanupError,
  ]);
  expect(cleanupEvents).toEqual(["teammates_terminated", "plugin_closed"]);

  const terminalEvents = (await readEvalTrace(trace.paths.tracePath)).filter((event) => (
    event.type === "session_ended"
  ));
  expect(terminalEvents).toEqual([
    expect.objectContaining({ status: "completed", type: "session_ended" }),
  ]);
});

it("reports a later c17c timeout without fabricating a second root terminal", async () => {
  const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-eval-c17c-attempt-layered-"));
  tempRoots.push(attemptRoot);
  const base = getEvalScenario("c17c-team-completion");
  const scenario = {
    ...base,
    manifest: {
      ...base.manifest,
      runtime: { ...base.manifest.runtime, workflowTimeoutMs: 100 },
    },
  };
  const orchestrationError = new Error("post-root orchestration timed out");
  let flushCount = 0;
  createTeammateManagerMock.mockReturnValue(fakeTeammateManager({
    async flushEvents() {
      flushCount += 1;
      if (flushCount !== 1) {
        return;
      }
      vi.advanceTimersByTime(scenario.manifest.runtime.workflowTimeoutMs);
      throw orchestrationError;
    },
  }));
  startApprovedPluginMcpServersMock.mockImplementation(async ({
    decisions,
  }: StartApprovedPluginMcpOptions) => {
    const plugin = decisions.find((decision) => decision.descriptor.name === "issue-workflow");
    const descriptor = plugin?.descriptor.mcpServers.find((server) => (
      server.server.id === "issue-workflow-demo"
    ));
    if (!plugin || !descriptor) {
      throw new Error("missing canonical issue-workflow descriptor");
    }
    const session = fakeSession();
    return {
      async close() {},
      servers: [{
        descriptor,
        diagnostics: session.diagnostics,
        pluginName: plugin.descriptor.name,
        session,
        status: "active" as const,
      }],
      sessions: [session],
    };
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = await runEvalAttempt({
    attemptRoot,
    evidenceRefPrefix: "attempts/c17c-team-completion/1",
    model: "gpt-test",
    ordinal: 1,
    repositoryRoot: process.cwd(),
    responseCreate: async () => {
      await fs.writeFile(
        path.join(attemptRoot, "workspace", C17C_ARTIFACT_PATH),
        C17C_ARTIFACT_CONTENT,
        "utf8",
      );
      return { output: [], output_text: "root completed" };
    },
    scenario,
  });

  expect(result.attempt.execution).toEqual({
    reasonCode: "workflow_timeout",
    status: "invalid",
  });
  expect(result.sessions[0]?.events.filter((event) => event.type === "session_ended")).toEqual([
    expect.objectContaining({ status: "completed", type: "session_ended" }),
  ]);
});

function fakeSession(): PluginMcpSessionLike {
  return {
    async close() {},
    diagnostics: {
      deniedToolNames: [],
      discoveredToolNames: ["lookup_issue"],
      exposedToolNames: ["mcp_issue-workflow-demo_lookup_issue"],
      extraToolNames: [],
      incompatibleTools: [],
      missingToolNames: [],
    },
    async execute(toolCall) {
      return { content: "unused", status: "blocked", toolName: toolCall.name };
    },
    permissionPolicies: new Map(),
    toolDefinitions: () => [],
  };
}

function fakeTeammateManager(
  overrides: Partial<TeammateManager> = {},
): TeammateManager {
  const unused = async (): Promise<never> => {
    throw new Error("unused teammate operation");
  };
  return {
    broadcast: unused,
    async close() {},
    async drainLeaderMessages() { return []; },
    async flushEvents() {},
    async initialize() {},
    async list() { return []; },
    rejoin: unused,
    resolveAssignee: unused,
    resolveEditSource: unused,
    sendMessage: unused,
    async settleBeforeFinal() { return []; },
    shutdown: unused,
    start: unused,
    async terminateAll() {},
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
