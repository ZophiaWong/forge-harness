# Evidence index

Forge Harness treats an engineering claim as a chain:

```text
claim -> implementation -> deterministic validation -> optional live run
```

The implementation defines the boundary. Tests and smoke runs exercise it without relying on model judgment. Live snapshots show that the integrated CLI reached the same invariants in one model-driven run; they do not promise that every future model run will take the same path.

## Recruiter walkthrough

| Command | Evidence produced | Does not prove |
| --- | --- | --- |
| `npm run demo:portfolio` | Three independent no-model scenes: deny-before-dispatch, recovery-before-final, and receipt-before-ready. | One continuous live Session, future model adherence, or OS-level isolation. |

The [bilingual portfolio](../PORTFOLIO.md) is a navigation layer. The [cue cards](interview-cue-cards.md) compress interview timing; this index remains the complete capability map.

## Repository-level checks

| Command | Evidence produced | Does not prove |
| --- | --- | --- |
| `npm run typecheck` | Source and test TypeScript programs satisfy their declared types. | Runtime behavior or command success. |
| `npm run test` | The Vitest suite exercises focused and integrated Runtime cases. | Live model behavior, external service availability, or platform portability beyond the test environment. |
| `npm run build` | TypeScript emits the CLI and Runtime into `dist/`. | That a model-driven task will complete. |
| `npm run smoke:c17c-capstone` | A deterministic temporary-Git scenario reaches integrated edit evidence and a ready CompletionGate. | Plugin startup, interactive approval, or model adherence to the live protocol. |
| `npm run smoke:c17c-child` | A deterministic one-shot edit-child source can be verified and integrated. | Async scheduling or a live model handoff. |
| `npm run eval -- run --model <model>` | A fixed 13-attempt behavioral batch produces a sanitized summary and regression report against a compatible baseline. | General coding ability, deterministic model reasoning, statistical significance, or production-user behavior. |

The ordinary GitHub Actions workflow runs documentation checks, type checking, the complete test suite, and the build without calling a model. The separate eval workflow is manual `workflow_dispatch` only because it needs credentials and nondeterministic model output.

## Capability map

### Governed execution

Claim: every model-requested tool action crosses an explicit policy decision before execution. Unknown tools and known destructive shell shapes fail closed.

- Implementation: [`defaultPolicy.ts`](../src/governance/defaultPolicy.ts), [`types.ts`](../src/governance/types.ts), [`minimalLoop.ts`](../src/core/minimalLoop.ts), [`runtime.ts`](../src/tools/runtime.ts)
- Focused tests: [`defaultPolicy.test.ts`](../test/governance/defaultPolicy.test.ts), [`approval.test.ts`](../test/cli/approval.test.ts), [`minimalLoop.test.ts`](../test/core/minimalLoop.test.ts)
- Extension-policy tests: [`mcpPolicy.test.ts`](../test/governance/mcpPolicy.test.ts), [`compositeRuntime.test.ts`](../test/tools/compositeRuntime.test.ts)
- Boundary: this is in-process authorization and validation, not an operating-system sandbox.

### Context control

Claim: the Runtime owns prompt assembly, bounded tool observations, and older-history compaction instead of forwarding an unbounded raw transcript.

- Implementation: [`promptAssembly.ts`](../src/context/promptAssembly.ts), [`observation.ts`](../src/context/observation.ts), [`projection.ts`](../src/context/projection.ts), [`compaction.ts`](../src/context/compaction.ts)
- Focused tests: [`promptAssembly.test.ts`](../test/context/promptAssembly.test.ts), [`contextProjection.test.ts`](../test/context/contextProjection.test.ts), [`compaction.test.ts`](../test/context/compaction.test.ts)
- Trace evidence: `prompt_assembled`, `context_compacted`, and `context_compaction_failed` are defined in [`trace.ts`](../src/runtime/trace.ts).
- Boundary: compaction is lossy. The summary supports the next decision; it is not the historical ledger.

### Session, Trace, and RuntimeState

Claim: each run has durable metadata and an ordered JSONL event ledger, while the loop reads a smaller in-memory current-state projection.

- Implementation: [`session.ts`](../src/runtime/session.ts), [`trace.ts`](../src/runtime/trace.ts), [`traceRecorder.ts`](../src/runtime/traceRecorder.ts), [`state.ts`](../src/runtime/state.ts)
- Focused tests: [`session.test.ts`](../test/runtime/session.test.ts), [`traceRecorder.test.ts`](../test/runtime/traceRecorder.test.ts), [`state.test.ts`](../test/runtime/state.test.ts)
- Evidence format: [curated runtime evidence](assets/evidence/README.md)
- Boundary: c17c has no crash-safe replay, resume, reconciliation, or persistent `state.json`.

### Verification and recovery

Claim: a candidate answer is not final until the configured verifier passes. One recoverable failure can return a repair signal to the loop before the default recovery budget is exhausted.

- Implementation: [`verification.ts`](../src/runtime/verification.ts), candidate/final flow in [`minimalLoop.ts`](../src/core/minimalLoop.ts)
- Focused tests: [`verification.test.ts`](../test/runtime/verification.test.ts), verification cases in [`minimalLoop.test.ts`](../test/core/minimalLoop.test.ts)
- Live snapshot: [`verification-recovery.json`](assets/evidence/verification-recovery.json)
- Runbook: [Verification / Recovery](demos/verification-recovery.md)
- Boundary: the verifier checks an external command result. It does not judge every semantic property of the model's answer.

### Worktree isolation

Claim: an opted-in root run and edit-capable delegated work can bind modifications to generated Git Worktrees with recorded base identity.

- Implementation: [`workspace.ts`](../src/runtime/workspace.ts), [`sessionWorkspace.ts`](../src/runtime/sessionWorkspace.ts), child setup in [`childSessions.ts`](../src/extensions/childSessions.ts)
- Focused tests: [`workspace.test.ts`](../test/runtime/workspace.test.ts), Worktree cases in [`childSessions.test.ts`](../test/extensions/childSessions.test.ts)
- Runbook: [Worktree isolation](demos/worktree-isolation.md)
- Boundary: Git Worktrees separate working directories and branches. They do not isolate processes, credentials, the network, or host permissions.

### Child Session handoff

Claim: delegated work runs with fresh model context and separate Session evidence. Edit children return registered Worktree metadata, and the parent cannot finalize while an asynchronous child is pending.

- Implementation: [`childSessions.ts`](../src/extensions/childSessions.ts), [`delegateTool.ts`](../src/tools/delegateTool.ts), notification and final-gate logic in [`minimalLoop.ts`](../src/core/minimalLoop.ts)
- Focused tests: [`childSessions.test.ts`](../test/extensions/childSessions.test.ts), [`childSessionRegistry.test.ts`](../test/extensions/childSessionRegistry.test.ts), [`delegateTool.test.ts`](../test/tools/delegateTool.test.ts)
- Deterministic smoke: [`c17cChildIntegration.test.ts`](../test/smoke/c17cChildIntegration.test.ts)
- Runbook: [Async child handoff](demos/async-child-handoff.md)
- Boundary: child summaries are handoffs, not a copy of the child's full context.

### MCP and plugin trust

Claim: configured local extensions pass preflight and per-Session trust before plugin code or MCP tools enter the prompt and Tool Runtime. External tool calls still use Forge permission, result, and Trace paths.

- Implementation: [`pluginPreflight.ts`](../src/extensions/pluginPreflight.ts), [`pluginActivation.ts`](../src/extensions/pluginActivation.ts), [`mcpSession.ts`](../src/extensions/mcpSession.ts), [`mcpToolAdapter.ts`](../src/extensions/mcpToolAdapter.ts)
- Focused tests: [`pluginPreflight.test.ts`](../test/extensions/pluginPreflight.test.ts), [`pluginActivation.test.ts`](../test/extensions/pluginActivation.test.ts), [`mcpSession.test.ts`](../test/extensions/mcpSession.test.ts), [`mcpToolAdapter.test.ts`](../test/extensions/mcpToolAdapter.test.ts)
- Runbook: [MCP and plugin trust](demos/mcp-plugin-trust.md)
- Boundary: approved plugin hooks are trusted in-process code. Trust is not persisted between Sessions and is not a sandbox.

### Shared TaskGraph and actor-owned evidence

Claim: the root Session owns a validated, revisioned task graph whose mutations enforce actor role, ownership, dependency, evidence, submission, review, verification, and integration rules.

- Implementation: [`teamTask.ts`](../src/domain/teamTask.ts), [`teamTaskStore.ts`](../src/runtime/teamTaskStore.ts), [`teamTaskTools.ts`](../src/tools/teamTaskTools.ts)
- Focused tests: [`teamTaskStore.test.ts`](../test/runtime/teamTaskStore.test.ts), [`teamTaskProtocol.test.ts`](../test/runtime/teamTaskProtocol.test.ts), [`teamTaskTools.test.ts`](../test/tools/teamTaskTools.test.ts)
- Boundary: this is one root-run-scoped file-backed graph, not a distributed scheduler or durable cross-run queue.

### Teammates and mailbox coordination

Claim: a root run can address named teammate processes through persistent FIFO mailboxes, inspect lifecycle state, and require explicit shutdown before completion.

- Implementation: [`teammate.ts`](../src/domain/teammate.ts), [`teammates.ts`](../src/extensions/teammates.ts), [`teamMailbox.ts`](../src/runtime/teamMailbox.ts), [`teammateTools.ts`](../src/tools/teammateTools.ts)
- Focused tests: [`teammates.test.ts`](../test/extensions/teammates.test.ts), [`teamMailbox.test.ts`](../test/runtime/teamMailbox.test.ts), [`teammateTools.test.ts`](../test/tools/teammateTools.test.ts)
- Boundary: automatic mailbox processing is at most once. Rejoin is explicit and does not automatically reopen blocked work.

### Verified Git integration and team completion

Claim: an edit task must retain the reviewed source fingerprint, pass its exact verification contract, produce an integration receipt, and join a completed team state before the root verifier can accept a final answer.

- Implementation: [`gitIntegration.ts`](../src/runtime/gitIntegration.ts), [`completionGate.ts`](../src/runtime/completionGate.ts), c17c final flow in [`minimalLoop.ts`](../src/core/minimalLoop.ts)
- Focused tests: [`gitIntegration.test.ts`](../test/runtime/gitIntegration.test.ts), [`completionGate.test.ts`](../test/runtime/completionGate.test.ts)
- Deterministic smoke: [`c17cCapstone.test.ts`](../test/smoke/c17cCapstone.test.ts)
- Live snapshot: [`c17c-team-completion.json`](assets/evidence/c17c-team-completion.json)
- Runbook: [c17c team completion](demos/c17c-team-completion.md)
- Boundary: a ready gate is inferred from its checked state. c17c records `completion_gate_failed` for terminal failures but does not add a separate ready Trace event.

### Offline behavioral regression

Claim: a candidate Runtime can run fixed Forge-specific behavioral contracts before deployment, report optional token/latency telemetry, and detect any lower scenario or assertion pass count without allowing improvements elsewhere to compensate.

- Implementation: [`src/eval/`](../src/eval), model telemetry in [`minimalLoop.ts`](../src/core/minimalLoop.ts), and optional telemetry fields in [`trace.ts`](../src/runtime/trace.ts)
- Focused tests: [`test/eval/`](../test/eval), including synthetic grader cases, comparator priority, fingerprint stability, baseline eligibility, safe cleanup, and scripted Runtime integration
- Manual workflow: [`eval.yml`](../.github/workflows/eval.yml)
- Operating guide: [Offline eval and regression reports](offline-eval.md)
- Curated evidence: [offline eval regression report](assets/evidence/offline-eval-regression-report.md), the first independent valid and comparable 13-attempt batch for the current hardened identity. It records a `REGRESSED` result without resampling: async child handoff improved, while one compaction ordering assertion declined.
- Boundary: “offline” means outside user traffic, not offline from the model provider. Token and latency do not gate the verdict. v1 has no LLM judge, price table, multi-model ranking, or statistical claim.

## Interpreting the evidence

The strongest repeatable evidence is the deterministic test and smoke layer. A regression report adds cross-version behavioral evidence for one fixed experiment identity. The live layer adds integration context, including model and approval behavior, but it is a recorded example rather than a guarantee.

No current evidence supports claims of high availability, crash recovery, distributed consensus, OS sandboxing, arbitrary untrusted plugin execution, or deterministic model reasoning. Those claims are outside the frozen Runtime scope.
