# Async child handoff

## Capability

A parent can start fresh research or edit child Sessions without blocking its foreground round. Completed child results return through notifications and a terminal handoff. The parent cannot finalize while an asynchronous child remains pending.

## Prerequisites

- Node.js 20.19.0 or newer
- dependencies installed
- a clean Git base for edit-child runs
- `.env` configured only for the optional live run

## Deterministic check

```bash
npx vitest run test/extensions/childSessions.test.ts test/extensions/childSessionRegistry.test.ts test/tools/delegateTool.test.ts test/core/minimalLoop.test.ts
```

The cases cover separate Session and Trace creation, research/edit profiles, synchronous and asynchronous execution, trusted source registration, pending counts, notifications, failures, and the parent final gate.

The c17c one-shot integration smoke adds the verified edit-source path:

```bash
npm run smoke:c17c-child
```

## Optional live run

The [c15b tutorial](../tutorial/c15b-async-child-sessions-parallel-handoff.md) owns two current commands:

- two asynchronous research children while the parent continues foreground work;
- an asynchronous edit preview whose file remains in a child Worktree.

Build first, then copy one command from the tutorial's `运行验证` section:

```bash
npm run build
```

An edit child requires approval at delegation and again for each write-capable action inside the child.

## Expected observations

- `delegate` returns `status: running` for background children;
- each child has a distinct Session ID and Trace path;
- the parent can make another model or tool round before handoff;
- `child_session_notification` returns running or terminal state to a later parent round;
- an edit handoff includes the registered workspace and changed files;
- candidate finalization waits while `pendingCount()` is nonzero.

## Evidence

- Child runner and registry: [`src/extensions/childSessions.ts`](../../src/extensions/childSessions.ts)
- Delegate tool: [`src/tools/delegateTool.ts`](../../src/tools/delegateTool.ts)
- Parent notification and gate flow: [`src/core/minimalLoop.ts`](../../src/core/minimalLoop.ts)
- Full claim map: [Evidence index](../evidence-index.md#child-session-handoff)

## Limits

A handoff contains the information needed by the parent, not a copy of the child's full context. c17c has no child cancellation, crash resume, or automatic replay of a failed child.

## Cleanup

```bash
npm run clean:runs
```
