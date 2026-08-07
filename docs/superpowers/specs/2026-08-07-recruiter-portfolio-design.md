# Recruiter Portfolio Design

## Goal

Give a recruiter a truthful three-minute entry point into the c17c Runtime without adding a product feature or pretending that three deterministic scenes are a live model session.

## Deterministic demo contract

`demo:portfolio` uses no model, no `.env`, and no network. It creates temporary Git repositories/worktrees and always removes them in `finally`. The output is a stable sequence of aliases, statuses, and short receipts:

1. `Action Boundary`: a write request is denied before dispatch; a dispatch counter proves the handler never ran.
2. `Verification Recovery`: a scripted candidate enters the real verification loop, fails once, recovers, then reaches final only after verification passes.
3. `Coordination Completion`: plan approval precedes an editor worktree write; an early `CompletionGate` is incomplete; fingerprint, verification, Git receipt, and a ready gate follow in order.

Any failed assertion exits non-zero. The scenes are independent demonstrations, not one continuous Session.

## Public information architecture

- `PORTFOLIO.md` and `PORTFOLIO.zh-CN.md` answer the recruiter questions directly.
- `docs/interview-cue-cards.md` and its Chinese counterpart contain only a 2–3 minute speaking rhythm, trade-offs, evidence links, and follow-up prompts.
- `README.md` and `README.zh-CN.md` expose links near the first screen but do not duplicate the portfolio narrative.
- The canonical detailed facts remain in `docs/engineering-case-study.md`, `docs/evidence-index.md`, and operational runbooks.

The three public stories are permission-before-dispatch, context-vs-Trace, and offline-eval compaction regression. They cover the core engineering judgment; the Evidence Index remains the complete capability map.

## Platform and CI boundary

The project supports Linux, macOS, and WSL2 with Node >=20.19, Git, and Bash. Native Windows shell and WSL1 are not supported because the Runtime intentionally executes Bash commands. Ubuntu CI runs the deterministic demo as a no-secret, no-model smoke check.

