# Forge Harness — recruiter portfolio

Forge Harness is a from-scratch TypeScript coding-agent Runtime. A model's “done” is a candidate, not proof.

## Why “done” is not enough

A fluent answer does not prove that a write was permitted, the right workspace changed, a verifier passed, or delegated work was integrated. Forge makes those decisions explicit and records inspectable evidence.

## What the Runtime decides

- Permission policy decides `allow`, `ask`, or `deny` before a tool handler is dispatched.
- Prompt context is bounded; durable Trace remains the historical ledger.
- Worktree ownership, TaskGraph transitions, plan approval, source fingerprints, verification, Git receipts, and CompletionGate state are Runtime obligations.
- The root verifier decides whether a candidate can become a final answer.

See the complete [Evidence Index](docs/evidence-index.md) and [Architecture overview](docs/architecture-overview.md).

## Three failure stories

1. **Permission before dispatch.** An in-scope-looking write can still be denied before its implementation runs; the deterministic demo proves the dispatch counter stays at zero.
2. **Context versus Trace.** Compaction keeps the next decision bounded, while append-only Trace preserves ordered evidence. Compacted context is useful state, not an audit ledger.
3. **Offline-eval compaction regression.** A fixed scenario caught ordered reads falling from `3` to `2`; Trace isolated repeated-compaction loss. The valid candidate stayed frozen instead of being resampled for a preferred verdict. See the [offline-eval guide](docs/offline-eval.md) and [public report](docs/assets/evidence/offline-eval-regression-report.md).

These are recruiter stories, not a complete capability list. The Evidence Index covers MCP/plugin trust, child Sessions, teammates, TaskGraph, verification, cleanup, and their boundaries.

## Three-minute deterministic demo

Prerequisites: Node.js `>=20.19`, Git, and Bash on Linux, macOS, or WSL2. Native Windows shell and WSL1 are not supported because the Runtime executes Bash commands.

```bash
npm ci
npm run demo:portfolio
```

The command makes no model call, reads no `.env`, uses temporary Git repositories/worktrees, and emits:

```text
scene.action-boundary PASS deny-before-dispatch
scene.verification-recovery PASS recovery-before-final
scene.coordination-completion PASS receipt-before-ready
```

The scenes are independent, not one live Session. See [demo source](src/portfolio/demo.ts) and [CI](.github/workflows/ci.yml).

## What is not implemented

This c17c Runtime does not claim OS-level sandboxing, crash-safe resume/reconciliation, distributed scheduling or consensus, durable cross-run queues, deterministic model reasoning, statistical eval significance, or a hosted Web UI. Approved extensions still run in-process with host permissions.

See the [engineering case study](docs/engineering-case-study.md) and [interview cue cards](docs/interview-cue-cards.md) for trade-offs and speaking prompts.

