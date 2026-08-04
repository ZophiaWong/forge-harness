import { describe, expect, it } from "vitest";

import { createAllowlistPermissionPolicy } from "../../src/governance/allowlistPolicy.js";
import type { PermissionPolicy } from "../../src/governance/types.js";

describe("createAllowlistPermissionPolicy", () => {
  it("requires the tool and declared argument subset before delegating to the base policy", () => {
    const base: PermissionPolicy = {
      decide: () => ({ action: "allow", reason: "base allow", risk: "mutating" }),
    };
    const policy = createAllowlistPermissionPolicy(base, [{
      arguments: {
        content: "expected\n",
        path: "artifact.txt",
      },
      name: "write",
    }, {
      arguments: { action: "submit_result", id: "task_002" },
      name: "task_transition",
    }]);

    expect(policy.decide({
      arguments: JSON.stringify({ content: "expected\n", path: "artifact.txt" }),
      name: "write",
    })).toMatchObject({ action: "allow", reason: "base allow" });
    expect(policy.decide({
      arguments: JSON.stringify({ action: "submit_result", id: "task_002", summary: "done" }),
      name: "task_transition",
    })).toMatchObject({ action: "allow" });
    expect(policy.decide({
      arguments: JSON.stringify({ content: "wrong", path: "artifact.txt" }),
      name: "write",
    })).toMatchObject({ action: "deny", risk: "unknown" });
    expect(policy.decide({ arguments: "{not-json}", name: "write" }))
      .toMatchObject({ action: "deny", risk: "unknown" });
  });
});
