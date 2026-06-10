# AGENTS.md

Instructions for coding agents working in this repository.

## Project Identity

Forge Harness is a tutorial-driven TypeScript project for building a coding agent harness from scratch.

The course starts with a direct loop:

```text
user -> LLM -> tool_call -> tool_result -> LLM -> done
```

The harness then grows from problems exposed by that loop.

Do not turn this repository into a full platform ahead of the tutorial. Each chapter should add the smallest mechanism needed to solve the current pain point.

## Current Reset State

The course line has been reset to the literal first commit baseline.

Current branch purpose:

- define project identity
- define tutorial architecture
- define writing and branch rules
- prepare the next clean tutorial milestones

Archived pre-reorg work lives under `archive/pre-reorg/*`. Treat it as recovery material only. Do not copy old tutorial prose directly into the new course.

## Course Parts

Use these part names:

- `Part 1: Core Harness`
- `Part 2: Scale & Extensions`

`Core Harness` builds the single-agent runtime. `Scale & Extensions` adds longer-running, collaborative, and external-tool boundaries after the core interfaces exist.

## Forge Layers

Use these layer names consistently:

- `L1 Loop & Execution`
- `L2 Governance & Action Boundary`
- `L3 Context & Knowledge`
- `L4 State, Evidence & Reliability`
- `L5 Coordination & Scale`

Layers are an architecture lens, not the tutorial order. Tutorial order follows the growth path.

## Tutorial Discipline

Each chapter should follow this shape:

```text
problem
  -> naive code or pain
  -> harness mechanism
  -> runnable milestone
  -> next pressure
```

Before adding a mechanism, state which concrete pain point forced it to exist.

Keep chapters practical. Avoid reference-manual prose and broad claims.

## TypeScript Preference

- Use TypeScript for source code.
- Keep modules small enough to explain in tutorial order.
- Prefer explicit domain types once behavior needs them.
- Avoid framework-first dependencies.
- Do not introduce LangGraph, AutoGen, or similar orchestration frameworks as core dependencies.

## Future Module Direction

Source files are intentionally absent on this reset branch. When source returns, use these ownership boundaries:

- `src/cli/`: CLI entry points and command routing.
- `src/core/`: agent loop, turn orchestration, minimal LLM integration.
- `src/domain/`: shared runtime terms and protocols.
- `src/tools/`: tool schema, adapters, dispatcher, implementations.
- `src/governance/`: permission policy, risk classification, approval model.
- `src/context/`: observations, context projection, compaction placeholder.
- `src/runtime/`: session store, trace writer, workspace and replay support.
- `src/extensions/`: hooks, skills, subagents, MCP, worktrees, team protocols.

Do not create a centralized `src/state/` god module. Runtime state should be explicit domain data and module-owned projections.

## Naming

Prefer these terms:

- `Session`
- `TraceEvent`
- `RuntimeState`
- `ToolCall`
- `ToolResult`
- `Observation`
- `PermissionDecision`
- `ContextProjection`
- `ChangeSet`

Use `Reviewable File Editing` for the early file-editing chapter. Use `ChangeSet` or `diff-first editing` for the harder later direction.

## Branch And Tag Rules

- `main` holds the latest integrated course.
- `tutorial/cNN-*` branches hold runnable chapter checkpoints.
- `tutorial-cNN-*` tags are frozen checkpoints.
- Do not move published tags.
- If a published checkpoint needs a fix, update the matching branch and create a new tag such as `tutorial-c02-tool-runtime-v2`.

Old pre-reorg branches are archived. They should stay invisible to the new tutorial docs.

## Documentation Rules

Tutorial docs should be Chinese. Keep identifiers, paths, commands, APIs, and technical terms in English when precision matters.

When adding or rewriting `docs/tutorial/*.md`, run a final `$humanizer-zh` review pass, then re-check commands, file paths, and technical claims.

## Verification

Do not claim a coding-agent change is complete without verification.

For documentation-only reset work:

- check `git status`
- check real markdown links point to files that exist
- keep future source layout notes clearly marked as future structure

For runnable chapters after source is reintroduced:

- `npm run test`
- `npm run typecheck`
- `npm run build`
- chapter command smoke test

## Future Maintenance Skill

A local skill named `forge-tutorial-maintenance` should be created later.

It should help with:

- tutorial branch changes
- chapter contract checks
- doc and implementation consistency checks
- backport or forward-port decisions
- tag readiness checks

First version can be workflow-only. Scripts can come later if checks become repetitive.
