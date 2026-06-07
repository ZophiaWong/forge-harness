# AGENTS.md

Instructions for coding agents working in this repository.

## Project Identity

Forge Harness is a tutorial-driven, from-scratch coding agent harness built in TypeScript. The repository should demonstrate agent runtime engineering through runnable milestones, not just API usage.

The tutorial starts from the direct loop:

```text
user -> LLM -> tool_use -> bash -> tool_result -> LLM -> done
```

Then it forges harness mechanisms from the pain points exposed by that loop.

The hardened direction is:

```text
Agent Loop
+ Tool Runtime
+ Context Projection
+ Permission Governance
+ Session / Trace Persistence
+ Runtime State Model
+ Verification / Recovery
```

## Current Phase

This project is in its documentation and lightweight scaffold phase.

Do not implement a full agent runtime unless a task explicitly asks for the next tutorial milestone. Keep early changes small, readable, and aligned with the tutorial roadmap.

## TypeScript Preference

- Use TypeScript for source code.
- Keep Stage 1 centered on a real LLM tool-calling loop.
- Prefer explicit domain types over loose object shapes once runtime behavior needs them.
- Keep modules small and easy to explain in tutorial order.
- Avoid framework-first dependencies.
- Do not introduce LangGraph, AutoGen, or similar orchestration frameworks as core dependencies.

## Module Ownership

- `src/cli/`: CLI entry points and command routing.
- `src/core/`: agent loop, turn orchestration, minimal LLM integration.
- `src/domain/`: shared types, protocols, trace events, task/session/turn/tool models.
- `src/tools/`: tool registry, schema, dispatcher, implementations.
- `src/governance/`: permission policy, risk classification, approval model.
- `src/context/`: context projection, observation normalization, compaction placeholder.
- `src/runtime/`: session store, trace writer, workspace management, persistence, replay placeholder.
- `src/extensions/`: future hooks, skills, subagents, MCP adapter, worktree isolation, team protocols.

Do not create a centralized `src/state/` god module. Keep state as explicit domain models and runtime projections owned by the modules that use them.

## Naming Conventions

- Use clear runtime terms: `Session`, `TraceEvent`, `RuntimeState`, `ToolCall`, `ToolResult`, `Observation`, `PermissionDecision`.
- Prefer `ContextProjection` over early `ContextCompaction`.
- Prefer `ChangeSet` or `diff-first file mutation` over making the project identity `patch-first`.
- Name tutorial chapters with `c00`, `c01`, and so on. Branches and tags should use the chapter slug, for example `tutorial/c01-minimal-real-llm-loop` and `tutorial-c01-minimal-real-llm-loop`.

## Verification Expectations

- Keep tutorial milestones runnable.
- Add or update tests when behavior is implemented.
- Do not claim completion of a coding-agent action without a verification step, such as type-checking, tests, command output, or an explicit reason verification could not run.
- Preserve traceability for future file mutations and command execution.

## Do Not Overbuild

Do not add these unless explicitly requested or the current tutorial milestone has created the need:

- Production-grade LLM runtime.
- Complete tool runtime.
- Complete permission system.
- Multi-agent platform.
- MCP adapter.
- Worktree isolation.
- Dashboard or UI.
- Benchmark system.
- Production SaaS structure.

Stage 1 includes a real LLM integration, but it should stay minimal: one model call path, one simple tool, messages history, tool results, and a stop condition. Do not make provider abstraction, tool registries, policy engines, or session stores the first lesson.

## Tutorial Discipline

Docs order, source layout, tutorial branches, and tutorial tags serve different purposes:

- `docs/tutorial/` defines the readable tutorial path.
- Source directories define maintainable implementation boundaries.
- `tutorial/cNN-name` branches are living chapter milestone lines.
- `tutorial-cNN-name` tags are stable tutorial checkpoints.

Keep documentation practical, concise, and implementation-oriented. When adding a mechanism, state which pain point in the previous loop forced it to exist.

Agents may suggest or remind the user to create a tutorial branch or tag, but must not create one without explicit user confirmation. Do not move published tutorial tags; fix the matching branch and create a new tag such as `tutorial-c01-minimal-real-llm-loop-v2`. Do not copy complete historical stage source trees into `docs/tutorial/`; keep source in `src/` and let git preserve runnable checkpoints.

Future `docs/tutorial/*` content should be written in Chinese. Technical terms should remain English unless there is already a widely accepted Chinese equivalent. Do not translate identifiers, filenames, commands, APIs, or protocol names.

When adding, rewriting, or expanding `docs/tutorial/*.md`, run a final `$humanizer-zh` review pass before claiming the tutorial text is done. Use it to remove AI-flavored phrasing, empty value statements, mechanical parallelism, overused connectors, and vague summary sentences. Do not let this pass change code blocks, commands, filenames, identifiers, API names, or established English technical terms.

After the `$humanizer-zh` pass, re-check technical accuracy: commands should still be runnable, source paths should still point to real files, and the chapter should still explain which pain point forced the next mechanism to exist. In the final response, state that the tutorial text received the `$humanizer-zh` review, or state why it could not be run.
