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
  it("allows inspect-only file tools", () => {
    expect(decide("read", { path: "package.json" })).toMatchObject({
      action: "allow",
      risk: "inspect",
    });
    expect(decide("ls", { path: "src" })).toMatchObject({
      action: "allow",
      risk: "inspect",
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
