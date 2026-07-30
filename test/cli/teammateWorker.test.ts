import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  formatTeammateMailboxTurn,
  formatTeammateSessionTask,
  startTeammateWorkerHost,
  type TeammateWorkerChannel,
} from "../../src/cli/teammateWorker.js";
import type { ResponseCreate, ResponseCreateRequest } from "../../src/core/minimalLoop.js";
import type {
  LeaderToTeammateMessage,
  TeammateToLeaderMessage,
  TeammateWorkerConfig,
} from "../../src/extensions/teammates.js";
import type { TeamMessage } from "../../src/runtime/teamMailbox.js";

const execFileAsync = promisify(execFile);

describe("teammate worker", () => {
  it("projects each mailbox identity and keeps model history across batches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-teammate-worker-"));
    const config = workerConfig(root);
    const requests: ResponseCreateRequest[] = [];
    const responses = [
      { output: [], output_text: "first result" },
      { output: [], output_text: "second result" },
    ];
    const responseCreate: ResponseCreate = async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected model request");
      }
      return response;
    };
    const channel = new FakeWorkerChannel();
    startTeammateWorkerHost(channel, { responseCreate });

    channel.emit({
      config,
      sessionId: config.sessionId,
      type: "initialize",
    });
    await channel.waitFor("ready");

    channel.emit({
      messages: [message("msg_researcher_000001", 1, "first request")],
      sessionId: config.sessionId,
      type: "run_batch",
    });
    await channel.waitFor("turn_result");
    channel.emit({
      messages: [message("msg_researcher_000002", 2, "follow-up request")],
      sessionId: config.sessionId,
      type: "run_batch",
    });
    await channel.waitForCount("turn_result", 2);

    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "todo",
      "teammate_list",
      "message_send",
    ]);
    expect(requests[1]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: expect.stringContaining("msg_researcher_000001"),
        role: "user",
      }),
      expect.objectContaining({
        content: expect.stringContaining("msg_researcher_000002"),
        role: "user",
      }),
    ]));
  });

  it("formats a FIFO batch without collapsing message identity", () => {
    const formatted = formatTeammateMailboxTurn([
      message("msg_researcher_000001", 1, "direct body"),
      {
        ...message("msg_researcher_000002", 2, "broadcast body"),
        kind: "broadcast",
      },
    ]);

    expect(formatted).toContain("id: msg_researcher_000001");
    expect(formatted).toContain("from: leader");
    expect(formatted).toContain("kind: direct");
    expect(formatted).toContain("id: msg_researcher_000002");
    expect(formatted).toContain("kind: broadcast");
  });

  it("reserves todo for explicit Leader requests in short mailbox protocols", () => {
    const task = formatTeammateSessionTask(workerConfig("/tmp/teammate"));

    expect(task).toContain("TaskGraph is the shared coordination state");
    expect(task).toContain(
      "Do not call todo unless the current Leader message explicitly requests local todo planning.",
    );
    expect(task).toContain(
      "For short mailbox protocols, call the requested TaskGraph tools directly and then return a final response.",
    );
  });

  it("exposes only edit-profile tools and brokers each write approval over IPC", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-teammate-edit-worker-"));
    await fs.writeFile(path.join(root, "README.md"), "before\n", "utf8");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Forge Test"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "forge-test@example.com"], { cwd: root });
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
    const config = workerConfig(root);
    config.definition.profile = "edit";
    config.definition.workspace = {
      branch: "forge/teammate/root-session/docs-editor",
      path: root,
    };
    const requests: ResponseCreateRequest[] = [];
    const responses = [
      {
        output: [{
          arguments: JSON.stringify({
            newText: "after",
            oldText: "before",
            path: "README.md",
          }),
          call_id: "call_edit",
          name: "edit",
          type: "function_call",
        }],
        output_text: "",
      },
      { output: [], output_text: "edit complete" },
    ];
    const channel = new FakeWorkerChannel();
    startTeammateWorkerHost(channel, {
      responseCreate: async (request) => {
        requests.push(request);
        const response = responses.shift();
        if (!response) {
          throw new Error("unexpected model request");
        }
        return response;
      },
    });
    channel.emit({ config, sessionId: config.sessionId, type: "initialize" });
    await channel.waitFor("ready");
    channel.emit({
      messages: [message("msg_researcher_000001", 1, "make the edit")],
      sessionId: config.sessionId,
      type: "run_batch",
    });

    const approval = await channel.waitFor("approval_request");
    if (approval.type !== "approval_request") {
      throw new Error("expected approval request");
    }
    channel.emit({
      approved: true,
      requestId: approval.requestId,
      sessionId: config.sessionId,
      type: "approval_result",
    });
    await channel.waitFor("turn_result");

    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read",
      "ls",
      "grep",
      "find",
      "edit",
      "write",
      "todo",
      "teammate_list",
      "message_send",
    ]);
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("after\n");
  });
});

class FakeWorkerChannel implements TeammateWorkerChannel {
  readonly sent: TeammateToLeaderMessage[] = [];
  private listener?: (message: LeaderToTeammateMessage) => void;

  disconnect(): void {
    return undefined;
  }

  emit(message: LeaderToTeammateMessage): void {
    this.listener?.(message);
  }

  onMessage(listener: (message: LeaderToTeammateMessage) => void): void {
    this.listener = listener;
  }

  send(message: TeammateToLeaderMessage): void {
    this.sent.push(message);
  }

  async waitFor(type: TeammateToLeaderMessage["type"]): Promise<TeammateToLeaderMessage> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = this.sent.find((message) => message.type === type);
      if (found) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`worker did not emit ${type}`);
  }

  async waitForCount(type: TeammateToLeaderMessage["type"], count: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.sent.filter((message) => message.type === type).length >= count) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`worker did not emit ${count} ${type} messages`);
  }
}

function workerConfig(root: string): TeammateWorkerConfig {
  return {
    baseCwd: root,
    cwd: root,
    definition: {
      createdAt: "2026-07-27T08:00:00.000Z",
      instructions: "Keep investigating.",
      maxToolRounds: 2,
      name: "researcher",
      profile: "research",
      schemaVersion: 2,
    },
    model: "test-model",
    rootSessionId: "root-session",
    sessionId: "teammate-session",
    tracePath: path.join(root, "trace.jsonl"),
  };
}

function message(id: string, sequence: number, content: string): TeamMessage {
  return {
    content,
    createdAt: "2026-07-27T08:00:00.000Z",
    from: "leader",
    id,
    kind: "direct",
    schemaVersion: 1,
    sequence,
    to: "researcher",
  };
}
