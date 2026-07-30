import { describe, expect, it, vi } from "vitest";

import { decideDefaultPermission } from "../../src/governance/defaultPolicy.js";
import type { TeammateManager } from "../../src/extensions/teammates.js";
import { createTeammateTools } from "../../src/tools/teammateTools.js";
import { createToolRuntime } from "../../src/tools/runtime.js";

describe("teammate tools", () => {
  it("exposes Leader-only lifecycle tools and symmetric list/direct-message tools", () => {
    const manager = createManager();
    const leader = createTeammateTools({ actor: "leader", manager });
    const worker = createTeammateTools({ actor: "repo-researcher", manager });

    expect(leader.map((tool) => tool.definition.name)).toEqual([
      "teammate_start",
      "teammate_list",
      "teammate_rejoin",
      "teammate_shutdown",
      "message_send",
      "message_broadcast",
    ]);
    expect(worker.map((tool) => tool.definition.name)).toEqual([
      "teammate_list",
      "message_send",
    ]);
    expect(
      leader.find((tool) => tool.definition.name === "teammate_rejoin")?.definition.description,
    ).toContain("does not unblock");
  });

  it("resolves start arguments and binds direct-message sender identity", async () => {
    const manager = createManager();
    const leaderRuntime = createToolRuntime(createTeammateTools({ actor: "leader", manager }));
    const workerRuntime = createToolRuntime(
      createTeammateTools({ actor: "repo-researcher", manager }),
    );

    await leaderRuntime.execute({
      arguments: JSON.stringify({
        instructions: "Research repository behavior.",
        maxToolRounds: null,
        message: "Inspect c17a.",
        name: "repo-researcher",
        profile: "research",
      }),
      name: "teammate_start",
    });
    await workerRuntime.execute({
      arguments: JSON.stringify({
        content: "I found the relevant files.",
        to: "leader",
      }),
      name: "message_send",
    });

    expect(manager.start).toHaveBeenCalledWith({
      instructions: "Research repository behavior.",
      message: "Inspect c17a.",
      name: "repo-researcher",
      profile: "research",
    });
    expect(manager.sendMessage).toHaveBeenCalledWith({
      content: "I found the relevant files.",
      from: "repo-researcher",
      to: "leader",
    });
  });

  it("applies the fixed Leader permission policy", () => {
    expect(decideDefaultPermission({
      arguments: JSON.stringify({ profile: "research" }),
      name: "teammate_start",
    })).toMatchObject({ action: "allow" });
    expect(decideDefaultPermission({
      arguments: JSON.stringify({ profile: "edit" }),
      name: "teammate_start",
    })).toMatchObject({ action: "ask" });
    expect(decideDefaultPermission({
      arguments: "{}",
      name: "teammate_rejoin",
    })).toMatchObject({ action: "ask" });
    for (const name of ["teammate_list", "teammate_shutdown", "message_send", "message_broadcast"]) {
      expect(decideDefaultPermission({ arguments: "{}", name })).toMatchObject({
        action: "allow",
      });
    }
  });
});

function createManager(): TeammateManager {
  return {
    broadcast: vi.fn(async () => ({ delivered: [], failed: [] })),
    close: vi.fn(async () => undefined),
    drainLeaderMessages: vi.fn(async () => []),
    flushEvents: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    rejoin: vi.fn(async (input) => ({
      name: input.name,
      profile: "research" as const,
      sessionId: "session-b",
      state: "busy" as const,
      tracePath: "/trace",
      unreadCount: 0,
    })),
    resolveAssignee: vi.fn(async (name) => ({
      name,
      profile: "research" as const,
      role: "teammate" as const,
    })),
    resolveEditSource: vi.fn(async () => {
      throw new Error("not used");
    }),
    sendMessage: vi.fn(async (input) => ({
      delivery: "woken" as const,
      messageId: "msg_leader_000001",
      to: input.to,
    })),
    settleBeforeFinal: vi.fn(async () => []),
    shutdown: vi.fn(async (input) => ({
      name: input.name,
      profile: "research" as const,
      sessionId: "session-a",
      state: "stopped" as const,
      tracePath: "/trace",
      unreadCount: 0,
    })),
    start: vi.fn(async (input) => ({
      name: input.name,
      profile: input.profile,
      sessionId: "session-a",
      state: "busy" as const,
      tracePath: "/trace",
      unreadCount: 0,
    })),
    terminateAll: vi.fn(async () => undefined),
  };
}
