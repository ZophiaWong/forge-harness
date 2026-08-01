# Verification and recovery

## Capability

Forge treats model text as a candidate answer until an external verifier passes. A recoverable failure records evidence, sends a repair message into the next round, and permits one recovery attempt by default.

## Prerequisites

- Node.js 20.19.0 or newer
- dependencies installed with `npm install`
- `.env` configured only for the optional live run

## Deterministic check

```bash
npx vitest run test/runtime/verification.test.ts test/core/minimalLoop.test.ts
```

The focused cases cover a passing command, a recoverable nonzero exit, a recoverable timeout, a blocked result, recovery-budget exhaustion, and the ordering from candidate answer to verifier to final answer.

## Optional live run

The [c08 tutorial](../tutorial/c08-verification-recovery.md) owns the current live command. Its recovery verifier creates `.forge/c08-recovery-marker` and fails once, then passes on the second candidate.

Build first, remove a marker left by an earlier run, and copy the command from the tutorial's `运行验证` section:

```bash
npm run build
rm -f .forge/c08-recovery-marker
```

The command sends the task, Forge system prompt, and tool definitions to the model endpoint configured in `.env`. The prompt tells the model not to use tools, but model behavior is not guaranteed.

## Expected observations

The terminal and Trace should show this order:

```text
candidate_answer
verification_result status=failed
recovery_attempt attempt=1 maxAttempts=1
candidate_answer
verification_result status=passed
final_answer
session_ended status=completed
```

There must be no `final_answer` between the failed result and the recovery attempt.

## Evidence

- Runtime flow: [`src/core/minimalLoop.ts`](../../src/core/minimalLoop.ts)
- Command verifier: [`src/runtime/verification.ts`](../../src/runtime/verification.ts)
- Curated live snapshot: [`verification-recovery.json`](../assets/evidence/verification-recovery.json)
- Full claim map: [Evidence index](../evidence-index.md#verification-and-recovery)

## Limits

This run proves that a command result controls finalization. It does not prove that the model repaired code, that every failure is recoverable, or that one command captures every semantic requirement.

## Cleanup

The marker is local ignored state:

```bash
rm -f .forge/c08-recovery-marker
```

Use `npm run clean:runs` when you also want to remove generated Session and Worktree artifacts. The cleanup command preserves Forge configuration and Git branches.
