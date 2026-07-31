import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { TeammateManager } from "../../src/extensions/teammates.js";
import {
  createCompletionGate,
  formatCompletionBlockers,
} from "../../src/runtime/completionGate.js";
import { createFileTeamTaskStore } from "../../src/runtime/teamTaskStore.js";

const leader = { role: "leader" as const, sessionId: "leader-session" };

describe("CompletionGate", () => {
  it("returns actionable incomplete blockers for unfinished tasks", async () => {
    const fixture = await createFixture();
    await fixture.store.create(leader, {
      acceptance: ["Answered"],
      description: "Research",
      kind: "research",
      title: "Research",
    });

    const result = await createCompletionGate({
      cwd: fixture.root,
      taskStore: fixture.store,
    }).evaluate();

    expect(result).toEqual({
      blockers: [expect.stringContaining('task "task_001"')],
      status: "incomplete",
    });
    if (result.status === "incomplete") {
      expect(formatCompletionBlockers(result.blockers)).toContain("assign or claim");
    }
  });

  it("asks only for integration after an edit task has passed verification", async () => {
    const fixture = await createFixture();
    await fixture.store.create(leader, {
      acceptance: ["Integrated"],
      description: "Edit",
      kind: "edit",
      title: "Edit",
      verificationCommand: "npm test",
    });
    await fixture.store.transition(leader, {
      action: "assign",
      assignee: { role: "leader" },
      id: "task_001",
    });
    await fixture.store.addEvidence(leader, "task_001", {
      callId: "evidence",
      round: 1,
      summary: "Child source is ready",
    });
    await fixture.store.transition(leader, {
      action: "submit_result",
      changedFiles: ["demo.txt"],
      fingerprint: "fingerprint",
      id: "task_001",
      source: {
        childSessionId: "child-session",
        kind: "child",
        profile: "edit",
        workspace: { branch: "child", path: "/tmp/child" },
      },
      summary: "Ready",
    });
    await fixture.store.recordVerification(leader, "task_001", {
      command: "npm test",
      exitCode: 0,
      fingerprint: "fingerprint",
      summary: "Passed",
    });

    await expect(createCompletionGate({
      cwd: fixture.root,
      taskStore: fixture.store,
    }).evaluate()).resolves.toEqual({
      blockers: ['task "task_001" is verified; Leader must task_integrate'],
      status: "incomplete",
    });
  });

  it("fails closed when a task is blocked or a teammate has failed", async () => {
    const fixture = await createFixture();
    await fixture.store.create(leader, {
      acceptance: ["Answered"],
      description: "Research",
      kind: "research",
      title: "Research",
    });
    await fixture.store.transition(leader, {
      action: "block",
      code: "owner_failed",
      id: "task_001",
      reason: "The owner process exited",
    });
    const teammates = {
      async list() {
        return [{
          failure: "worker exited",
          name: "researcher",
          profile: "research" as const,
          sessionId: "teammate-session",
          state: "failed" as const,
          tracePath: "/tmp/trace.jsonl",
          unreadCount: 0,
        }];
      },
    } as TeammateManager;

    const result = await createCompletionGate({
      cwd: fixture.root,
      taskStore: fixture.store,
      teammates,
    }).evaluate();

    expect(result).toMatchObject({
      problems: expect.arrayContaining([
        expect.objectContaining({ code: "owner_failed", taskId: "task_001" }),
        expect.objectContaining({ code: "owner_failure", teammate: "researcher" }),
      ]),
      status: "failed",
    });
  });

  it("fails closed when the task graph runtime projection is degraded", async () => {
    const result = await createCompletionGate({
      cwd: process.cwd(),
      taskGraphState: () => ({
        health: "degraded",
        lastError: {
          code: "store_io",
          message: "task graph mutation committed but lock cleanup failed",
        },
      }),
    }).evaluate();

    expect(result).toEqual({
      problems: [{
        code: "store_io",
        message: "task graph mutation committed but lock cleanup failed",
      }],
      status: "failed",
    });
  });

  it("becomes ready only after every task is completed and every teammate is stopped", async () => {
    const fixture = await createFixture();
    await fixture.store.create(leader, {
      acceptance: ["Answered"],
      description: "Research",
      kind: "research",
      title: "Research",
    });
    await fixture.store.transition(leader, {
      action: "assign",
      assignee: { role: "leader" },
      id: "task_001",
    });
    await fixture.store.addEvidence(leader, "task_001", {
      callId: "evidence",
      round: 1,
      summary: "Answer",
    });
    await fixture.store.transition(leader, {
      action: "submit_result",
      id: "task_001",
      summary: "Answer",
    });
    await fixture.store.transition(leader, {
      action: "review_result",
      decision: "pass",
      id: "task_001",
      reason: "Accepted",
    });
    const teammates = {
      async list() {
        return [{
          name: "researcher",
          profile: "research" as const,
          sessionId: "teammate-session",
          state: "stopped" as const,
          tracePath: "/tmp/trace.jsonl",
          unreadCount: 0,
        }];
      },
    } as TeammateManager;

    await expect(createCompletionGate({
      cwd: fixture.root,
      taskStore: fixture.store,
      teammates,
    }).evaluate()).resolves.toEqual({ status: "ready" });
  });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-completion-gate-"));
  const store = createFileTeamTaskStore({
    graphPath: path.join(root, "task-graph.json"),
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  await store.initialize();
  return { root, store };
}
