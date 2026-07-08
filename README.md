# Forge Harness

Forge Harness is a tutorial project for building a coding agent harness from scratch in TypeScript.

The course starts with one real loop:

```text
user -> LLM -> tool_call -> tool_result -> LLM -> done
```

Then each chapter pulls one problem out of that loop and turns it into a small harness mechanism.

## Status

This branch contains the documentation baseline plus the first thirteen runnable checkpoints: `c01 Minimal Real Loop`, `c02 Tool Runtime`, `c03 Permission Governance`, `c04 Reviewable File Editing`, `c05 Context Projection`, `c06 Session / Trace`, `c07 Runtime State Model`, `c08 Verification / Recovery`, `c09 Hooks`, `c10 Task / Todo`, `c11 System Prompt / Skills / Memory`, `c12 Context Compaction`, and `c13a Background Tool Tasks`.

## Setup

Use Node.js `20.19.0` or newer.

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
OPENAI_BASE_URL=
```

Leave `OPENAI_BASE_URL` empty unless you use a proxy or an OpenAI-compatible gateway.

## Docs

- [c00 Orientation](docs/tutorial/c00-orientation.md): first checkpoint for the course direction and docs-only baseline.
- [c01 Minimal Real Loop](docs/tutorial/c01-minimal-real-loop.md): first runnable checkpoint with a real LLM tool-call round trip.
- [c02 Tool Runtime](docs/tutorial/c02-tool-runtime.md): registry, dispatcher, and unified tool results for `bash`, `read`, and `ls`.
- [c03 Permission Governance](docs/tutorial/c03-permission-governance.md): pre-tool permission decisions for `allow`, `ask`, and `deny`.
- [c04 Reviewable File Editing](docs/tutorial/c04-reviewable-file-editing.md): structured `edit` and `write` tools with diff-like results.
- [c05 Context Projection](docs/tutorial/c05-context-projection.md): `grep` / `find` search tools plus `Observation` and projected tool feedback.
- [c06 Session / Trace](docs/tutorial/c06-session-trace.md): local session metadata and JSONL trace events for each run.
- [c07 Runtime State Model](docs/tutorial/c07-runtime-state-model.md): in-memory `RuntimeState` projection for the current run.
- [c08 Verification / Recovery](docs/tutorial/c08-verification-recovery.md): deterministic checks before final answer, with one recovery attempt on failure.
- [c09 Hooks](docs/tutorial/c09-hooks.md): lifecycle event emitter and observe-only hooks for cross-cutting behavior.
- [c10 Task / Todo](docs/tutorial/c10-task-todo.md): in-run task state, todo snapshots, and visible acceptance criteria.
- [c11 System Prompt / Skills / Memory](docs/tutorial/c11-system-prompt-skills-memory.md): prompt assembly from base rules, project memory, skill catalog, and slash-selected skills.
- [c12 Context Compaction](docs/tutorial/c12-context-compaction.md): LLM summary handoff for older conversation history, with trace evidence.
- [c13a Background Tool Tasks](docs/tutorial/c13a-background-tool-tasks.md): session-scoped background bash tasks with notification return flow.
- [Project architecture](docs/01-project-architecture.md): target harness shape, module boundaries, and chapter mapping.
- [Tutorial roadmap](docs/02-tutorial-roadmap.md): chapter order, milestones, and where each chapter comes from.
- [Writing style](docs/03-writing-style.md): how tutorial chapters should read.
- [Agent instructions](AGENTS.md): rules for coding agents working in this repo.

## Who this is for

This project is for engineers who want to understand coding agent runtime design by building one small piece at a time.

You should be comfortable reading TypeScript and running CLI tools. You do not need to know agent framework internals.

## Course shape

The course has two parts:

- `Part 1: Core Harness` builds the single-agent runtime.
- `Part 2: Scale & Extensions` handles longer tasks, wider boundaries, and external tools after the core is stable.

The detailed route is in [docs/02-tutorial-roadmap.md](docs/02-tutorial-roadmap.md).

## What "production-like" means here

`production-like` does not mean SaaS, dashboards, multi-tenant auth, or a complete platform.

In this course it means the harness can govern actions, record what happened, recover useful state, verify work before final answer, and accept new mechanisms without turning the loop into special cases.

See [docs/01-project-architecture.md](docs/01-project-architecture.md) for the system model.

## Non-goals

The early course does not start with LangGraph, AutoGen, MCP, a multi-agent platform, a benchmark suite, or a UI.

Those topics can appear later, after the core harness has stable boundaries.
