# Forge Harness

Forge Harness is a tutorial project for building a coding agent harness from scratch in TypeScript.

The course starts with one real loop:

```text
user -> LLM -> tool_call -> tool_result -> LLM -> done
```

Then each chapter pulls one problem out of that loop and turns it into a small harness mechanism.

## Status

This branch contains the documentation baseline plus the first three runnable checkpoints: `c01 Minimal Real Loop`, `c02 Tool Runtime`, and `c03 Permission Governance`.

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
