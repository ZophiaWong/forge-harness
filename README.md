# Forge Harness

[简体中文](README.zh-CN.md)

[Recruiter portfolio](PORTFOLIO.md) · [Interview cue cards](docs/interview-cue-cards.md)

Forge Harness is a from-scratch TypeScript coding-agent Runtime. The project starts with a runnable model-tool loop and grows through independently runnable checkpoints that add governed tool execution, context management, durable execution evidence, trusted extensions, Worktree-isolated delegation, and multi-agent coordination.

The current implementation reaches `c17c Coordination / Completion Protocol`. Source, tests, deterministic smoke runs, curated historical snapshots, and offline eval reports document the behavior boundaries. The Chinese tutorial explains how the Runtime grew from one checkpoint to the next.

The repository provides source code for local inspection and execution, not a hosted service.

## One observed completion

The historical [c17c live snapshot](docs/assets/evidence/c17c-team-completion.json) records one model-driven run captured at source commit `75714f2`:

```text
pre-approval writes  blocked
edit plan            approved
artifact write       completed in teammate Worktree
task verification    passed
Git integration      receipt recorded
premature candidate  deferred
teammates            stopped, unread=0
root verification    passed
session              completed in 31 rounds
```

This records one run and does not guarantee future model behavior. `npm run smoke:c17c-capstone` is a deterministic, model-free check of TaskGraph ownership, review, verification, Git integration, and CompletionGate invariants. It does not replay the live run.

## Runtime at a glance

![Forge Harness c17c Runtime architecture](docs/assets/architecture-overview.svg)

A root run owns the full decision path:

```text
prompt assembly
  -> model response
  -> permission policy and optional approval
  -> Tool Runtime
  -> bounded observation and Trace evidence
  -> TaskGraph, child, teammate, and Git obligations
  -> CompletionGate
  -> root verifier
  -> final answer
```

The five Forge layers are architecture lenses, not chapter order:

| Layer | Responsibility |
| --- | --- |
| `L1 Loop & Execution` | Model turns, tool dispatch, and final-answer flow. |
| `L2 Governance & Action Boundary` | Permission decisions, approvals, path boundaries, and extension trust. |
| `L3 Context & Knowledge` | Prompt assembly, memory, selected skills, observations, and compaction. |
| `L4 State, Evidence & Reliability` | Session metadata, Trace events, RuntimeState, verification, and receipts. |
| `L5 Coordination & Scale` | Background work, Worktrees, child Sessions, TaskGraph, teammates, and CompletionGate. |

Read the [Architecture overview](docs/architecture-overview.md) for module ownership, state boundaries, and the c17c completion protocol.

## What is governed

- Built-in and MCP tool calls cross an explicit `allow`, `ask`, or `deny` policy before execution.
- Tool results use one structured path into bounded observations, RuntimeState, and the append-only Trace.
- A candidate answer is not final until pending activity settles, CompletionGate is ready, and the configured verifier passes.
- Edit-capable root, child, and teammate work can use generated Git Worktrees with recorded source identity.
- Plugins pass descriptor preflight and a per-Session trust decision before import or MCP startup.
- c17c requires actor-owned evidence, review, edit-plan approval, source verification, Git integration receipts, teammate shutdown, and completed team state.

The [Evidence Index](docs/evidence-index.md) maps each statement to source, tests, deterministic smoke runs, optional live evidence, and a stated limitation.

## Setup

Use Node.js `20.19.0` or newer.

```bash
npm install
cp .env.example .env
npm run build
```

Set the model connection in `.env`:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
OPENAI_BASE_URL=
```

Leave `OPENAI_BASE_URL` empty for the default OpenAI endpoint. A compatible gateway can be configured explicitly.

## Run the CLI

Start with a bounded read task:

```bash
npm run start -- "Read package.json and summarize the available Runtime commands. Do not modify files."
```

Add a root verifier when completion needs a command-level invariant:

```bash
npm run start -- --verify "npm run build" "Inspect the project and report readiness only after the verifier passes."
```

Bind the root run to a generated Git Worktree when the task may edit files:

```bash
npm run start -- --worktree "Inspect the repository and make one explicitly requested change."
```

These commands call the model service configured in `.env`. Mutation, plugin trust, external tools, verification, and Git integration may require interactive approval.

## Deterministic validation

The main checks do not call a model service:

```bash
npm run docs:check
npm run typecheck
npm run test
npm run build
```

Two focused c17c smoke tests exercise the integration path without model output:

```bash
npm run smoke:c17c-capstone
npm run smoke:c17c-child
```

The capstone smoke combines TaskGraph ownership, review, verification, Git integration, and CompletionGate. The child smoke focuses on one-shot edit-source integration. Neither proves future model adherence or external service availability.

## Release evidence

Release evidence has a separate lifecycle from an ordinary demo or eval:

```text
execute -> validate -> preserve raw bundle -> promote evidence
```

The unified `npm run evidence` CLI preregisters an exact clean tag/commit/tree and collector commit, captures Live or 13-attempt Eval raw material, writes per-file and archive SHA-256 values, keeps behavioral verdict separate from capture status, and verifies promoted public/private assets. A capture failure never turns a behavioral failure into a pass, and an unsealed run cannot support a release claim.

Public manifests and sanitized reports are intended for the matching GitHub Release. Raw archives and private inventories are intended for the maintainer-only `ZophiaWong/forge-harness-evidence` companion repository. Existing curated snapshots are useful historical observations, but they are not a substitute for a fresh release manifest linked to raw attempts or Sessions.

See the Chinese [Release evidence runbook](docs/release-evidence.md) for the frozen `v1.0.0` backfill, the `v1.0.1` baseline/candidate gate, infrastructure-only retries, upload approval boundaries, and download-after-upload verification. The repository does not claim that a version has completed this process until its Release assets can pass `npm run evidence -- verify`.

## Offline behavioral eval

The pre-deployment eval runs 13 model-driven attempts against fixed Forge scenarios, then compares deterministic grader counts with a versioned baseline:

```bash
npm run eval -- run --model <model>
```

Here “offline” means outside real user traffic, not disconnected from the model API. Token and latency telemetry is reported but never changes the behavioral verdict. Version 1 has no LLM judge, price table, model leaderboard, automatic pull-request trigger, or nightly model run.

The linked historical [regression report](docs/assets/evidence/offline-eval-regression-report.md) records the first independent valid and comparable batch for its then-current hardened identity at source commit `6f4630a3c266433a1234a08b4b738c81516dcf99`. Its `REGRESSED` verdict is kept as-is: async child handoff improved, while one compaction ordering assertion declined. The matching historical baseline is committed at [`eval/baselines/`](eval/baselines/), and the candidate was not resampled for a preferred verdict. Changes to the Eval contract make later runs a new identity rather than silently reusing that baseline.

The suite, baseline promotion rules, exit codes, manual GitHub workflow, and cleanup boundary are documented in [Offline eval and regression reports](docs/offline-eval.md). The eval is evergreen Runtime hardening and does not consume tutorial chapter `c18`.

## Demo runbooks

- [Verification / Recovery](docs/demos/verification-recovery.md)
- [Worktree isolation](docs/demos/worktree-isolation.md)
- [Async child handoff](docs/demos/async-child-handoff.md)
- [MCP and plugin trust](docs/demos/mcp-plugin-trust.md)
- [c17c team completion](docs/demos/c17c-team-completion.md)

Each runbook separates a repeatable deterministic check from an optional model-driven run.

## Documentation

- [Architecture overview](docs/architecture-overview.md): current c17c execution, state, trust, isolation, and completion boundaries.
- [Engineering case study](docs/engineering-case-study.md): the failures that forced each Runtime mechanism and the alternatives not taken.
- [Evidence Index](docs/evidence-index.md): claim-to-source, test, smoke, and live-evidence mapping.
- [Offline eval](docs/offline-eval.md): canonical scenarios, comparability, baseline promotion, reports, and limitations.
- [Release evidence runbook](docs/release-evidence.md): fresh source binding, raw bundle sealing, promotion, private storage, and release verification.
- [Design Studies](docs/design-studies/README.md): context management, Tool Runtime, Session persistence, and multi-agent coordination.
- [Deep Agent Runtime Research](https://github.com/ZophiaWong/forge-harness/tree/research/agent-runtime-design-studies/docs/design-studies): separate-branch source studies comparing Forge, Pi, and a provenance-limited Claude local snapshot across loop completion, tool boundaries, context, Sessions, coordination, and extension trust.
- [Tutorial roadmap](docs/02-tutorial-roadmap.md): the two-part Chinese learning path.
- [Project architecture](docs/01-project-architecture.md): tutorial-era target boundaries and checkpoint mapping.
- [Appendix](docs/appendix/minimal-mcp-server.md): local MCP and plugin fixtures used by the extension chapters.
- [Agent instructions](AGENTS.md): repository rules for coding agents.

## Tutorial path

The tutorial answers a different question from the Runtime documentation: how did the system reach its current shape?

- `Part 1: Core Harness` develops the single-agent execution, governance, context, evidence, and verification path.
- `Part 2: Scale & Extensions` adds background work, Worktrees, isolated delegation, MCP, plugins, TaskGraph, teammates, and c17c completion.

Start at [c00 Orientation](docs/tutorial/c00-orientation.md) or use the [Tutorial roadmap](docs/02-tutorial-roadmap.md). The tutorial remains in Chinese and is not rewritten as portfolio or release material.

## Clean local run artifacts

Runs can accumulate local data under `.forge/sessions/` and `.forge/worktrees/`:

```bash
npm run clean:runs
```

The command reports counts and asks for `y/N`. Automation can opt in explicitly:

```bash
npm run clean:runs -- --yes
```

Cleanup removes registered generated Worktrees through Git, then deletes only the two generated roots. It preserves `.forge/mcp.json`, plugins, memory, skills, and Git branches.

## Boundaries

The c17c Runtime does not implement crash-safe resume, Attempts, idempotent replay, reconciliation, distributed coordination, remote workers, high availability, an operating-system sandbox, a plugin marketplace, RAG, a vector database, a web UI, or a hosted control plane.

Git Worktrees isolate file changes, not processes, credentials, network access, or host permissions. Approved plugin hooks are trusted in-process code. Live model runs are examples, while deterministic tests and smoke commands are the repeatable evidence layer.

## License

Licensed under the [Apache License 2.0](LICENSE).
