import { describe, expect, it, vi } from "vitest";

import {
  createEvalApprover,
  createEvalPermissionPolicy,
  createEvalTeammatePermissionRules,
} from "../../src/eval/policy.js";
import { getEvalScenario } from "../../src/eval/scenarios.js";
import type { PermissionDecision, PermissionPolicy } from "../../src/governance/types.js";

describe("eval action boundary", () => {
  it("preserves the production decision for an allowed call and denies calls outside the scenario", () => {
    const base: PermissionPolicy = {
      decide: vi.fn((): PermissionDecision => ({
        action: "allow",
        reason: "production inspect rule",
        risk: "inspect",
      })),
    };
    const policy = createEvalPermissionPolicy({
      base,
      scenario: getEvalScenario("governed-read-only"),
      session: { role: "root", sessionId: "root" },
    });

    expect(policy.decide({ arguments: '{"path":"facts.txt"}', name: "read" })).toEqual({
      action: "allow",
      reason: "production inspect rule",
      risk: "inspect",
    });
    expect(policy.decide({ arguments: '{"path":"owned.txt","content":"pwned"}', name: "write" }))
      .toMatchObject({ action: "deny", risk: "unknown" });
    expect(base.decide).toHaveBeenCalledOnce();
  });

  it("auto-approves only c17c calls that remain inside the exact allowlist", async () => {
    const approver = createEvalApprover(getEvalScenario("c17c-team-completion"));

    await expect(approver.approve({
      decision: { action: "ask", reason: "production asks", risk: "mutating" },
      toolCall: {
        arguments: JSON.stringify({
          content: "issue: FH-16\nstatus: integrated by c17c\n",
          path: "c17c-coordination-demo.txt",
        }),
        name: "write",
      },
    })).resolves.toMatchObject({ approved: true });
    await expect(approver.approve({
      decision: { action: "ask", reason: "production asks", risk: "mutating" },
      toolCall: {
        arguments: JSON.stringify({ content: "wrong", path: "c17c-coordination-demo.txt" }),
        name: "write",
      },
    })).resolves.toMatchObject({ approved: false });
  });

  it("restricts the research teammate to submitting only its assigned task", () => {
    const base: PermissionPolicy = {
      decide: () => ({ action: "allow", reason: "production rule", risk: "mutating" }),
    };
    const policy = createEvalPermissionPolicy({
      base,
      scenario: getEvalScenario("c17c-team-completion"),
      session: {
        name: "protocol-researcher",
        profile: "research",
        role: "teammate",
        sessionId: "researcher",
      },
    });

    expect(policy.decide({
      arguments: JSON.stringify({ action: "submit_result", id: "task_002", summary: "done" }),
      name: "task_transition",
    })).toMatchObject({ action: "allow" });
    expect(policy.decide({
      arguments: JSON.stringify({ action: "claim", id: "task_003" }),
      name: "task_transition",
    })).toMatchObject({ action: "deny" });
  });

  it("derives actor-specific serialized rules for c17c teammate workers", () => {
    const scenario = getEvalScenario("c17c-team-completion");
    const researcher = createEvalTeammatePermissionRules(scenario, "protocol-researcher");
    const editor = createEvalTeammatePermissionRules(scenario, "protocol-editor");

    expect(researcher.map((rule) => rule.name)).toEqual([
      "task_get",
      "task_add_evidence",
      "task_transition",
    ]);
    expect(researcher).not.toContainEqual(expect.objectContaining({ name: "write" }));
    expect(editor).toContainEqual({
      arguments: {
        content: "issue: FH-16\nstatus: integrated by c17c\n",
        path: "c17c-coordination-demo.txt",
      },
      name: "write",
    });
  });

  it("requires c17c root task creation to declare an empty dependency list", () => {
    const base: PermissionPolicy = {
      decide: () => ({ action: "allow", reason: "production rule", risk: "mutating" }),
    };
    const policy = createEvalPermissionPolicy({
      base,
      scenario: getEvalScenario("c17c-team-completion"),
      session: { role: "root", sessionId: "root" },
    });
    const task = {
      acceptance: ["evidence recorded"],
      description: "Research FH-16.",
      kind: "research",
      title: "Research",
    };

    expect(policy.decide({
      arguments: JSON.stringify({ ...task, dependencies: [] }),
      name: "task_create",
    })).toMatchObject({ action: "allow" });
    expect(policy.decide({ arguments: JSON.stringify(task), name: "task_create" }))
      .toMatchObject({ action: "deny" });
  });
});
