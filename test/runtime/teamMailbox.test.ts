import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAILBOX_SCHEMA_VERSION,
  createFileMailboxStore,
} from "../../src/runtime/teamMailbox.js";

describe("FileMailboxStore", () => {
  it("assigns independent recipient sequences and persists the fixed message schema", async () => {
    const teamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-mailbox-"));
    const store = createFileMailboxStore({
      now: () => new Date("2026-07-27T08:00:00.000Z"),
      teamRoot,
    });

    const first = await store.append({
      content: "inspect the repository",
      from: "leader",
      kind: "direct",
      to: "repo-researcher",
    });
    const second = await store.append({
      content: "follow up",
      from: "leader",
      kind: "direct",
      to: "repo-researcher",
    });
    const other = await store.append({
      content: "prepare an edit",
      from: "leader",
      kind: "direct",
      to: "docs-editor",
    });

    expect([first.id, second.id, other.id]).toEqual([
      "msg_repo-researcher_000001",
      "msg_repo-researcher_000002",
      "msg_docs-editor_000001",
    ]);
    expect(await store.inspect("repo-researcher")).toEqual({
      cursor: 0,
      nextSequence: 3,
      unreadCount: 2,
    });

    const inboxPath = path.join(
      teamRoot,
      "mailboxes",
      "repo-researcher",
      "inbox.jsonl",
    );
    const persisted = (await fs.readFile(inboxPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(persisted).toEqual([
      expect.objectContaining({
        createdAt: "2026-07-27T08:00:00.000Z",
        id: "msg_repo-researcher_000001",
        schemaVersion: MAILBOX_SCHEMA_VERSION,
        sequence: 1,
      }),
      expect.objectContaining({
        id: "msg_repo-researcher_000002",
        sequence: 2,
      }),
    ]);
  });

  it("claims the current unread FIFO snapshot and advances the cursor before dispatch", async () => {
    const teamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-mailbox-"));
    const store = createFileMailboxStore({ teamRoot });
    await store.append({
      content: "one",
      from: "leader",
      kind: "direct",
      to: "researcher",
    });
    await store.append({
      content: "two",
      from: "leader",
      kind: "direct",
      to: "researcher",
    });

    const firstClaim = await store.claimUnread("researcher");
    expect(firstClaim.messages.map((message) => message.content)).toEqual(["one", "two"]);
    expect(firstClaim.cursor).toBe(2);
    expect(await store.claimUnread("researcher")).toEqual({
      cursor: 2,
      messages: [],
    });

    await store.append({
      content: "arrived after the snapshot",
      from: "leader",
      kind: "direct",
      to: "researcher",
    });

    expect((await store.claimUnread("researcher")).messages.map((message) => message.content))
      .toEqual(["arrived after the snapshot"]);
  });

  it("rejects malformed inbox rows, invalid sequences, and corrupt cursors", async () => {
    const teamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-mailbox-"));
    const store = createFileMailboxStore({ teamRoot });
    await store.initialize("researcher");
    const mailboxRoot = path.join(teamRoot, "mailboxes", "researcher");

    await fs.writeFile(path.join(mailboxRoot, "inbox.jsonl"), "{not json\n", "utf8");
    await expect(store.inspect("researcher")).rejects.toMatchObject({
      code: "mailbox_malformed",
      name: "MailboxStoreError",
    });

    await fs.writeFile(path.join(mailboxRoot, "inbox.jsonl"), "", "utf8");
    await fs.writeFile(path.join(mailboxRoot, "cursor.json"), "{not json", "utf8");
    await expect(store.claimUnread("researcher")).rejects.toMatchObject({
      code: "cursor_malformed",
      name: "MailboxStoreError",
    });
  });

  it("persists only the fixed turn-result evidence fields", async () => {
    const teamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-mailbox-"));
    const store = createFileMailboxStore({ teamRoot });

    const result = await store.append({
      changedFiles: ["README.md", "src/index.ts"],
      content: "edit prepared",
      from: "docs-editor",
      kind: "turn_result",
      sessionId: "teammate-session-2",
      to: "leader",
      workspace: {
        branch: "forge/teammate/root-1/docs-editor",
        path: "/repo/.forge/worktrees/root-1/teammates/docs-editor",
      },
    });

    expect(result).toMatchObject({
      changedFiles: ["README.md", "src/index.ts"],
      kind: "turn_result",
      sessionId: "teammate-session-2",
      workspace: {
        branch: "forge/teammate/root-1/docs-editor",
      },
    });
    await expect(store.append({
      content: "",
      from: "leader",
      kind: "direct",
      to: "docs-editor",
    })).rejects.toMatchObject({ code: "invalid_message" });
  });
});
