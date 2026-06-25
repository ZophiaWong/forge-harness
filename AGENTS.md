# AGENTS.md

Instructions for coding agents working in this repository.

## Project

Forge Harness is a tutorial-driven TypeScript project for building a coding agent harness from scratch.

Current phase: `c06 Session / Trace` is integrated. The repository now has the first six runnable TypeScript checkpoints.

Do not turn this repo into a full platform ahead of the course. Each chapter should add the smallest mechanism needed to solve the current problem.

## Course rules

- Use `Part 1: Core Harness` and `Part 2: Scale & Extensions` as the course part names.
- Use the five Forge layers consistently: `L1 Loop & Execution`, `L2 Governance & Action Boundary`, `L3 Context & Knowledge`, `L4 State, Evidence & Reliability`, `L5 Coordination & Scale`.
- Treat layers as an architecture lens, not chapter order.
- Each runnable chapter should follow: `问题 -> 解决方案 -> 最小实现 -> 运行验证 -> 下一步缺口`.
- Before adding a mechanism, state which concrete pain point forced it to exist.

## TypeScript

- Use TypeScript for source code.
- Keep modules small enough to explain in tutorial order.
- Prefer explicit domain types once behavior needs them.
- Avoid framework-first dependencies.
- Do not add LangGraph, AutoGen, or similar orchestration frameworks as core dependencies.

## Source layout

When source returns, follow the target module boundaries in `docs/01-project-architecture.md`. Do not introduce broad source layout changes unless the current chapter needs them.

Do not create a centralized `src/state/` god module. Runtime state should be explicit domain data and module-owned projections.

## Documentation

Reader-facing documentation responsibilities live in `README.md` and `docs/*.md`; do not duplicate long course explanations here.

Tutorial docs should be written in Chinese. Keep identifiers, paths, commands, APIs, and precise technical terms in English.

When adding or rewriting `docs/tutorial/*.md`:

- keep the chapter tied to the current branch implementation
- include commands and expected observations
- say what the chapter does not implement yet
- put shared setup in `README.md`; tutorial chapters should link to it instead of repeating global setup
- map concept steps to short annotated code snippets; do not paste full functions when a focused excerpt explains the mechanism better
- keep tutorial verification focused on reader-visible smoke runs and observations
- keep detailed test coverage outside reader tutorials unless the tests are part of the chapter's learning goal
- do not add standalone maintainer verification checklists such as `npm run test`, `npm run typecheck`, and `npm run build` to reader-facing tutorial chapters unless those checks are the chapter's learning goal; keep those checklists in agent reports, PR notes, or checkpoint notes
- run a final `$humanizer-zh` review pass
- re-check code blocks, commands, filenames, identifiers, and API names after that pass

## Branches and tags

- `main` holds the latest integrated course.
- `tutorial/cNN-*` branches hold runnable chapter checkpoints.
- `tutorial-cNN-*` tags are frozen checkpoints.
- Do not move published tutorial tags.
- If a published checkpoint needs a fix, update the matching branch and create a new tag such as `tutorial-c02-tool-runtime-v2`.

Agents may remind the user to create, merge, or tag tutorial branches. Do not perform those actions without explicit confirmation.

## Verification

Do not claim a coding-agent change is complete without fresh verification.

For documentation-only work:

- check `git status`
- check Markdown links point to existing files
- keep future source layout notes clearly marked as future structure

For runnable chapters after source is reintroduced:

- `npm run test`
- `npm run typecheck`
- `npm run build`
- chapter command smoke test
