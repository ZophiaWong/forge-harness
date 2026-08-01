# Worktree isolation

## Capability

An opted-in run can bind file changes to a generated Git Worktree. Session metadata records the base commit, generated branch, and execution path, while the original checkout remains unchanged.

## Prerequisites

- a Git repository with a clean working tree
- Node.js 20.19.0 or newer
- dependencies installed
- `.env` configured only for the optional live run

## Deterministic check

```bash
npx vitest run test/runtime/workspace.test.ts test/runtime/session.test.ts test/runtime/runArtifactCleanup.test.ts
```

These tests create temporary repositories, reject dirty bases, create generated branches and Worktrees, record workspace metadata, and check that cleanup removes generated Worktrees without deleting their branches or unrelated `.forge` configuration.

## Optional live run

The [c14 tutorial](../tutorial/c14-worktree-isolation.md) contains the current edit command and inspection steps. It changes the tracked c14 fixture only inside the generated Worktree:

```bash
npm run build
git status --short
```

Continue only when `git status --short` is empty, then copy the `--worktree` command from the tutorial's `运行验证` section.

## Expected observations

- the CLI prints a root Session and a generated workspace;
- `session.json` contains `baseCwd`, the execution `cwd`, and `workspace` metadata;
- the base checkout keeps `c14-worktree-demo.txt` unchanged;
- `git -C <workspace-path> diff` shows the isolated edit;
- `trace.jsonl` contains `workspace_created` before model tool execution.

## Evidence

- Workspace creation: [`src/runtime/workspace.ts`](../../src/runtime/workspace.ts)
- Session binding: [`src/runtime/sessionWorkspace.ts`](../../src/runtime/sessionWorkspace.ts)
- Focused tests: [`workspace.test.ts`](../../test/runtime/workspace.test.ts)
- Full claim map: [Evidence index](../evidence-index.md#worktree-isolation)

## Limits

A Git Worktree isolates a working directory and branch. Commands still run as the current user and can reach permitted environment variables, network endpoints, and paths outside the Worktree. Permission governance remains a separate boundary.

## Cleanup

```bash
npm run clean:runs
```

The command removes registered generated Worktrees through Git, then removes `.forge/sessions/` and `.forge/worktrees/`. It intentionally retains generated branches for inspection.
