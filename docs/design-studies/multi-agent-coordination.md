# Multi-agent coordination

## Pressure

Delegating a prompt and collecting a summary is enough for isolated research. It is not enough for concurrent edits or team completion. The Runtime must know who owns work, which source produced an edit, whether acceptance was checked, whether integration occurred, and whether every worker has actually stopped.

c17c turns those facts into a root-run-scoped protocol.

## Forge design

Forge has two delegation shapes. One-shot child Sessions return a terminal handoff and cannot recursively delegate. Long-lived teammates have names, independent Session context, persistent FIFO mailboxes, and explicit lifecycle state. Edit-capable workers receive separate Git Worktrees.

The root Session owns a shared TaskGraph with task kind, dependencies, acceptance criteria, owner, evidence, review state, verification state, and integration receipt. File locking serializes graph mutation. Evidence is actor-owned rather than accepted from any caller.

Research completes after submission and Leader review. Edit work also requires plan approval, a registered source, fingerprint consistency, the exact verification contract, a source commit, and cherry-pick receipt. [`createCompletionGate()`](../../src/runtime/completionGate.ts) checks completed tasks, healthy graph state, settled children and background work, stopped teammates, empty unread mail, and no active cherry-pick before the root verifier runs.

Mailbox delivery is at most once. Owner failure blocks active work, and `teammate_rejoin` does not reopen it automatically. This makes the absence of recovery machinery explicit.

## Comparison

| System | Current approach | Useful contrast for Forge |
| --- | --- | --- |
| [Pi sub-agent](https://pi.dev/packages/pi-sub-agent) | A parent can run one, parallel, or chained child Pi processes with narrowed tool lists and isolated context. Recursive subagent use is removed from child tool lists. | Forge one-shot children are similarly parent-coordinated, but the Runtime also registers edit sources and blocks root finalization on pending handoffs. |
| [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | Specialized agents run in separate threads and return summaries to the main thread; the documentation recommends care with parallel write-heavy work. | Forge makes that write risk concrete through Git Worktrees, TaskGraph ownership, verification, and explicit integration. |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) | A lead coordinates independent teammates through a shared task list and messaging. The official documentation also calls out coordination, resumption, and shutdown limitations. | Forge uses a similar lead, task, mailbox shape, but narrows completion to two task kinds and a deterministic CompletionGate rather than general team autonomy. |
| [Aider Git integration](https://aider.chat/docs/git.html) | Agent edits become commits that are reviewable and undoable. | Forge uses commits as source and integration receipts, but does not treat a commit alone as proof that a team task met its contract. |

## Why CompletionGate exists

The model sees only a context projection and can decide that the narrative looks finished. The Runtime sees pending child handles, teammate lifecycle, unread mail, TaskGraph status, and Git state. CompletionGate centralizes those deterministic facts instead of asking the model to remember a checklist.

A ready gate is not recorded as a new semantic Trace event at c17c. Evidence comes from the checked invariant state followed by root verification, `final_answer`, and `session_ended`. Terminal gate failure is recorded explicitly.

## Trade-offs

The protocol makes a live Demo longer because ownership, review, verification, integration, and shutdown are separate calls. That cost buys inspectable failure locations. A submitted edit can be distinguished from a verified edit, and both can be distinguished from an integrated edit.

The graph and mailboxes are local files, so the design fits one root run on one host. It avoids pretending to solve worker leases, leader election, distributed locks, or split-brain recovery.

## Boundary

Forge does not provide remote workers, nested teams, dynamic leader transfer, automatic task retry, task unblocking, exactly-once processing, high availability, or cross-run reconciliation. Those concerns belong to a later reliability model and are intentionally absent from the frozen c17c Runtime.
