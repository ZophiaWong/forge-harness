# Principles

## 1. Make The Loop Visible First

Stage 1 should show the direct loop with a real LLM and a simple tool before introducing heavier runtime abstractions.

## 2. Harness First, Framework Second

Forge Harness should implement the runtime mechanics directly. External libraries may help, but they should not hide the agent loop, tool governance, context projection, session persistence, or verification model.

## 3. Forge Mechanisms From Pain Points

Do not add a registry, policy engine, session store, context projector, or extension system just because it belongs in the final architecture. Add it when the previous stage exposes the problem it solves.

## 4. Minimal Core, Explicit Extension Points

Start with a small single-agent core. Add extension points only when the core behavior makes the need concrete.

## 5. Tool Calls Are Governed Side Effects

Tools are not just functions. A tool call should eventually carry schema, side-effect, risk, permission, result, error, observation, and trace implications.

## 6. Context Is Projected, Not Dumped

The first loop can feed messages and tool results back directly. As output grows, the model should see a deliberate projection of task, state, observations, tools, and constraints.

## 7. Trace Meaningful Events

Trace the runtime events needed to understand, resume, debug, and teach the harness. Avoid noisy logs that do not explain decisions or outcomes.

## 8. Prefer Reviewable File Mutations

File changes should be reviewable, traceable, and permission-governed. The long-term direction is changeset-oriented editing or diff-first file mutation, not untracked overwrites.

## 9. Verify Before Claiming Done

A coding agent should verify work before claiming completion. Verification may be tests, type-checking, builds, acceptance criteria, or a clear explanation of why verification could not run.

## 10. Tutorial Milestones Should Be Runnable

Each tutorial milestone should be a vertical slice readers can run. Docs should explain the milestone; code should prove it.

## 11. Keep State Explicit but Not Centralized Into a God Module

State should be represented through clear domain types and runtime projections. Avoid a giant state package that owns every concept too early.

## 12. Do Not Confuse Future Roadmap With First-Phase Scope

Skills, context compaction, hooks, subagents, MCP routing, worktree isolation, and team protocols are important future ideas. They should not crowd out the minimal harness foundation.
