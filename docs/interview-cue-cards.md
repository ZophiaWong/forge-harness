# Interview cue cards (English)

Speaking prompts, not a second case study. Use the 30-second or 90-second overview first, then choose the story that matches the follow-up. Keep each deep dive to 2 to 3 minutes and point to canonical evidence.

## Project overview: 30 seconds

Beat: Forge Harness is a from-scratch TypeScript coding-agent Runtime. It starts with a runnable model-tool loop and adds governance, context management, durable evidence, isolated delegation, trusted extensions, and coordination as independently runnable checkpoints.

Evidence: [project architecture](01-project-architecture.md), [Portfolio](../PORTFOLIO.md).

## Project overview: 90 seconds

Beat: Explain the five architecture lenses. L1 turns model output into tool execution. L2 governs the action boundary. L3 controls the next decision context. L4 records state and evidence. L5 organizes background work, isolated sessions, and team completion. The c17c protocol connects these responsibilities around plan approval, Worktree edits, verification, Git integration, and a completion gate.

Trade-off: The Runtime is local and inspectable. It does not claim OS sandboxing, crash-safe resume, or distributed coordination.

Evidence: [architecture overview](architecture-overview.md), [engineering case study](engineering-case-study.md).

## c17c integration story

Beat: A teammate submits an edit plan. The Leader approves it. The edit occurs in a Worktree, then the source is fingerprinted, verified, committed, and integrated with a Git receipt. An early candidate leaves `CompletionGate` incomplete until the remaining task and team obligations settle.

Trade-off: Verification alone leaves an edit submitted. Integration evidence is a separate obligation. The live snapshot records one observed model run and does not guarantee future model adherence.

Evidence: [c17c live snapshot](assets/evidence/c17c-team-completion.json), [c17c demo](demos/c17c-team-completion.md), `npm run smoke:c17c-capstone`.

Follow-up: Worktrees isolate file changes, not processes, credentials, network access, or host permissions.

## Permission before dispatch

Beat: A model proposes a write. Policy classifies it. Approval may be required. Only then can the owning handler dispatch. The result and decision enter the common ToolResult and Trace paths.

Trade-off: In-process policy is inspectable and testable, but it is not an OS sandbox.

Evidence: `src/governance/defaultPolicy.ts`, `test/governance/defaultPolicy.test.ts`, `npm run demo:portfolio` scene 1.

Follow-up: Approved plugins still run in-process and use Forge tool, result, and Trace paths.

## Context versus Trace

Beat: Raw history grows. Bounded observations and compaction give the next model round a decision view. Append-only Trace keeps ordered Runtime facts for later inspection.

Trade-off: Compaction is intentionally lossy. Trace is durable evidence, not model context.

Evidence: `src/context/compaction.ts`, `src/runtime/trace.ts`, `test/context/compaction.test.ts`.

Follow-up: c17c does not provide crash-safe replay or resume. That boundary remains explicit.

## Offline eval found a regression

Beat: Five fixed scenarios produce a 13-attempt contract. The compaction scenario loses one ordered-read pass, falling from `3/3` to `2/3`. Trace evidence isolates repeated-compaction loss. The Runtime fix and regression test are recorded, while the first valid red candidate remains frozen under its identity.

Trade-off: A valid red result is evidence. Resampling until green would destroy comparability.

Evidence: [offline eval](offline-eval.md), [regression report](assets/evidence/offline-eval-regression-report.md), `src/eval/`.

Follow-up: The eval does not prove general coding ability, statistical significance, production traffic, or deterministic model reasoning.
