# Architecture overview

Forge Harness is a TypeScript coding-agent runtime. A root run owns the model loop, action policy, context projection, Session evidence, optional isolated workspaces, delegated sessions, and the c17c team completion protocol.

This document describes the Runtime behavior at the `c17c Coordination / Completion Protocol` boundary plus an evergreen offline regression harness. The eval does not introduce a new tutorial chapter. The [project architecture](01-project-architecture.md) and [tutorial roadmap](02-tutorial-roadmap.md) discuss how the course reached c17c and the future pressure that remains outside this hardening work.

![Forge Harness c17c runtime architecture](assets/architecture-overview.svg)

## Runtime path

The CLI prepares durable state before it asks the model to act. It creates a root Session, initializes the root TaskGraph, optionally binds the run to a Git Worktree, resolves configured plugins and MCP servers, collects trust decisions, and then starts the loop. See [`src/cli/index.ts`](../src/cli/index.ts) and [`src/runtime/session.ts`](../src/runtime/session.ts).

Each model round follows one execution contract:

1. Prompt assembly combines base instructions, tool rules, project memory, and explicitly selected skills.
2. Context management adds pending notifications, projects tool results into observations, and compacts older input when the configured budget requires it.
3. The model returns text, one tool call, or both.
4. A permission policy classifies the requested action as `allow`, `ask`, or `deny` before the Tool Runtime can execute it.
5. Approved tools return a common `ToolResult`. The loop records the call, decision, approval, result, and current projection.
6. A candidate answer must clear pending background, child, teammate, TaskGraph, Git, and verification obligations before it becomes final.

The loop may repeat this path for several rounds. A denied action, failed tool, incomplete completion gate, or recoverable verification result returns structured information to the next model round instead of being treated as success.

## Five architecture lenses

The five Forge layers describe engineering responsibilities. They are not five directories and they do not match tutorial order.

| Layer | Runtime responsibility | Current owners |
| --- | --- | --- |
| `L1 Loop & Execution` | Turn control, model requests, tool dispatch, and final-answer flow. | [`src/core/minimalLoop.ts`](../src/core/minimalLoop.ts), [`src/tools/runtime.ts`](../src/tools/runtime.ts), [`src/tools/compositeRuntime.ts`](../src/tools/compositeRuntime.ts) |
| `L2 Governance & Action Boundary` | Risk classification, permission decisions, approvals, path boundaries, plan review, and trusted startup. | [`src/governance/`](../src/governance), [`src/cli/approval.ts`](../src/cli/approval.ts), [`src/tools/pathBoundary.ts`](../src/tools/pathBoundary.ts), [`src/extensions/pluginPreflight.ts`](../src/extensions/pluginPreflight.ts) |
| `L3 Context & Knowledge` | Prompt inputs, selected skills, project memory, observations, compaction summaries, notifications, and mailbox messages. | [`src/context/`](../src/context), [`src/core/minimalLoop.ts`](../src/core/minimalLoop.ts) |
| `L4 State, Evidence & Reliability` | Session metadata, append-only Trace events, RuntimeState projection, verification results, task evidence, integration receipts, and offline regression reports. | [`src/runtime/session.ts`](../src/runtime/session.ts), [`src/runtime/trace.ts`](../src/runtime/trace.ts), [`src/runtime/state.ts`](../src/runtime/state.ts), [`src/runtime/verification.ts`](../src/runtime/verification.ts), [`src/eval/`](../src/eval) |
| `L5 Coordination & Scale` | Background tasks, scheduled runs, child sessions, TaskGraph, teammates, mailboxes, Git integration, and completion gating. | [`src/runtime/`](../src/runtime), [`src/extensions/`](../src/extensions), [`src/domain/`](../src/domain) |

A mechanism can belong to several layers. Worktree binding is both an action boundary and coordination support. TaskGraph is shared coordination state and durable completion evidence. c17c spans all five layers because ownership, review, execution, evidence, and finalization meet in one protocol.

## Action governance and tools

[`createDefaultPermissionPolicy()`](../src/governance/defaultPolicy.ts) makes action policy explicit. Inspect-only file tools are allowed. File writes, edit-capable delegation, verification commands, Git integration, and other mutations require approval. Known destructive shell shapes are denied. Unknown tools are denied rather than executed optimistically.

The policy decision is separate from execution:

```text
model tool call
    -> permission decision
    -> optional approval
    -> owning Tool Runtime
    -> ToolResult
    -> projected observation and Trace event
```

[`createToolRuntime()`](../src/tools/runtime.ts) owns built-in dispatch. [`composeToolRuntimes()`](../src/tools/compositeRuntime.ts) combines built-in tools with approved MCP runtimes while rejecting duplicate tool names. MCP annotations describe external tools, but Forge's permission policy remains the authorization source.

This boundary is governance inside the process. It is not a kernel, container, or operating-system sandbox.

## Context and prompt control

[`assemblePrompt()`](../src/context/promptAssembly.ts) builds a stable instruction order. A leading slash invocation selects a skill body; unselected skills contribute catalog metadata only. Project memory comes from `.forge/memory.md`.

Tool output does not return to the model as an arbitrary transcript dump. [`projectObservation()`](../src/context/projection.ts) emits the tool name, status, summary, and bounded content. [`createInputHistoryManager()`](../src/context/compaction.ts) keeps the original task pinned, retains recent rounds, and replaces older material with a structured summary when the character budget is reached.

Compaction is lossy by design. The Session Trace remains the historical ledger; the compacted prompt is only the model's next decision view.

## Session evidence and current state

A CLI run creates these durable files under `.forge/sessions/<session-id>/`:

| File | Purpose |
| --- | --- |
| `session.json` | Run identity, task, model, round budget, working directory, and optional parent or Worktree binding. |
| `trace.jsonl` | Ordered Runtime events with Session ID, sequence, and timestamp. |
| `task-graph.json` | Root-run TaskGraph used by the Leader, registered children, and teammates. |

[`TraceEventPayload`](../src/runtime/trace.ts) defines the event vocabulary. [`RuntimeState`](../src/runtime/state.ts) is an in-memory projection of facts needed for current decisions, such as the latest tool result, verification result, child handoff, teammate states, and TaskGraph health. RuntimeState does not replace the Trace and does not store the full conversation.

Hooks observe lifecycle events through [`src/extensions/lifecycle.ts`](../src/extensions/lifecycle.ts). Hook failures produce `hook_result` evidence; hooks do not authorize tools or change completion decisions.

## Isolation and delegation

`--worktree` binds a root run to a dedicated Git Worktree while Session metadata and Trace stay under the base repository. The setup records the base branch, base commit, generated branch, and Worktree path. A dirty or unsuitable base fails setup instead of silently sharing the original directory. See [`src/runtime/sessionWorkspace.ts`](../src/runtime/sessionWorkspace.ts) and [`src/runtime/workspace.ts`](../src/runtime/workspace.ts).

Child sessions have fresh model context, their own Session metadata, and their own Trace. Research children stay read-only. Edit children receive an isolated Worktree and return a handoff with changed-file metadata. Asynchronous children and background tasks must finish and return notifications before the root run can finalize.

Long-lived teammates are named processes scoped to one root Session. Each has persistent mailbox state and its own Session identity. Edit teammates receive a stable isolated Worktree. Automatic mailbox processing is FIFO and at most once; a failed claimed batch is not replayed implicitly. Recovery requires an explicit rejoin message.

Git Worktrees isolate file changes and make reviewable integration possible. They do not isolate processes, credentials, network access, or host permissions.

## TaskGraph and team completion

The root Session owns one file-backed TaskGraph. [`createFileTeamTaskStore()`](../src/runtime/teamTaskStore.ts) validates the graph, serializes mutations with a lock, writes through a temporary file and atomic rename, and increments the graph revision for each committed mutation.

Task contracts distinguish research from edit work:

- Research work requires actor-owned evidence, submission, and a Leader verdict.
- Edit work adds owner plan submission, Leader plan approval, a source fingerprint, verification in the registered source Worktree, and a Git integration receipt.

[`createGitIntegrationService()`](../src/runtime/gitIntegration.ts) reviews and fingerprints the edit source, checks for drift, runs the exact contract command, creates a source commit, and cherry-picks it into the Leader target. It aborts a conflicting cherry-pick and reports the failure instead of recording a successful receipt.

[`createCompletionGate()`](../src/runtime/completionGate.ts) evaluates the root-run invariants before root verification:

- every TaskGraph task is completed;
- the TaskGraph projection is healthy;
- no teammate has failed, remained active, or retained unread mail;
- no child Session or background task is pending;
- the Leader target has no cherry-pick in progress.

An incomplete gate returns blockers to the model. A failed gate records `completion_gate_failed` and ends the run as failed. A ready gate does not emit a new Trace event; the evidence is the invariant chain followed by root `verification_result`, `final_answer`, and `session_ended`.

The root verifier runs only after the gate is ready. A recoverable verification failure records `recovery_attempt`, sends the failure summary back to the model, and permits one repair cycle by default. A blocked result or exhausted recovery budget ends the run without a final answer.

## Pre-deployment regression boundary

[`src/eval/`](../src/eval) reuses the production prompt loader, loop, permission pipeline, child/teammate factories, and plugin/MCP activation path. It runs fixed minimal Git fixtures outside user traffic, grades Runtime-owned facts deterministically, and compares aggregate scenario and assertion pass counts with a compatible baseline.

Experiment identity contains controlled provider, model, request, scenario, fixture, grader, action-policy, attempt-count, and Runtime-knob inputs. Candidate source, prompt implementation, tool implementation, dependency versions, and environment details remain diagnostics because they are the variables being evaluated. Token usage and measured model duration are also diagnostics; neither changes the verdict.

Raw attempt evidence stays local under `.forge/evals/`. The public summary, JSON report, Markdown report, and promoted baseline reject prompt text, model output, raw tool arguments, absolute paths, and Trace payloads. See [Offline eval and regression reports](offline-eval.md).

## Extension startup boundary

Configured plugins pass strict descriptor and component preflight before any plugin module is imported or plugin MCP process is started. The CLI then collects per-Session trust decisions. Only approved plugins may contribute skill text, in-process hooks, or configured MCP servers.

This is a startup trust barrier, not a package manager or persistent trust store. Approved hooks execute in the Forge process with the current user's permissions. The Runtime records trust and activation outcomes, but it does not sandbox approved plugin code.

## Deliberate boundaries

The c17c Runtime does not implement:

- crash-safe resume, attempts, idempotency, reconciliation, or event replay;
- distributed coordination, remote workers, leases, or high availability;
- a plugin marketplace, downloader, persistent trust database, or package manager;
- an operating-system sandbox, container runtime, or credential isolation;
- RAG, a vector database, a web UI, or a hosted control plane.
- semantic LLM judging, price-based gating, model leaderboards, statistical claims, or automatic model calls on pushes and pull requests.

These are possible hardening directions, not hidden current features. The frozen Runtime demonstrates one governed root run with explicit context, evidence, isolation, delegation, and deterministic completion checks.
