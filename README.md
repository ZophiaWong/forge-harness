# Forge Harness

Forge Harness is a tutorial-driven, from-scratch coding agent harness built in TypeScript.

It starts with the most direct coding-agent loop:

```text
user -> LLM -> tool_use -> bash -> tool_result -> LLM -> done
```

Then it hardens that loop one problem at a time. Each tutorial stage begins with something uncomfortable in the previous stage, then forges the next harness mechanism to solve it: tool structure, permission governance, context projection, trace persistence, session recovery, verification, and extension points.

This is not primarily a framework demo. The value of the project is in implementing the agent harness runtime mechanics directly, while keeping the first runnable experience easy to see and easy to reason about.

## Core Summary

Forge Harness begins with:

```text
Agent Loop
+ Tool Use
+ Context Management
+ Permission Governance
+ Session Persistence
```

The repository is both:

1. An implementation-first engineering project.
2. A tutorial-style breakdown of how the harness evolves.

The runnable code is the primary artifact. The documentation explains the design decisions, milestones, and implementation path.

## Tutorial Method

The learning path should feel like forging a harness from a working loop:

```text
direct implementation
  -> exposed pain point
  -> harness mechanism
  -> stronger implementation
```

Stage 1 should not start by asking readers to understand a full runtime architecture. It should show a real LLM calling a simple bash tool, feeding the result back into messages, and stopping when the model stops asking for tools.

Later stages then ask practical questions:

- Bash can do anything. How do we govern side effects?
- Tool outputs get noisy. What should the model actually see next?
- The run is hard to inspect. What should we trace?
- The process can be interrupted. What is a session?
- The model says it is done. How do we verify that?

## Why This Exists

Forge Harness is intended for learning, portfolio use, and incremental development toward AI Agent / LLM Application Engineer roles.

The goal is not only to write a tutorial, and not only to recreate an existing tool. The goal is:

> I implemented an agent harness, and I organized the implementation process as a tutorial.

## What It Is Not

Forge Harness is not:

- A LangGraph, AutoGen, or framework-first project.
- A dashboard or TypeScript UI.
- A complete MCP adapter.
- A multi-agent platform.
- A production SaaS.
- A benchmark suite.
- A clone or fork of Claude Code, learn-claude-code, or Pi.

Those projects and ideas inform the capability map, but Forge Harness follows its own implementation path.

## Current Status

Initial scaffold.

The repository currently contains project direction, architecture notes, tutorial planning, terminology, and a lightweight TypeScript project shell. The real agent runtime has not been implemented yet.

## Initial Roadmap

- Stage 0: high-level overview and the direct agent-loop mental model.
- Stage 1: real LLM, one bash tool, messages history, tool result feedback, and stop condition.
- Stage 2: tool runtime, introduced because a single inline bash function does not scale.
- Stage 3: permission governance, introduced because raw bash is too powerful.
- Stage 4: context management, introduced because raw messages and tool output become noisy.
- Stage 5: session and trace runtime, introduced because runs need inspection, resume, fork, and replay.
- Stage 6: verification and recovery, introduced because a coding agent should prove work before claiming completion.
- Stage 7: extensions, introduced after the single-agent foundation is real.

Start with [docs/tutorial/c00-overview.md](docs/tutorial/c00-overview.md) for the first tutorial chapter. See [docs/03-tutorial-roadmap.md](docs/03-tutorial-roadmap.md) for the full tutorial path.

## Project Layout

```text
src/
  cli/          CLI entry points.
  core/         Agent loop, turn orchestration, minimal LLM integration.
  domain/       Types, protocols, event models, tool calls/results, sessions, traces.
  tools/        Tool registry, schema, dispatcher, and tool implementations.
  governance/   Permission policy, risk classification, approvals, command risk rules.
  context/      Context projection, observation normalization, compaction placeholder.
  runtime/      Session store, trace writer, workspace management, persistence.
  extensions/   Future hooks, skills, subagents, MCP adapter, worktree isolation.
```

## Placeholder Commands

Install dependencies when implementation begins:

```sh
npm install
```

Type-check the scaffold:

```sh
npm run typecheck
```

Build the placeholder CLI:

```sh
npm run build
```

Run the placeholder CLI after building:

```sh
npm run start
```

## Documentation

Tutorial lesson documents live in `docs/tutorial/`. Tutorial lessons are written in Chinese, with technical terms kept in English, and should follow the tutorial writing style guide. Historical runnable lesson states are captured by chapter-based branches and tags such as `tutorial/c01-minimal-real-llm-loop` and `tutorial-c01-minimal-real-llm-loop`; see the roadmap for the full strategy.

- [Project Charter](docs/00-project-charter.md)
- [Architecture](docs/01-architecture.md)
- [Principles](docs/02-principles.md)
- [Tutorial Roadmap](docs/03-tutorial-roadmap.md)
- [Tutorial c00 Overview](docs/tutorial/c00-overview.md)
- [Glossary](docs/04-glossary.md)
- [Tutorial Writing Style](docs/05-tutorial-writing-style.md)
- [Reference Notes](docs/reference/pi-versus-claude.md)
