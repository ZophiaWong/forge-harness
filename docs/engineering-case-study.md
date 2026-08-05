# Engineering case study

Forge Harness began with a small question: what must a coding-agent runtime own if a model response is treated as a proposal rather than proof of completion?

The answer grew into a c17c TypeScript Runtime with explicit action policy, bounded context, durable evidence, verification, isolated delegation, trusted extensions, a shared TaskGraph, and a completion protocol. The implementation is intentionally local and narrow. It is not a hosted agent platform, and the current boundary stops before crash recovery or distributed coordination.

## Starting failure: a fluent answer can hide an incomplete run

A minimal loop can send a prompt, execute a function call, and print the next model response. That proves connectivity, not correctness. Several facts are still unresolved:

- Was the requested action allowed before it ran?
- Which files, commands, and external tools were used?
- Did tool output overwhelm the next prompt?
- Can a verifier reject a plausible candidate answer?
- Did delegated work happen in the intended workspace?
- Has every team task been reviewed, verified, and integrated?
- Are background workers and mailboxes actually settled?

Forge moved these questions out of prompt convention and into Runtime-owned state transitions.

## Decision 1: put authorization before tool dispatch

The model never invokes a built-in or MCP tool implementation directly. A tool call first enters a permission policy that returns `allow`, `ask`, or `deny`. Approval is distinct from policy classification, and execution is distinct from both. Every outcome is converted into a common `ToolResult` and recorded in the Trace.

This split keeps an important failure visible. A tool may be valid but unapproved, approved but fail during execution, or succeed but still leave verification obligations. Treating all three as a generic tool message would erase the reason the run cannot proceed.

The boundary is deliberately modest. It governs calls inside Forge, but it is not an operating-system sandbox. Approved plugin hooks also run in the Forge process with the current user's permissions.

## Decision 2: separate decision context from historical evidence

Raw tool output, repeated prompts, and coordination messages consume context quickly. Forge projects tool results into bounded observations and compacts older input when its configured budget is reached. The original task remains pinned and recent rounds remain visible.

Compaction is allowed to be lossy because it is not the audit record. Each Session has append-only `trace.jsonl`; the next model prompt is only a current decision view. This distinction prevents a compacted summary from being mistaken for full historical evidence.

Skills and project memory follow the same economy. The prompt receives the selected skill body, while unselected skills contribute catalog metadata. Project memory has a known file and a known position in prompt assembly.

## Decision 3: make candidate completion testable

Without a verifier, the loop can only accept the model's own statement that work is done. Forge lets the caller register an external command. A candidate answer triggers that command before `final_answer` is recorded.

A recoverable verifier failure becomes structured input for one repair cycle by default. A blocked result or an exhausted recovery budget ends the run without accepting the candidate. The [Verification / Recovery Demo](demos/verification-recovery.md) shows the distinction between a failed first check and an accepted final state.

Verification remains scoped to its command. A successful build does not prove an arbitrary semantic claim, so Demo and Evidence documents state the exact invariant checked.

## Decision 4: isolate edits with Git, then require a handoff

Parallel agents editing one checkout create ambiguous ownership and difficult cleanup. Opted-in root runs and edit-capable delegated Sessions use generated Git Worktrees. Session metadata records the base branch, base commit, generated branch, and workspace binding.

Research children stay read-only. Edit children and edit teammates work in isolated directories and return changed-file metadata or a registered source identity. Git isolation supports review and integration, but does not isolate processes, credentials, network access, or the host.

Run artifacts also need a bounded lifecycle. `npm run clean:runs` removes only generated Sessions and registered run Worktrees, preserves other `.forge` configuration, and leaves Git branches intact. Cleanup uses Git to remove registered Worktrees rather than deleting directories behind Git's back.

## Decision 5: keep delegation context isolated

One-shot child Sessions have fresh context, separate metadata, and separate Trace files. The parent receives a concise handoff rather than the child's full transcript. Asynchronous children and background tasks notify the root loop when they settle; the root cannot finalize while either remains pending.

Long-lived teammates add named mailboxes and stable lifecycle state. That exposed a different class of failure: an idle worker is not a stopped worker, a delivered message is not accepted evidence, and a submitted edit is not an integrated edit.

## Decision 6: make team completion a Runtime protocol

c17c gives the root Session one file-backed TaskGraph. Each task declares a kind, dependencies, acceptance criteria, owner, evidence, and protocol state. Research and edit work intentionally have different completion paths.

Research requires actor-owned evidence, submission, and a Leader verdict. Edit work additionally requires a teammate plan, Leader approval, source fingerprint, exact verification command, source commit, and Git integration receipt. Verification alone leaves an edit submitted; only integration completes it.

The CompletionGate checks the cross-cutting state before the root verifier runs. Every task must be complete, graph health must be valid, children and background tasks must be settled, teammates must be stopped with no unread mail, and no cherry-pick may remain in progress. A model answer cannot waive these conditions.

The design also keeps failure semantics narrow. Mailbox processing is at most once, an owner failure can block its active task, and rejoining a teammate does not silently reopen that work. These choices avoid pretending the Runtime has retry, reconciliation, or idempotency machinery that belongs beyond c17c.

## Reliability lessons from live coordination

The live c17c capstone initially showed that a correct protocol can still be hard for a model to execute within a tight round budget. A startup message ran immediately before its referenced task was ready. A teammate spent a round on local planning even though the shared TaskGraph already carried the protocol. Another worker ran out of rounds before submission.

The fix did not weaken TaskGraph or CompletionGate rules. The model-visible contract now says that the startup message executes immediately, short mailbox protocols should use TaskGraph tools directly, and per-message round budgets need room for inspection, evidence, submission, retry, and a final response. The Demo sequence starts teammates in standby, creates and assigns tasks, and only then dispatches work.

This is a useful boundary between deterministic and nondeterministic behavior. Runtime gates are fixed and tested. Prompt sequencing and round budgets can improve the chance that a model reaches those gates, but they do not turn model behavior into a guarantee.

## Decision 7: compare behavioral contracts before deployment

Focused tests prove deterministic Runtime code paths, but they cannot show whether a prompt, tool description, loop change, or dependency update changed real-model behavior. A single curated live snapshot also cannot answer that question because it has no compatible before/after population.

Forge therefore adds an offline eval outside the tutorial chapter sequence. Five fixed scenarios exercise governed reading, verifier recovery, compaction retention, asynchronous child handoff, and the c17c team protocol. Each uses a fresh minimal Git fixture and deterministic assertions over Trace, Git, TaskGraph, mailbox, and artifact facts. The eval reuses production bootstrap functions instead of maintaining a second mock Runtime.

The baseline stores pass counts for each scenario and each outcome assertion. A regression in one count cannot be canceled by an improvement in another. Hard-invariant violations outrank infrastructure failures; provider or evidence failures remain `INVALID` rather than being mislabeled as model behavior. Missing or incompatible baselines are explicit outcomes instead of silently comparing different experiments.

Token usage and model-call duration are useful for explaining change, but v1 does not convert tokens into price or make efficiency a release gate. It also avoids semantic LLM judging, significance claims, automatic pull-request calls, and resampling until a green run appears. The first independent valid comparable batch is the evidence sample, even when its verdict is red.

The linked [regression report](assets/evidence/offline-eval-regression-report.md) records the first independent valid and comparable batch for the current hardened identity. Its `REGRESSED` verdict is kept as evidence: async child handoff improved, while one compaction ordering assertion declined. The candidate was not resampled for a preferred verdict.

## Known maintenance pressure

At c17c, five source files are longer than 1,000 lines. Their current boundaries are intentional, but each file now combines several maintenance concerns:

| Module | Current pressure | Behavior-preserving extraction seam |
| --- | --- | --- |
| [`src/core/minimalLoop.ts`](../src/core/minimalLoop.ts) | Round control shares a module with context compaction, notifications, tool-result projection, verification recovery, and finalization. Their ordering is correctness-sensitive. | Characterize round and finalization order first, then extract notification assembly and finalization helpers without changing the loop contract. |
| [`src/domain/teamTask.ts`](../src/domain/teamTask.ts) | Domain types share a module with persisted-schema parsing, graph invariants, and available-action calculation. | Separate codecs and graph validation while keeping the exported domain types and accepted schema unchanged. |
| [`src/runtime/teamTaskStore.ts`](../src/runtime/teamTaskStore.ts) | File locking and atomic writes sit beside every actor check and protocol transition. | Separate storage mechanics from transition handlers while keeping the store as the only mutation authority. |
| [`src/tools/teamTaskTools.ts`](../src/tools/teamTaskTools.ts) | Tool definitions, argument parsing, role-specific filtering, response formatting, Git integration, and teammate resolution are combined. | Extract definitions and adapter formatting from command handlers. Protocol transitions must remain in the store. |
| [`src/extensions/teammates.ts`](../src/extensions/teammates.ts) | Process lifecycle, mailbox delivery, approval brokerage, and shutdown accounting share one manager implementation. | Separate process, mailbox, and approval routing behind the existing `TeammateManager` interface. |

Refactoring these modules is maintenance work within the c17c boundary. It should begin with characterization tests for ordering, failure codes, source fingerprints, and integration receipts, then move one responsibility at a time. It must not extend the frozen c17c boundary or change Trace semantics.

## Validation strategy

The repository uses five evidence levels:

1. Source defines ownership and state transitions.
2. Focused Vitest cases exercise individual boundaries and failure paths.
3. Deterministic smoke tests combine TaskGraph, verification, Git integration, and CompletionGate without model calls.
4. Sanitized live snapshots record selected integrated runs without committing raw prompts, paths, identifiers, or model text.
5. Offline regression reports compare fixed behavioral counts across compatible real-model batches without publishing raw attempt evidence.

The [Evidence Index](evidence-index.md) maps each capability to its implementation, deterministic checks, optional live evidence, and stated limitation. This keeps broad claims from outrunning the repository.

## Alternatives deliberately not taken

- A framework-first orchestrator would hide the mechanisms the tutorial and Runtime are meant to expose.
- A single mutable global state module would blur domain ownership and make evidence reconstruction harder.
- Prompt-only permission and completion rules would be easy for a model to ignore.
- Shared-directory delegation would make edit provenance and integration ambiguous.
- Committing raw Session directories would expose machine-specific data and create noisy, unstable repository history.
- Adding retries, reconciliation, or distributed workers during hardening would expand the Runtime beyond c17c.

The result is a source-only engineering artifact, not a claim of production readiness. Its value lies in inspectable boundaries: what the Runtime decides, what it records, what it verifies, and what it explicitly does not implement.
