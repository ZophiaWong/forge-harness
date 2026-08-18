# Forge Harness: recruiter portfolio

## What Forge Harness builds

Forge Harness is a from-scratch TypeScript coding-agent Runtime. The project starts with a runnable model-tool loop and grows through independently runnable checkpoints that add governed tool execution, context management, durable execution evidence, trusted extensions, Worktree-isolated delegation, and multi-agent coordination.

The course path preserves 22 runnable checkpoints. The current implementation reaches `c17c Coordination / Completion Protocol`. Source, tests, deterministic smoke runs, curated live evidence, and offline eval reports document the behavior boundaries.

## Runtime responsibilities

| Layer | Runtime responsibility |
| --- | --- |
| `L1 Loop & Execution` | Turns, model requests, tool calls, tool results, and final-answer flow. |
| `L2 Governance & Action Boundary` | Permission decisions, approvals, path boundaries, and extension trust. |
| `L3 Context & Knowledge` | Prompt assembly, memory, skills, observations, mailbox messages, and compaction. |
| `L4 State, Evidence & Reliability` | Session metadata, Trace events, RuntimeState, verification, receipts, and eval reports. |
| `L5 Coordination & Scale` | Background work, child Sessions, Worktrees, TaskGraph, teammates, and CompletionGate. |

## Representative engineering decisions

These stories are selective entry points, not a complete capability list.

1. **Permission before dispatch.** A valid-looking write still crosses an explicit `allow`, `ask`, or `deny` policy before its handler can run. The deterministic demo checks that a denied request leaves the handler dispatch count at zero.
2. **Context versus Trace.** The next model decision uses bounded observations and a lossy compaction summary. The append-only Trace keeps ordered Runtime facts. A prompt projection is not the historical ledger.
3. **Offline eval found a regression.** A fixed compaction scenario recorded ordered reads falling from `3` to `2`. The report retains the first valid comparable candidate under its experiment identity and does not resample for a preferred verdict. See the [offline eval guide](docs/offline-eval.md) and [regression report](docs/assets/evidence/offline-eval-regression-report.md).

## c17c integration result

The c17c protocol connects the layers around one edit task. A teammate first submits a plan, the Leader approves it, and the edit happens in an isolated Worktree. The source is fingerprinted, verified with its registered command, committed, and integrated with a Git receipt. `CompletionGate` reports the missing obligation when a candidate arrives early and allows root verification only after the team state is complete.

The public live snapshot records one observed run. It does not guarantee future model behavior. The [c17c evidence](docs/assets/evidence/c17c-team-completion.json) and [architecture overview](docs/architecture-overview.md) contain the detailed state transitions.

## Interview demo modes

Prerequisites: Node.js `>=20.19`, Git, and Bash on Linux, macOS, or WSL2. Native Windows shell and WSL1 are not supported because the Runtime executes Bash commands.

For a roughly three-minute screen share, run:

```bash
npm ci
npm run demo:portfolio -- --explain
```

`npm ci` installs dependencies and may access the package registry over the network. After installation, the `npm run demo:portfolio -- --explain` command uses no model, does not read `.env`, and makes no network request. It uses temporary Git repositories and Worktrees. It runs the same three independent scenes as the default command, with stable sanitized annotations that explain the Runtime boundary behind each receipt:

```text
scene.action-boundary PASS deny-before-dispatch
scene.verification-recovery PASS recovery-before-final
scene.coordination-completion PASS receipt-before-ready
```

The scenes are deterministic mechanism checks, not one live Session. CI runs the default deterministic command, which exercises the same scenes as `--explain`. See the [demo source](src/portfolio/demo.ts) and [CI job](.github/workflows/ci.yml).

An optional 5 to 8 minute extension is available when an interactive terminal, Git, Bash, Node.js `>=20.19`, `OPENAI_API_KEY`, and `OPENAI_MODEL` are available:

```bash
npm run demo:portfolio:live
```

The Live launcher generates a dependency-free retry-policy repository in the system temporary directory and confirms that its initial tests fail. The tests cover first-attempt success, recovery from transient failures, `maxAttempts` as the total operation limit, and immediate exit on a permanent failure. It then starts the existing Forge CLI with an isolated root Worktree and `npm test` as the root verifier. The original Runtime transcript and manual approvals remain visible in the terminal.

The prompt fixes the walkthrough topology at one edit task and one synchronous edit child. That constraint keeps the interview within a predictable time window and gives the submission, verification, and Git receipt one clear source. It asks the model to keep implementation changes in `src/**`, while leaving the task wording, files to inspect, implementation, edit count, and protocol call sequence to the model. Before reporting PASS, the validator reconciles the persisted submission and Git receipt with the final root Worktree. It requires a clean Worktree, binds receipt `targetBefore` to the recorded Worktree base, matches root `HEAD` to `integratedCommit`, and requires the complete `targetBefore..HEAD` path set to equal the child submission's `changedFiles`. The fixed topology is a demo boundary, not a Runtime limit.

The launcher starts a ten-minute timer before fixture allocation and uses one cooperative cancellation signal from fixture initialization through the initial tests, Forge child, and final evidence validation. This is not a hard wall-clock deadline: an operation that cannot be interrupted is allowed to return before the launcher advances to cleanup. The outer launcher exclusively owns every allocated fixture path and removes it exactly once without passing the cancellation signal. The first timeout or operator signal fixes the cancellation reason. An active child receives `SIGTERM` on timeout or the original operator `SIGINT`/`SIGTERM`; if it has not exited after two seconds, the launcher sends `SIGKILL` once. The ten-minute timer stops before cleanup, while signal handlers remain installed until cleanup finishes, so a first operator signal during cleanup still prevents PASS. A removal failure reports `cleanup_failed` even when another result was already selected. This is one variable model observation, not a benchmark, CI check, or reusable evidence. If it fails, return immediately to the deterministic walkthrough instead of debugging it during the interview.

## Evidence and boundaries

The [Evidence Index](docs/evidence-index.md) maps each claim to source, focused tests, deterministic smoke runs, optional live evidence, and a stated limitation. The [engineering case study](docs/engineering-case-study.md) explains the failures and design choices in sequence.

The c17c Runtime does not claim OS-level sandboxing, crash-safe resume or reconciliation, distributed scheduling, durable cross-run queues, deterministic model reasoning, statistical eval significance, or a hosted Web UI. Approved extensions still run in-process with host permissions.
