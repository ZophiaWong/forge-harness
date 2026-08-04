import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLifecycleEmitter } from "../../src/extensions/lifecycle.js";
import {
  createTeammateManager,
  type CreateTeammateManagerOptions,
  type LeaderToTeammateMessage,
  type TeammateProcess,
  type TeammateProcessAdapter,
  type TeammateToLeaderMessage,
} from "../../src/extensions/teammates.js";
import {
  createNoopTraceRecorder,
  type TraceEventPayload,
  type TraceRecorder,
} from "../../src/runtime/trace.js";
import {
  createFileMailboxStore,
  type MailboxStore,
} from "../../src/runtime/teamMailbox.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TeammateManager", () => {
  it("serializes caller-provided permission rules into the worker config", async () => {
    const fixture = await createFixture(["session-a"], {
      workerPermissionRules: (definition) => [{
        arguments: { id: definition.name === "researcher" ? "task_002" : "never" },
        name: "task_get",
      }],
    });

    const started = fixture.manager.start({
      instructions: "Research only the assigned task.",
      message: "Remain idle.",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();

    expect(process.sent[0]).toMatchObject({
      config: {
        permissionRules: [{ arguments: { id: "task_002" }, name: "task_get" }],
      },
      type: "initialize",
    });
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;
  });

  it("persists a stable definition, waits for ready, and dispatches the claimed first batch", async () => {
    const fixture = await createFixture(["session-a"]);

    const started = fixture.manager.start({
      instructions: "Investigate repository behavior.",
      message: "Inspect the task graph.",
      name: "repo-researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    expect(process.sent).toHaveLength(1);
    expect(process.sent[0]).toMatchObject({
      sessionId: "session-a",
      type: "initialize",
    });

    process.emit({ sessionId: "session-a", type: "ready" });

    await expect(started).resolves.toMatchObject({
      name: "repo-researcher",
      sessionId: "session-a",
      state: "busy",
    });
    expect(process.sent[1]).toMatchObject({
      messages: [
        expect.objectContaining({
          content: "Inspect the task graph.",
          from: "leader",
          kind: "direct",
        }),
      ],
      sessionId: "session-a",
      type: "run_batch",
    });

    const definition = JSON.parse(await fs.readFile(
      path.join(
        fixture.teamRoot,
        "teammates",
        "repo-researcher",
        "definition.json",
      ),
      "utf8",
    ));
    expect(definition).toMatchObject({
      instructions: "Investigate repository behavior.",
      maxToolRounds: 48,
      name: "repo-researcher",
      profile: "research",
    });
    expect(await fixture.manager.list()).toEqual([
      expect.objectContaining({
        name: "repo-researcher",
        sessionId: "session-a",
        state: "busy",
        unreadCount: 0,
      }),
    ]);
  });

  it("queues while busy, persists turn_result before waking the next FIFO batch, and fences old sessions", async () => {
    const fixture = await createFixture(["session-a"]);
    const start = fixture.manager.start({
      instructions: "Keep researching.",
      message: "first",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await start;

    await expect(fixture.manager.sendMessage({
      content: "second",
      from: "leader",
      to: "researcher",
    })).resolves.toMatchObject({ delivery: "queued_busy" });

    process.emit({
      finalAnswer: "first result",
      sessionId: "session-a",
      type: "turn_result",
    });
    await fixture.manager.flushEvents();

    expect(process.sent.at(-1)).toMatchObject({
      messages: [expect.objectContaining({ content: "second" })],
      type: "run_batch",
    });
    expect((await fixture.manager.drainLeaderMessages()).map((message) => message.kind))
      .toEqual(["turn_result"]);

    process.emit({
      finalAnswer: "stale",
      sessionId: "old-session",
      type: "turn_result",
    });
    await fixture.manager.flushEvents();
    expect(await fixture.manager.drainLeaderMessages()).toEqual([]);
  });

  it("emits one idle transition when a completed turn has no unread follow-up", async () => {
    const events: TraceEventPayload[] = [];
    const logs: string[] = [];
    const recorder: TraceRecorder = {
      async record(event) {
        events.push(event);
      },
    };
    const fixture = await createFixture(["session-a"], {
      lifecycleEmitter: createLifecycleEmitter({ recorder }),
      onLog(message) {
        logs.push(message);
      },
    });
    const started = fixture.manager.start({
      instructions: "Keep researching.",
      message: "first",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;

    process.emit({
      finalAnswer: "first result",
      sessionId: "session-a",
      type: "turn_result",
    });
    await fixture.manager.flushEvents();

    expect(events.filter(
      (event) => event.type === "teammate_state_changed" && event.state === "idle",
    )).toEqual([
      expect.objectContaining({
        previousState: "busy",
        state: "idle",
      }),
    ]);
    expect(logs.filter((message) => message.includes("state=idle"))).toEqual([
      "[team] name=researcher state=idle session=session-a",
    ]);
    await expect(fixture.manager.list()).resolves.toEqual([
      expect.objectContaining({ name: "researcher", state: "idle" }),
    ]);
  });

  it("keeps a failed member offline, does not replay its claimed batch, and rejoin uses recovery first", async () => {
    const fixture = await createFixture(["session-a", "session-b"]);
    const start = fixture.manager.start({
      instructions: "Keep a durable conversation.",
      message: "claimed and then failed",
      name: "researcher",
      profile: "research",
    });
    const firstProcess = await fixture.adapter.nextProcess();
    firstProcess.emit({ sessionId: "session-a", type: "ready" });
    await start;

    firstProcess.emit({
      reason: "model request failed",
      sessionId: "session-a",
      type: "failure",
    });
    await fixture.manager.flushEvents();
    await expect(fixture.manager.sendMessage({
      content: "queued while offline",
      from: "leader",
      to: "researcher",
    })).resolves.toMatchObject({ delivery: "queued_offline" });

    const rejoined = fixture.manager.rejoin({
      name: "researcher",
      recovery: "Use the queued request and continue.",
    });
    const secondProcess = await fixture.adapter.nextProcess();
    secondProcess.emit({ sessionId: "session-b", type: "ready" });

    await expect(rejoined).resolves.toMatchObject({
      sessionId: "session-b",
      state: "busy",
    });
    expect(secondProcess.sent.at(-1)).toMatchObject({
      messages: [
        expect.objectContaining({ content: "Use the queued request and continue." }),
        expect.objectContaining({ content: "queued while offline" }),
      ],
      sessionId: "session-b",
      type: "run_batch",
    });
    expect(JSON.stringify(secondProcess.sent.at(-1))).not.toContain("claimed and then failed");
    expect((await fixture.manager.drainLeaderMessages()).map((message) => message.kind))
      .toEqual(["failure_notice"]);
  });

  it("blocks an in-progress task when its teammate owner fails", async () => {
    const fixture = await createOwnedResearchTaskFixture("in_progress");

    fixture.process.emit({
      reason: "model request failed",
      sessionId: "session-a",
      type: "failure",
    });
    await fixture.manager.flushEvents();

    await expect(fixture.taskStore.get("task_001")).resolves.toMatchObject({
      task: {
        blocker: { code: "owner_failed" },
        status: "blocked",
      },
    });
  });

  it("preserves a submitted task for Leader review when its teammate owner fails", async () => {
    const fixture = await createOwnedResearchTaskFixture("submitted");

    fixture.process.emit({
      reason: "final response exceeded the round budget",
      sessionId: "session-a",
      type: "failure",
    });
    await fixture.manager.flushEvents();

    await expect(fixture.taskStore.get("task_001")).resolves.toMatchObject({
      availableActions: ["review_result", "block", "submit_handoff"],
      task: {
        status: "submitted",
        submission: {
          submittedBy: {
            name: "researcher",
            role: "teammate",
            sessionId: "session-a",
          },
        },
      },
    });
    await expect(fixture.taskStore.transition(
      { role: "leader", sessionId: "root-session" },
      {
        action: "review_result",
        decision: "pass",
        id: "task_001",
        reason: "The durable submission remains reviewable.",
      },
    )).resolves.toMatchObject({
      task: { status: "completed" },
    });
  });

  it("broadcasts to a fixed snapshot without rolling back successful deliveries", async () => {
    const fixture = await createFixture(["session-a", "session-b"]);
    for (const name of ["alpha", "beta"]) {
      const started = fixture.manager.start({
        instructions: `Act as ${name}.`,
        message: "initial",
        name,
        profile: "research",
      });
      const process = await fixture.adapter.nextProcess();
      process.emit({
        sessionId: name === "alpha" ? "session-a" : "session-b",
        type: "ready",
      });
      await started;
    }

    const result = await fixture.manager.broadcast({
      content: "shared update",
      from: "leader",
    });

    expect(result.delivered.map((delivery) => delivery.to)).toEqual(["alpha", "beta"]);
    expect(result.failed).toEqual([]);
    expect((await fixture.manager.list()).map((member) => member.unreadCount)).toEqual([1, 1]);
  });

  it("reports partial broadcast delivery without rolling back earlier inbox appends", async () => {
    const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-teammates-partial-"));
    const teamRoot = path.join(baseCwd, "team");
    const backing = createFileMailboxStore({ teamRoot });
    const mailboxStore: MailboxStore = {
      ...backing,
      async append(input) {
        if (input.kind === "broadcast" && input.to === "beta") {
          throw new Error("simulated beta mailbox failure");
        }
        return backing.append(input);
      },
    };
    const adapter = new FakeProcessAdapter();
    const sessionIds = ["session-a", "session-b"];
    const manager = createTeammateManager({
      baseCwd,
      lifecycleEmitter: createLifecycleEmitter({ recorder: createNoopTraceRecorder() }),
      mailboxStore,
      processAdapter: adapter,
      rootSessionId: "root-session",
      sessionId: () => sessionIds.shift() as string,
      teamRoot,
    });
    await manager.initialize();
    for (const [name, sessionId] of [["alpha", "session-a"], ["beta", "session-b"]] as const) {
      const started = manager.start({
        instructions: name,
        message: "initial",
        name,
        profile: "research",
      });
      const process = await adapter.nextProcess();
      process.emit({ sessionId, type: "ready" });
      await started;
    }

    await expect(manager.broadcast({
      content: "shared update",
      from: "leader",
    })).resolves.toEqual({
      delivered: [expect.objectContaining({ to: "alpha" })],
      failed: [{
        reason: "simulated beta mailbox failure",
        to: "beta",
      }],
    });
    expect((await manager.list()).map(({ name, unreadCount }) => ({ name, unreadCount })))
      .toEqual([
        { name: "alpha", unreadCount: 1 },
        { name: "beta", unreadCount: 0 },
      ]);
  });

  it("keeps failed members inside the eight-member root limit", async () => {
    const sessionIds = Array.from({ length: 8 }, (_, index) => `session-${index + 1}`);
    const fixture = await createFixture(sessionIds);
    const processes: FakeTeammateProcess[] = [];

    for (let index = 1; index <= 8; index += 1) {
      const started = fixture.manager.start({
        instructions: `member ${index}`,
        message: "initial",
        name: `member-${index}`,
        profile: "research",
      });
      const process = await fixture.adapter.nextProcess();
      processes.push(process);
      process.emit({ sessionId: `session-${index}`, type: "ready" });
      await started;
    }
    processes[0]?.emit({
      reason: "failed but still registered",
      sessionId: "session-1",
      type: "failure",
    });
    await fixture.manager.flushEvents();

    await expect(fixture.manager.start({
      instructions: "ninth",
      message: "initial",
      name: "member-9",
      profile: "research",
    })).rejects.toThrow("at most 8 teammates");
  });

  it("lets the final gate consume a failure notice and then quiesce", async () => {
    const fixture = await createFixture(["session-a"]);
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;
    process.emit({
      reason: "provider unavailable",
      sessionId: "session-a",
      type: "failure",
    });

    await expect(fixture.manager.settleBeforeFinal()).resolves.toEqual([
      expect.objectContaining({ kind: "failure_notice" }),
    ]);
    await expect(fixture.manager.settleBeforeFinal()).resolves.toEqual([]);
  });

  it("gracefully shuts down idle workers without leaving the process live", async () => {
    const fixture = await createFixture(["session-a"]);
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;
    process.emit({
      finalAnswer: "done",
      sessionId: "session-a",
      type: "turn_result",
    });
    await fixture.manager.flushEvents();

    const closing = fixture.manager.close();
    await process.waitForSent("shutdown");
    process.exit(0, null);
    await closing;

    expect(process.kill).not.toHaveBeenCalled();
    expect(await fixture.manager.list()).toEqual([
      expect.objectContaining({ state: "stopped" }),
    ]);
  });

  it("awaits every forced member and final cleanup before aggregating failures", async () => {
    const firstCleanupError = new Error("alpha stopped trace failed");
    const cleanupEvents: TraceEventPayload[] = [];
    let failAlphaTrace = true;
    const fixture = await createFixture(["session-alpha", "session-beta"], {
      lifecycleEmitter: {
        async emit(event) {
          cleanupEvents.push(event);
          if (
            failAlphaTrace
            && event.type === "teammate_state_changed"
            && event.name === "alpha"
            && event.state === "stopped"
          ) {
            failAlphaTrace = false;
            throw firstCleanupError;
          }
        },
      },
      terminateTimeoutMs: 1_000,
    });
    const alphaStart = fixture.manager.start({
      instructions: "alpha research",
      message: "initial",
      name: "alpha",
      profile: "research",
    });
    const alpha = await fixture.adapter.nextProcess();
    alpha.emit({ sessionId: "session-alpha", type: "ready" });
    await alphaStart;
    const betaStart = fixture.manager.start({
      instructions: "beta research",
      message: "initial",
      name: "beta",
      profile: "research",
    });
    const beta = await fixture.adapter.nextProcess();
    beta.emit({ sessionId: "session-beta", type: "ready" });
    await betaStart;
    let settled = false;

    const termination = fixture.manager.terminateAll();
    void termination.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await waitUntil(() => alpha.kill.mock.calls.length === 1);
    expect(beta.kill).not.toHaveBeenCalled();
    alpha.exit(0, "SIGTERM");
    await waitUntil(() => beta.kill.mock.calls.length === 1);
    expect(settled).toBe(false);
    expect(cleanupEvents).not.toContainEqual(expect.objectContaining({ type: "team_cleanup" }));

    beta.exit(0, "SIGTERM");
    await expect(termination).rejects.toSatisfy((error: unknown) => (
      error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0] === firstCleanupError
    ));
    expect(cleanupEvents).toContainEqual(expect.objectContaining({
      mode: "terminate",
      stopped: ["alpha", "beta"],
      type: "team_cleanup",
    }));
    await fixture.manager.flushEvents();
    expect(await fixture.manager.list()).toEqual([
      expect.objectContaining({ name: "alpha", state: "busy" }),
      expect.objectContaining({ name: "beta", state: "stopped" }),
    ]);

    await expect(fixture.manager.terminateAll()).resolves.toBeUndefined();
    expect(await fixture.manager.list()).toEqual([
      expect.objectContaining({ name: "alpha", state: "stopped" }),
      expect.objectContaining({ name: "beta", state: "stopped" }),
    ]);
    expect(alpha.kill).toHaveBeenCalledTimes(1);
    expect(beta.kill).toHaveBeenCalledTimes(1);
  });

  it("shares overlapping termination and keeps later successful calls idempotent", async () => {
    const cleanupEvents: TraceEventPayload[] = [];
    const fixture = await createFixture(["session-a"], {
      lifecycleEmitter: {
        async emit(event) {
          cleanupEvents.push(event);
        },
      },
      terminateTimeoutMs: 1_000,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;

    const first = fixture.manager.terminateAll();
    const overlapping = fixture.manager.terminateAll();

    expect(overlapping).toBe(first);
    await waitUntil(() => process.kill.mock.calls.length > 0);
    expect(process.kill).toHaveBeenCalledTimes(1);
    process.exit(0, "SIGTERM");
    await expect(Promise.all([first, overlapping])).resolves.toEqual([undefined, undefined]);
    expect(cleanupEvents.filter((event) => event.type === "team_cleanup")).toHaveLength(1);

    const later = fixture.manager.terminateAll();
    expect(later).toBe(first);
    await expect(later).resolves.toBeUndefined();
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(cleanupEvents.filter((event) => event.type === "team_cleanup")).toHaveLength(1);
  });

  it.each([
    {
      exitSignal: "SIGTERM" as const,
      expectedSignals: ["SIGTERM"],
      label: "SIGTERM",
      terminateTimeoutMs: 1_000,
    },
    {
      exitSignal: "SIGKILL" as const,
      expectedSignals: ["SIGTERM", "SIGKILL"],
      label: "SIGKILL escalation",
      terminateTimeoutMs: 0,
    },
  ])("joins queued worker events before finalizing $label shutdown", async ({
    exitSignal,
    expectedSignals,
    terminateTimeoutMs,
  }) => {
    const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-teammates-exit-tail-"));
    const teamRoot = path.join(baseCwd, "team");
    const backing = createFileMailboxStore({ teamRoot });
    const appendBlocked = deferred<void>();
    const releaseAppend = deferred<void>();
    const mailboxStore: MailboxStore = {
      ...backing,
      async append(input) {
        if (input.kind === "turn_result") {
          appendBlocked.resolve(undefined);
          await releaseAppend.promise;
        }
        return backing.append(input);
      },
    };
    const events: TraceEventPayload[] = [];
    const adapter = new FakeProcessAdapter();
    const manager = createTeammateManager({
      baseCwd,
      lifecycleEmitter: {
        async emit(event) {
          events.push(event);
        },
      },
      mailboxStore,
      processAdapter: adapter,
      rootSessionId: "root-session",
      sessionId: () => "session-a",
      teamRoot,
      terminateTimeoutMs,
    });
    await manager.initialize();
    const started = manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;
    process.emit({
      finalAnswer: "durable result",
      sessionId: "session-a",
      type: "turn_result",
    });
    await appendBlocked.promise;
    process.kill.mockImplementation((signal) => {
      if (signal === exitSignal) {
        process.exit(0, signal);
      }
      return true;
    });

    let terminationSettled = false;
    const termination = manager.terminateAll();
    void termination.then(
      () => { terminationSettled = true; },
      () => { terminationSettled = true; },
    );
    await waitUntil(() => process.kill.mock.calls.length === expectedSignals.length);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(terminationSettled).toBe(false);
    expect(JSON.parse(await fs.readFile(
      path.join(teamRoot, "teammates", "researcher", "runtime.json"),
      "utf8",
    ))).toMatchObject({ state: "busy" });
    expect(events).not.toContainEqual(expect.objectContaining({
      name: "researcher",
      state: "stopped",
      type: "teammate_state_changed",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "team_cleanup" }));

    releaseAppend.resolve(undefined);
    await termination;
    await manager.flushEvents();

    const stateEvents = events.filter(
      (event): event is Extract<TraceEventPayload, { type: "teammate_state_changed" }> => (
        event.type === "teammate_state_changed" && event.name === "researcher"
      ),
    );
    expect(stateEvents.filter((event) => event.state === "stopped")).toHaveLength(1);
    expect(stateEvents.at(-1)).toMatchObject({ state: "stopped" });
    expect(events.filter((event) => event.type === "team_cleanup")).toEqual([
      expect.objectContaining({ mode: "terminate", stopped: ["researcher"] }),
    ]);
    expect(JSON.parse(await fs.readFile(
      path.join(teamRoot, "teammates", "researcher", "runtime.json"),
      "utf8",
    ))).toMatchObject({ state: "stopped" });
    await expect(manager.list()).resolves.toEqual([
      expect.objectContaining({ name: "researcher", state: "stopped" }),
    ]);
    expect(process.kill.mock.calls.map(([signal]) => signal)).toEqual(expectedSignals);
  });

  it("retries a failed stopped-state persistence before becoming terminal", async () => {
    const cleanupEvents: TraceEventPayload[] = [];
    const fixture = await createFixture(["session-a"], {
      lifecycleEmitter: {
        async emit(event) {
          cleanupEvents.push(event);
        },
      },
      terminateTimeoutMs: 0,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;
    process.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") {
        process.exit(0, "SIGTERM");
      }
      return true;
    });
    const persistenceError = new Error("stopped runtime persistence failed");
    const writeSpy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(persistenceError);

    const first = fixture.manager.terminateAll();
    await expect(first).rejects.toSatisfy((error: unknown) => (
      error instanceof AggregateError
      && error.errors.length === 1
      && error.errors[0] === persistenceError
    ));
    expect(JSON.parse(await fs.readFile(
      path.join(fixture.teamRoot, "teammates", "researcher", "runtime.json"),
      "utf8",
    ))).toMatchObject({ state: "busy" });

    const retry = fixture.manager.terminateAll();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(
      path.join(fixture.teamRoot, "teammates", "researcher", "runtime.json"),
      "utf8",
    ))).toMatchObject({ state: "stopped" });
    expect(cleanupEvents).toContainEqual(expect.objectContaining({
      name: "researcher",
      state: "stopped",
      type: "teammate_state_changed",
    }));

    const later = fixture.manager.terminateAll();
    expect(later).toBe(retry);
    await expect(later).resolves.toBeUndefined();
    expect(writeSpy).toHaveBeenCalledTimes(2);
    writeSpy.mockRestore();
  });

  it("does not fence a genuine crash when forced signal delivery fails", async () => {
    const signalError = new Error("SIGTERM delivery threw");
    const events: TraceEventPayload[] = [];
    const fixture = await createFixture(["session-a"], {
      lifecycleEmitter: {
        async emit(event) {
          events.push(event);
        },
      },
      terminateTimeoutMs: 0,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;
    process.kill
      .mockImplementationOnce(() => { throw signalError; })
      .mockReturnValueOnce(false);

    const termination = fixture.manager.terminateAll();
    const overlapping = fixture.manager.terminateAll();

    expect(overlapping).toBe(termination);
    const terminationError = await termination.catch((error: unknown) => error);
    expect(containsError(terminationError, signalError)).toBe(true);
    expect(process.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);

    process.exit(1, null);
    const retry = fixture.manager.terminateAll();
    expect(retry).not.toBe(termination);
    await expect(retry).resolves.toBeUndefined();
    await fixture.manager.flushEvents();
    expect(await fixture.manager.list()).toEqual([
      expect.objectContaining({
        failure: expect.stringContaining("worker exited unexpectedly"),
        name: "researcher",
        state: "failed",
      }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      failure: expect.stringContaining("worker exited unexpectedly"),
      name: "researcher",
      state: "failed",
      type: "teammate_state_changed",
    }));
  });

  it("rejects false signal delivery, resets active state, and terminates a later retry", async () => {
    const fixture = await createFixture(["session-a", "session-b"], {
      terminateTimeoutMs: 1_000,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const firstProcess = await fixture.adapter.nextProcess();
    firstProcess.emit({ sessionId: "session-a", type: "ready" });
    await started;
    firstProcess.kill.mockReturnValue(false);

    const firstTermination = fixture.manager.terminateAll();
    const overlapping = fixture.manager.terminateAll();
    expect(overlapping).toBe(firstTermination);
    await expect(firstTermination).rejects.toBeInstanceOf(AggregateError);
    expect(firstProcess.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);

    firstProcess.exit(1, null);
    await fixture.manager.flushEvents();
    expect(await fixture.manager.list()).toEqual([
      expect.objectContaining({ name: "researcher", state: "failed" }),
    ]);

    const secondStarted = fixture.manager.start({
      instructions: "repair cleanup",
      message: "initial",
      name: "repair-worker",
      profile: "research",
    });
    const secondProcess = await fixture.adapter.nextProcess();
    secondProcess.emit({ sessionId: "session-b", type: "ready" });
    await secondStarted;

    const retry = fixture.manager.terminateAll();
    expect(retry).not.toBe(firstTermination);
    await waitUntil(() => secondProcess.kill.mock.calls.length === 1);
    secondProcess.exit(0, "SIGTERM");
    await expect(retry).resolves.toBeUndefined();
    expect(await fixture.manager.list()).toEqual([
      expect.objectContaining({ name: "repair-worker", state: "stopped" }),
      expect.objectContaining({ name: "researcher", state: "failed" }),
    ]);
  });

  it("waits for confirmed exit after SIGKILL and shares the escalation", async () => {
    const fixture = await createFixture(["session-a"], {
      terminateTimeoutMs: 20,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;
    let settled = false;

    const termination = fixture.manager.terminateAll();
    const overlapping = fixture.manager.terminateAll();
    void termination.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    expect(overlapping).toBe(termination);
    await waitUntil(() => process.kill.mock.calls.length === 2);
    expect(process.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);

    process.exit(0, "SIGKILL");
    await expect(Promise.all([termination, overlapping])).resolves.toEqual([undefined, undefined]);
    expect(process.kill).toHaveBeenCalledTimes(2);
  });

  it("rejects termination when SIGKILL cannot confirm process exit", async () => {
    const fixture = await createFixture(["session-a"], {
      terminateTimeoutMs: 0,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;

    const terminationError = await fixture.manager.terminateAll().catch((error: unknown) => error);

    expect(terminationError).toBeInstanceOf(AggregateError);
    expect(errorMessages(terminationError)).toContainEqual(
      expect.stringContaining("did not exit after SIGKILL"),
    );
    expect(process.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    process.exit(0, "SIGKILL");
    await fixture.manager.flushEvents();
  });

  it("rejects a new worker while termination is in flight", async () => {
    const fixture = await createFixture(["session-a", "session-b"], {
      terminateTimeoutMs: 1_000,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const firstProcess = await fixture.adapter.nextProcess();
    firstProcess.emit({ sessionId: "session-a", type: "ready" });
    await started;
    const termination = fixture.manager.terminateAll();
    await waitUntil(() => firstProcess.kill.mock.calls.length === 1);

    const attemptedStart = fixture.manager.start({
      instructions: "late worker",
      message: "initial",
      name: "late-worker",
      profile: "research",
    });
    const lateProcess = await Promise.race([
      fixture.adapter.nextProcess(),
      attemptedStart.then(() => undefined, () => undefined),
    ]);
    lateProcess?.emit({ sessionId: "session-b", type: "ready" });
    const startResult = await attemptedStart.catch((error: unknown) => error);
    lateProcess?.exit(1, null);
    firstProcess.exit(0, "SIGTERM");
    await termination;
    await fixture.manager.flushEvents();

    expect(startResult).toBeInstanceOf(Error);
    expect((startResult as Error).message).toContain("manager is terminating");
  });

  it("rejects start after successful termination and keeps terminateAll a no-op", async () => {
    const fixture = await createFixture(["session-a", "session-b"], {
      terminateTimeoutMs: 1_000,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const firstProcess = await fixture.adapter.nextProcess();
    firstProcess.emit({ sessionId: "session-a", type: "ready" });
    await started;
    const termination = fixture.manager.terminateAll();
    await waitUntil(() => firstProcess.kill.mock.calls.length === 1);
    firstProcess.exit(0, "SIGTERM");
    await termination;

    const attemptedStart = fixture.manager.start({
      instructions: "late worker",
      message: "initial",
      name: "late-worker",
      profile: "research",
    });
    const lateProcess = await Promise.race([
      fixture.adapter.nextProcess(),
      attemptedStart.then(() => undefined, () => undefined),
    ]);
    lateProcess?.emit({ sessionId: "session-b", type: "ready" });
    const startResult = await attemptedStart.catch((error: unknown) => error);
    lateProcess?.exit(1, null);

    expect(startResult).toBeInstanceOf(Error);
    expect((startResult as Error).message).toContain("manager is terminated");
    expect(fixture.manager.terminateAll()).toBe(termination);
    await expect(fixture.manager.terminateAll()).resolves.toBeUndefined();
    expect(firstProcess.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects rejoin after successful termination", async () => {
    const fixture = await createFixture(["session-a", "session-b"], {
      terminateTimeoutMs: 1_000,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const firstProcess = await fixture.adapter.nextProcess();
    firstProcess.emit({ sessionId: "session-a", type: "ready" });
    await started;
    firstProcess.emit({
      reason: "provider unavailable",
      sessionId: "session-a",
      type: "failure",
    });
    await fixture.manager.flushEvents();
    const termination = fixture.manager.terminateAll();
    await waitUntil(() => firstProcess.kill.mock.calls.length === 1);
    firstProcess.exit(0, "SIGTERM");
    await termination;

    const attemptedRejoin = fixture.manager.rejoin({
      name: "researcher",
      recovery: "late recovery",
    });
    const lateProcess = await Promise.race([
      fixture.adapter.nextProcess(),
      attemptedRejoin.then(() => undefined, () => undefined),
    ]);
    lateProcess?.emit({ sessionId: "session-b", type: "ready" });
    const rejoinResult = await attemptedRejoin.catch((error: unknown) => error);
    lateProcess?.exit(1, null);

    expect(rejoinResult).toBeInstanceOf(Error);
    expect((rejoinResult as Error).message).toContain("manager is terminated");
  });

  it("creates an edit workspace once and reuses the same binding after rejoin", async () => {
    const workspaceFactory = {
      create: vi.fn(async () => ({
        branch: "forge/teammate/root-session/docs-editor",
        path: "/repo/.forge/worktrees/root-session/teammates/docs-editor",
      })),
    };
    const fixture = await createFixture(
      ["session-a", "session-b"],
      { workspaceFactory },
    );
    const started = fixture.manager.start({
      instructions: "edit docs",
      message: "first edit",
      name: "docs-editor",
      profile: "edit",
    });
    const first = await fixture.adapter.nextProcess();
    first.emit({ sessionId: "session-a", type: "ready" });
    await started;
    first.emit({
      reason: "worker failed",
      sessionId: "session-a",
      type: "failure",
    });
    await fixture.manager.flushEvents();

    const rejoined = fixture.manager.rejoin({
      name: "docs-editor",
      recovery: "continue in the same worktree",
    });
    const second = await fixture.adapter.nextProcess();
    second.emit({ sessionId: "session-b", type: "ready" });
    await rejoined;

    expect(workspaceFactory.create).toHaveBeenCalledOnce();
    expect(first.sent[0]).toMatchObject({
      config: {
        definition: {
          workspace: {
            branch: "forge/teammate/root-session/docs-editor",
            path: "/repo/.forge/worktrees/root-session/teammates/docs-editor",
          },
        },
      },
    });
    expect(second.sent[0]).toMatchObject({
      config: {
        definition: {
          workspace: {
            branch: "forge/teammate/root-session/docs-editor",
            path: "/repo/.forge/worktrees/root-session/teammates/docs-editor",
          },
        },
      },
    });
  });

  it("serializes edit/write approval requests through the Leader", async () => {
    const firstApproval = deferred<{ approved: boolean }>();
    const secondApproval = deferred<{ approved: boolean }>();
    const approver = {
      approve: vi.fn()
        .mockImplementationOnce(() => firstApproval.promise)
        .mockImplementationOnce(() => secondApproval.promise),
    };
    const fixture = await createFixture(["session-a"], {
      approver,
      workspaceFactory: {
        async create() {
          return {
            branch: "forge/teammate/root-session/docs-editor",
            path: "/repo/.forge/worktrees/root-session/teammates/docs-editor",
          };
        },
      },
    });
    const started = fixture.manager.start({
      instructions: "edit docs",
      message: "initial",
      name: "docs-editor",
      profile: "edit",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;

    process.emit({
      argumentsText: '{"path":"README.md"}',
      reason: "edit approval",
      requestId: "approval-1",
      risk: "mutating",
      sessionId: "session-a",
      toolName: "edit",
      type: "approval_request",
    });
    process.emit({
      argumentsText: '{"path":"docs/c17b.md"}',
      reason: "write approval",
      requestId: "approval-2",
      risk: "mutating",
      sessionId: "session-a",
      toolName: "write",
      type: "approval_request",
    });
    await waitUntil(() => approver.approve.mock.calls.length === 1);
    firstApproval.resolve({ approved: true });
    await waitUntil(() => approver.approve.mock.calls.length === 2);
    secondApproval.resolve({ approved: false });
    await fixture.manager.flushEvents();

    expect(process.sent.filter((message) => message.type === "approval_result")).toEqual([
      expect.objectContaining({ approved: true, requestId: "approval-1" }),
      expect.objectContaining({ approved: false, requestId: "approval-2" }),
    ]);
  });

  it("keeps teammate startup independent from task ownership and shuts down explicitly", async () => {
    const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-teammate-task-"));
    const teamRoot = path.join(baseCwd, "team");
    const graphPath = path.join(baseCwd, "task-graph.json");
    const taskStore = createFileTeamTaskStore({ graphPath });
    await taskStore.initialize();
    await taskStore.create(
      { role: "leader", sessionId: "root-session" },
      {
        acceptance: ["evidence exists"],
        description: "research task",
        kind: "research",
        title: "Research",
      },
    );
    const adapter = new FakeProcessAdapter();
    const manager = createTeammateManager({
      baseCwd,
      lifecycleEmitter: createLifecycleEmitter({ recorder: createNoopTraceRecorder() }),
      processAdapter: adapter,
      rootSessionId: "root-session",
      sessionId: () => "session-a",
      taskGraph: {
        rootSessionId: "root-session",
        taskGraphPath: graphPath,
      },
      teamRoot,
    });
    await manager.initialize();

    const started = manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;

    expect(process.sent[0]).toMatchObject({
      config: {
        definition: expect.not.objectContaining({ taskId: expect.anything() }),
        taskGraph: {
          rootSessionId: "root-session",
          taskGraphPath: graphPath,
        },
      },
    });
    expect(process.sent[0]).not.toHaveProperty("config.taskGraph.delegatedTaskId");

    process.emit({
      finalAnswer: "idle",
      sessionId: "session-a",
      type: "turn_result",
    });
    await manager.flushEvents();
    await taskStore.transition(
      { role: "leader", sessionId: "root-session" },
      {
        action: "assign",
        assignee: { name: "researcher", profile: "research", role: "teammate" },
        id: "task_001",
      },
    );
    await expect(
      manager.shutdown({ mode: "shutdown", name: "researcher" }),
    ).rejects.toThrow('owns unfinished task "task_001"');
    const teammate = {
      name: "researcher",
      profile: "research" as const,
      role: "teammate" as const,
      sessionId: "session-a",
    };
    await taskStore.addEvidence(teammate, "task_001", {
      callId: "research",
      round: 1,
      summary: "Research complete",
    });
    await taskStore.transition(teammate, {
      action: "submit_result",
      id: "task_001",
      summary: "Research complete",
    });
    await taskStore.transition(
      { role: "leader", sessionId: "root-session" },
      {
        action: "review_result",
        decision: "pass",
        id: "task_001",
        reason: "Accepted",
      },
    );
    const shutdown = manager.shutdown({ mode: "shutdown", name: "researcher" });
    await waitUntil(() => process.sent.some((message) => message.type === "shutdown"));
    process.exit(0, null);
    await expect(shutdown).resolves.toMatchObject({ state: "stopped" });
  });

  it("retires an idle teammate without sending a graceful shutdown request", async () => {
    const fixture = await createFixture(["session-a"], {
      shutdownTimeoutMs: 0,
      terminateTimeoutMs: 0,
    });
    const started = fixture.manager.start({
      instructions: "research",
      message: "initial",
      name: "researcher",
      profile: "research",
    });
    const process = await fixture.adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;
    process.emit({
      finalAnswer: "idle",
      sessionId: "session-a",
      type: "turn_result",
    });
    await fixture.manager.flushEvents();
    process.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") {
        process.exit(0, "SIGTERM");
      }
      return true;
    });

    await expect(
      fixture.manager.shutdown({ mode: "retire", name: "researcher" }),
    ).resolves.toMatchObject({ state: "stopped" });

    expect(process.sent).not.toContainEqual(expect.objectContaining({ type: "shutdown" }));
    expect(process.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
  });

  it("brokers edit/write approval only for an owned edit task with a current approved plan and no handoff", async () => {
    const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-teammate-plan-gate-"));
    const graphPath = path.join(baseCwd, "task-graph.json");
    const taskStore = createFileTeamTaskStore({ graphPath });
    const leader = { role: "leader", sessionId: "root-session" } as const;
    const editor = {
      name: "editor",
      profile: "edit" as const,
      role: "teammate" as const,
      sessionId: "session-a",
    };
    await taskStore.initialize();
    await taskStore.create(leader, {
      acceptance: ["artifact changed"],
      description: "edit task",
      kind: "edit",
      title: "Edit",
      verificationCommand: "npm test",
    });
    await taskStore.transition(leader, {
      action: "assign",
      assignee: { name: "editor", profile: "edit", role: "teammate" },
      id: "task_001",
    });
    const adapter = new FakeProcessAdapter();
    const approver = { approve: vi.fn(async () => ({ approved: true })) };
    const manager = createTeammateManager({
      approver,
      baseCwd,
      lifecycleEmitter: createLifecycleEmitter({ recorder: createNoopTraceRecorder() }),
      processAdapter: adapter,
      rootSessionId: "root-session",
      sessionId: () => "session-a",
      taskGraph: { rootSessionId: "root-session", taskGraphPath: graphPath },
      teamRoot: path.join(baseCwd, "team"),
      workspaceFactory: {
        async create() {
          return { branch: "editor-branch", path: "/registered/editor" };
        },
      },
    });
    await manager.initialize();
    const started = manager.start({
      instructions: "edit",
      message: "initial",
      name: "editor",
      profile: "edit",
    });
    const process = await adapter.nextProcess();
    process.emit({ sessionId: "session-a", type: "ready" });
    await started;

    process.emit(approvalRequest("before-plan"));
    await manager.flushEvents();
    expect(approver.approve).not.toHaveBeenCalled();
    expect(process.sent).toContainEqual(expect.objectContaining({
      approved: false,
      requestId: "before-plan",
      type: "approval_result",
    }));

    await taskStore.transition(editor, {
      action: "submit_plan",
      id: "task_001",
      steps: ["edit the artifact"],
      summary: "small edit",
    });
    await taskStore.transition(leader, {
      action: "review_plan",
      decision: "approve",
      id: "task_001",
      reason: "scoped",
    });
    process.emit(approvalRequest("approved-plan"));
    await manager.flushEvents();
    expect(approver.approve).toHaveBeenCalledOnce();
    expect(process.sent).toContainEqual(expect.objectContaining({
      approved: true,
      requestId: "approved-plan",
      type: "approval_result",
    }));

    await taskStore.transition(editor, {
      action: "submit_handoff",
      id: "task_001",
      summary: "cooperative handoff",
    });
    process.emit(approvalRequest("after-handoff"));
    await manager.flushEvents();
    expect(approver.approve).toHaveBeenCalledOnce();
    expect(process.sent).toContainEqual(expect.objectContaining({
      approved: false,
      requestId: "after-handoff",
      type: "approval_result",
    }));
  });
});

function approvalRequest(requestId: string): TeammateToLeaderMessage {
  return {
    argumentsText: '{"path":"demo.txt"}',
    reason: "edit request",
    requestId,
    risk: "mutating",
    sessionId: "session-a",
    toolName: "edit",
    type: "approval_request",
  };
}

class FakeTeammateProcess implements TeammateProcess {
  readonly sent: LeaderToTeammateMessage[] = [];
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private readonly messageListeners: Array<(message: TeammateToLeaderMessage) => void> = [];

  disconnect = vi.fn();
  kill = vi.fn((_signal?: NodeJS.Signals) => true);

  emit(message: TeammateToLeaderMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.exitListeners) {
      listener(code, signal);
    }
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
  }

  onMessage(listener: (message: TeammateToLeaderMessage) => void): void {
    this.messageListeners.push(listener);
  }

  send(message: LeaderToTeammateMessage): void {
    this.sent.push(message);
  }

  async waitForSent(type: LeaderToTeammateMessage["type"]): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.sent.some((message) => message.type === type)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`manager did not send ${type}`);
  }
}

class FakeProcessAdapter implements TeammateProcessAdapter {
  readonly processes: FakeTeammateProcess[] = [];

  fork(): TeammateProcess {
    const process = new FakeTeammateProcess();
    this.processes.push(process);
    return process;
  }

  async nextProcess(): Promise<FakeTeammateProcess> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const process = this.processes.shift();
      if (process) {
        return process;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("manager did not fork a teammate process");
  }
}

async function createFixture(
  sessionIds: string[],
  overrides: Partial<Pick<
    CreateTeammateManagerOptions,
    | "approver"
    | "lifecycleEmitter"
    | "mailboxStore"
    | "onLog"
    | "shutdownTimeoutMs"
    | "terminateTimeoutMs"
    | "workerPermissionRules"
    | "workspaceFactory"
  >> = {},
) {
  const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-teammates-"));
  const teamRoot = path.join(baseCwd, ".forge", "sessions", "root-session", "team");
  const adapter = new FakeProcessAdapter();
  const manager = createTeammateManager({
    baseCwd,
    lifecycleEmitter: createLifecycleEmitter({ recorder: createNoopTraceRecorder() }),
    processAdapter: adapter,
    rootSessionId: "root-session",
    sessionId: () => {
      const next = sessionIds.shift();
      if (!next) {
        throw new Error("unexpected teammate session allocation");
      }
      return next;
    },
    teamRoot,
    ...overrides,
  });
  await manager.initialize();
  return { adapter, manager, teamRoot };
}

async function createOwnedResearchTaskFixture(status: "in_progress" | "submitted") {
  const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "forge-teammate-owned-task-"));
  const graphPath = path.join(baseCwd, "task-graph.json");
  const teamRoot = path.join(baseCwd, "team");
  const taskStore = createFileTeamTaskStore({ graphPath });
  const adapter = new FakeProcessAdapter();
  const manager = createTeammateManager({
    baseCwd,
    lifecycleEmitter: createLifecycleEmitter({ recorder: createNoopTraceRecorder() }),
    processAdapter: adapter,
    rootSessionId: "root-session",
    sessionId: () => "session-a",
    taskGraph: { rootSessionId: "root-session", taskGraphPath: graphPath },
    teamRoot,
  });
  await taskStore.initialize();
  await taskStore.create(
    { role: "leader", sessionId: "root-session" },
    {
      acceptance: ["Evidence is submitted"],
      description: "Research the durable task state.",
      kind: "research",
      title: "Research",
    },
  );
  await manager.initialize();
  const started = manager.start({
    instructions: "research",
    message: "initial",
    name: "researcher",
    profile: "research",
  });
  const process = await adapter.nextProcess();
  process.emit({ sessionId: "session-a", type: "ready" });
  await started;
  await taskStore.transition(
    { role: "leader", sessionId: "root-session" },
    {
      action: "assign",
      assignee: { name: "researcher", profile: "research", role: "teammate" },
      id: "task_001",
    },
  );
  if (status === "submitted") {
    const teammate = {
      name: "researcher",
      profile: "research" as const,
      role: "teammate" as const,
      sessionId: "session-a",
    };
    await taskStore.addEvidence(teammate, "task_001", {
      callId: "evidence",
      round: 1,
      summary: "Research evidence",
    });
    await taskStore.transition(teammate, {
      action: "submit_result",
      id: "task_001",
      summary: "Research complete",
    });
  }
  return { manager, process, taskStore };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function containsError(error: unknown, target: unknown): boolean {
  if (error === target) {
    return true;
  }
  return error instanceof AggregateError
    ? error.errors.some((nested) => containsError(nested, target))
    : error instanceof Error && "cause" in error
      ? containsError(error.cause, target)
      : false;
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(errorMessages);
  }
  return [error instanceof Error ? error.message : String(error)];
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}
