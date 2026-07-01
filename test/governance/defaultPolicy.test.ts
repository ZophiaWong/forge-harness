import { describe, expect, it } from "vitest";

import { createDefaultPermissionPolicy } from "../../src/governance/defaultPolicy.js";

const policy = createDefaultPermissionPolicy();

function decide(name: string, args: unknown) {
  return policy.decide({
    arguments: typeof args === "string" ? args : JSON.stringify(args),
    name,
  });
}

describe("createDefaultPermissionPolicy", () => {
  it("allows inspect-only file and search tools", () => {
    expect(decide("read", { path: "package.json" })).toMatchObject({
      action: "allow",
      risk: "inspect",
    });
    expect(decide("ls", { path: "src" })).toMatchObject({
      action: "allow",
      risk: "inspect",
    });
    expect(decide("grep", { query: "Context Projection" })).toMatchObject({
      action: "allow",
      risk: "inspect",
    });
    expect(decide("find", { query: "c05" })).toMatchObject({
      action: "allow",
      risk: "inspect",
    });
  });

  it("asks before running file editing tools", () => {
    expect(
      decide("edit", {
        newText: "new line",
        oldText: "old line",
        path: "sample.txt",
      }),
    ).toMatchObject({
      action: "ask",
      risk: "mutating",
    });
    expect(
      decide("write", {
        content: "hello",
        path: "sample.txt",
      }),
    ).toMatchObject({
      action: "ask",
      risk: "mutating",
    });
  });

  it("allows the todo tool as a harness-local runtime state update", () => {
    expect(
      decide("todo", {
        acceptance: ["npm run build exits with code 0"],
        items: [{ id: "inspect", status: "in_progress", title: "Inspect the task" }],
        summary: "Track the current task.",
      }),
    ).toEqual({
      action: "allow",
      reason: "runtime task state update",
      risk: "mutating",
    });
  });

  it("denies malformed file editing arguments", () => {
    expect(decide("edit", { path: "sample.txt", oldText: "old" })).toMatchObject({
      action: "deny",
      risk: "unknown",
    });
    expect(decide("write", { path: "sample.txt" })).toMatchObject({
      action: "deny",
      risk: "unknown",
    });
  });

  it("allows simple bash inspect commands", () => {
    for (const command of ["pwd", "ls -la", "cat package.json", "sed -n '1,5p' package.json", "git status --short"]) {
      expect(decide("bash", { command })).toMatchObject({
        action: "allow",
        risk: "inspect",
      });
    }
  });

  it("asks before running mutating bash commands", () => {
    for (const command of ["touch c03-demo.txt", "npm install", "git commit -m checkpoint"]) {
      expect(decide("bash", { command })).toMatchObject({
        action: "ask",
        risk: "mutating",
      });
    }
  });

  it("asks before running complex shell commands", () => {
    for (const command of ["rg ToolRuntime src | head", "echo hello > output.txt", "git status --short && npm test", "sleep 1&"]) {
      expect(decide("bash", { command })).toMatchObject({
        action: "ask",
        risk: "unknown",
      });
    }
  });

  it("denies destructive bash commands", () => {
    for (const command of ["sudo whoami", "rm -rf dist", "git reset --hard HEAD"]) {
      expect(decide("bash", { command })).toMatchObject({
        action: "deny",
        risk: "destructive",
      });
    }
  });

  it("denies malformed bash arguments and unknown tools", () => {
    expect(decide("bash", "{bad json")).toMatchObject({
      action: "deny",
      risk: "unknown",
    });
    expect(decide("missing", {})).toMatchObject({
      action: "deny",
      risk: "unknown",
    });
  });
});
