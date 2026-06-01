# Project Charter

## Mission

Forge Harness is a tutorial-driven, from-scratch coding agent harness built in TypeScript.

The mission is to implement the runtime mechanics of a coding agent directly, then organize that implementation path as a tutorial. The project should be useful for learning, portfolio review, and incremental development toward a production-like agent harness.

The tutorial should start from the direct loop readers can feel:

```text
user -> LLM -> tool_use -> bash -> tool_result -> LLM -> done
```

The harness is then forged by asking what goes wrong with that loop and implementing the smallest mechanism that solves the next concrete problem.

## Scope

Forge Harness focuses on the single-agent harness foundation:

- Agent loop.
- Tool use.
- Context management.
- Permission governance.
- Session persistence.
- Trace persistence.
- Runtime state model.
- Verification and recovery.

The project should evolve through runnable tutorial milestones rather than a large up-front platform design.

## Non-Goals

Forge Harness is not:

- A LangGraph, AutoGen, or framework-first project.
- A dashboard.
- A TypeScript UI.
- A complete MCP adapter.
- A multi-agent platform.
- A production SaaS.
- A complex eval benchmark.
- A full subagent team runtime in the first phase.
- A patch-first editing framework.
- A production-grade LLM runtime in Stage 1.

Patch-oriented and diff-first editing may become important later, but the project identity is the agent harness runtime.

## Inspirations

Claude Code and learn-claude-code provide a capability map:

- Agent loop.
- Tool use.
- Task tracking.
- Permission system.
- Hooks.
- Memory.
- Skills.
- Context compaction.
- Subagents.
- Worktree isolation.
- MCP and plugin routing.
- Team protocols.
- Bounded autonomy.

Pi provides inspiration for a small TypeScript-friendly runtime:

- Minimal harness core.
- Tool calling.
- State management.
- Sessions.
- Extensions.
- Skills and prompt resources.
- Lightweight CLI orientation.

Forge Harness is inspired by these ideas, but it is not a clone or fork.

## Learning Goals

- See a real LLM tool loop run before studying heavier runtime machinery.
- Understand what an agent harness does around the model call.
- Build the first loop before extracting abstractions.
- Treat tool calls as governed side effects.
- Learn how context projection grows out of noisy messages and tool output.
- Separate session, trace, and runtime state when the run becomes hard to inspect.
- Add verification before the agent claims completion.
- Grow the runtime through explainable milestones.

## Engineering Goals

- Keep runnable code as the primary artifact.
- Keep docs close to implementation decisions.
- Use TypeScript types to clarify runtime protocols when the tutorial needs them.
- Keep the core small and extension points explicit.
- Prefer traceable, reviewable file mutation flows.
- Avoid hiding the harness mechanics behind a framework.
- Avoid introducing architecture before the loop has created a reason for it.

## First-Phase Focus

The first phase establishes direction and project shape:

- Documentation.
- Architecture notes.
- Tutorial roadmap.
- Glossary.
- Minimal TypeScript scaffold.

It does not implement the full runtime. Stage 1 will later implement a real LLM minimal loop, but not a provider-agnostic production model layer.

## Long-Term Direction

Forge Harness should gradually harden from a direct real-LLM loop into a production-like runtime with:

- Governed tool runtime.
- Explicit context projection.
- JSONL trace persistence.
- Session resume and fork.
- Safe command execution.
- Verification and recovery loop.
- Skills, hooks, context compaction, child sessions, MCP routing, worktree isolation, and team protocols as later extensions.
