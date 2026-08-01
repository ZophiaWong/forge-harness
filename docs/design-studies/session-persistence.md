# Session persistence

## Pressure

An in-memory loop cannot answer basic questions after exit: what task ran, which workspace it used, which calls were approved, why verification failed, or which child produced an edit. Saving the whole live object graph would create a different problem because transient handles and current projections are not a stable audit format.

Forge persists evidence and reconstructs only the state needed during the current run.

## Forge design

Each CLI run creates `.forge/sessions/<session-id>/session.json` and `trace.jsonl`. Root Sessions also own `task-graph.json`; teammate mailboxes and delegated Session artifacts remain under the same run-owned area.

`session.json` records identity and configuration. `trace.jsonl` is append-only and sequence ordered. [`RuntimeState`](../../src/runtime/state.ts) is an in-memory projection of current facts such as the latest tool result, verification status, pending child handoff, and teammate state. It is not serialized as a second source of truth.

This design supports inspection after a run without implying resume. The c17c Runtime does not replay Trace events, reconcile partially completed Git operations, or reopen blocked tasks after a process failure.

## Comparison

| System | Current approach | Useful contrast for Forge |
| --- | --- | --- |
| [Pi](https://pi.dev/docs/latest/sessions) | Sessions auto-save by working directory and support resume, tree navigation, fork, clone, compaction, and export. Its [Session format](https://pi.dev/docs/latest/session-format) records a tree of typed JSONL entries. | Forge's format is a linear Runtime event ledger plus domain files. It favors explicit execution evidence over interactive conversation branching. |
| [Codex](https://learn.chatgpt.com/docs/environments/git-worktrees) | App chats can remain associated with managed Worktrees and move between Worktree and Local through Handoff. | Forge binds a Session to a generated Worktree, but it has no client-level chat handoff or resume lifecycle. |
| [Claude Code](https://code.claude.com/docs/en/sessions) | CLI conversations are saved continuously to local JSONL transcripts and can be resumed, named, branched, exported, or disabled for non-persistent runs. | Forge records Runtime-domain events rather than treating the rendered conversation transcript as the main evidence surface. |
| [Aider](https://aider.chat/docs/git.html) | Git commits provide durable, reviewable edit history and an undo path. | Forge also uses Git receipts, but Git cannot replace tool, permission, verification, or mailbox evidence, so it remains one part of the Session record. |

## Trade-offs

JSON and JSONL are easy to inspect and test. A file-backed TaskGraph with locking and atomic rename is sufficient for processes on one host. It is not a transactional event store, and several files can reflect different moments if the process crashes between writes.

Raw Session directories contain prompts, model text, identifiers, timestamps, and machine-specific paths. The repository therefore commits only curated snapshots for selected Demos. Those snapshots preserve observed invariant order but do not replace local raw evidence.

## Boundary

There is no crash-safe resume, Attempt model, idempotent replay, reconciliation pass, schema migration framework, retention service, remote evidence store, or cryptographic attestation. The cleanup command removes generated local artifacts; it is not an archival policy.

## Deep dive

For a frozen source-level comparison with the research evidence ledger, read [Session Persistence and Branching](https://github.com/ZophiaWong/forge-harness/blob/research/agent-runtime-design-studies/docs/design-studies/04-session-persistence-and-branching.md) on the separate research branch.
