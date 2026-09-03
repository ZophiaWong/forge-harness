# c17c team completion

## Capability

The c17c protocol combines TaskGraph ownership, actor-recorded evidence, Leader review, edit-plan approval, exact source verification, Git integration receipts, teammate shutdown, CompletionGate evaluation, and root verification.

## Prerequisites

- Node.js 20.19.0 or newer
- dependencies installed
- Git author identity configured for temporary source and integration commits
- a clean base checkout for `--worktree`
- `.env` configured only for the optional live run

## Deterministic check

Run the complete protocol integration smoke:

```bash
npm run smoke:c17c-capstone
```

The test creates temporary Git repositories and Worktrees, drives the TaskGraph and Git integration services directly, runs the exact edit verification command, creates and cherry-picks the source commit, runs a root verifier, and requires `CompletionGate` to return `ready`.

It deliberately does not call a model, expose public tool schemas, start MCP transport, or request interactive approval.

## Optional live run

The [c17c tutorial](../tutorial/c17c-coordination-completion-protocol.md) owns the current capstone prompt. Its `live LLM API demo` section documents the required trust and action approvals, expected tool sequence, Trace locations, and artifact checks.

Start from a clean base and build:

```bash
git status --short
npm run build
```

When the status is empty, copy the complete `npm run start -- --worktree --verify ...` command from that section. The run sends the prompt, Forge system instructions, tool definitions, and subsequent model-visible tool observations to the endpoint configured in `.env`.

## Expected observations

The exact model rounds may vary. The Runtime invariants must not:

1. Three task contracts exist and reach `completed`.
2. The one-shot child records its own research evidence before the Leader submits that handoff.
3. The research teammate owns and submits its result with teammate evidence; the Leader records the verdict.
4. The edit teammate owns the edit task, receives plan approval before writing, records artifact evidence, and submits a fingerprinted source.
5. `task_verify` passes the exact task contract without source drift.
6. `task_integrate` records source and target commits in an integration receipt.
7. Both teammates are stopped with no unread mail, and no child or background work remains.
8. The root verifier passes, followed by `final_answer` and `session_ended status=completed`.

## Evidence

- Completion gate: [`src/runtime/completionGate.ts`](../../src/runtime/completionGate.ts)
- Task protocol: [`src/domain/teamTask.ts`](../../src/domain/teamTask.ts), [`src/runtime/teamTaskStore.ts`](../../src/runtime/teamTaskStore.ts)
- Git integration: [`src/runtime/gitIntegration.ts`](../../src/runtime/gitIntegration.ts)
- Deterministic smoke: [`test/smoke/c17cCapstone.test.ts`](../../test/smoke/c17cCapstone.test.ts)
- Curated live snapshot: [`c17c-team-completion.json`](../assets/evidence/c17c-team-completion.json)
- Full claim map: [Evidence index](../evidence-index.md#verified-git-integration-and-team-completion)

## Limits

The committed live snapshot was captured from the c17c source at commit `75714f2`. Its `limitations` field records the model's prompt-level deviations and the Runtime boundaries that contained them: pre-approval writes were blocked, and a premature completion candidate did not reach root verification. The snapshot does not guarantee future tool selection, message sequence, or round count, and it is not fresh release evidence for a later `HEAD`.

The protocol is scoped to one root run and has no crash reconciliation, cross-run resume, distributed lock service, or automatic recovery after a successful Git side effect whose TaskGraph receipt was not persisted.

## Cleanup

```bash
npm run clean:runs
```

Generated `forge/run/*` and `forge/teammate/*` branches remain available for inspection and are not removed by this command.
