# Run Artifact Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run clean:runs` to safely remove run-generated `.forge/sessions/` and `.forge/worktrees/` artifacts while preserving configuration, plugin, memory, skill, and Git branch data.

**Architecture:** Put filesystem and Git lifecycle behavior in a small runtime module, and keep argument parsing, confirmation, output, and exit codes in a separate CLI entrypoint. The runtime discovers registered generated worktrees from `git worktree list --porcelain`, removes them deepest-first with Git, prunes stale registrations, and only then removes the two exact generated roots. The CLI defaults to `y/N`, supports `--yes`, and refuses to wait on non-interactive input.

**Tech Stack:** TypeScript, Node.js `fs/promises`, `child_process.execFile`, `readline/promises`, Git worktree commands, Vitest.

## Global Constraints

- Delete only the exact generated roots `.forge/sessions/` and `.forge/worktrees/`.
- Preserve every other `.forge` entry, including `.forge/mcp.json`, `.forge/plugins/`, `.forge/memory/`, and `.forge/skills/`.
- Never delete Git branches, including `forge/run/*` and `forge/teammate/*`.
- Remove registered worktrees with `git worktree remove --force`, deepest path first, then run `git worktree prune`.
- If any registered removal or prune fails, continue the remaining Git cleanup, report every failure, preserve both generated roots, and exit nonzero.
- An absent or already-clean `.forge` state is a successful no-op.
- Keep the implementation independent from the agent loop and existing `start` argument parser.
- Preserve the user's unrelated working-tree changes.

---

## Task 1: Define and Test Run Artifact Inspection

**Files:**

- Create: `src/runtime/runArtifactCleanup.ts`
- Create: `test/runtime/runArtifactCleanup.test.ts`

- [ ] **Step 1: Write failing inspection tests**

Create a temporary Git repository helper using `fs.mkdtemp`, `git init -b main`, a committed `README.md`, and cleanup in `afterEach`.

Add tests that assert:

1. Missing `.forge/sessions` and `.forge/worktrees` produce zero counts and `hasArtifacts: false`.
2. Two session directories, one registered generated worktree, and one ordinary residual entry are reported separately.
3. A registered worktree outside `.forge/worktrees` is ignored.
4. Registered nested paths are ordered deepest-first and then lexically for deterministic ties.

Use this public shape in the assertions:

```ts
export interface RunArtifactInventory {
  sessionsRoot: string;
  worktreesRoot: string;
  sessionCount: number;
  worktreeRootEntryCount: number;
  registeredWorktrees: string[];
  hasArtifacts: boolean;
}
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run test/runtime/runArtifactCleanup.test.ts
```

Expected: failure because `src/runtime/runArtifactCleanup.ts` does not exist.

- [ ] **Step 3: Implement the minimum inspection API**

In `src/runtime/runArtifactCleanup.ts`, add:

```ts
export interface GitWorktreeAdapter {
  list(cwd: string): Promise<string[]>;
  remove(cwd: string, worktreePath: string): Promise<void>;
  prune(cwd: string): Promise<void>;
}

export function createGitWorktreeAdapter(): GitWorktreeAdapter;

export async function inspectRunArtifacts(options: {
  cwd: string;
  git?: GitWorktreeAdapter;
}): Promise<RunArtifactInventory>;
```

Implementation requirements:

- Resolve `cwd`, `.forge/sessions`, and `.forge/worktrees` to absolute paths.
- Count immediate directory entries with `fs.readdir`; treat `ENOENT` as zero and rethrow other errors.
- Parse only `worktree ` records from `git worktree list --porcelain`.
- Retain only strict descendants of the exact `.forge/worktrees` root.
- Sort retained paths by descending path depth, then `localeCompare`.
- Compute `hasArtifacts` from the three observable counts.
- Invoke Git through `execFile("git", args, { cwd, encoding: "utf8" })`; do not use a shell.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
npx vitest run test/runtime/runArtifactCleanup.test.ts
```

Expected: all inspection tests pass.

- [ ] **Step 5: Review the inspection slice**

```bash
git diff -- src/runtime/runArtifactCleanup.ts test/runtime/runArtifactCleanup.test.ts
```

Expected: only the inspection API and its focused tests are present. Do not commit without separate user confirmation.

---

## Task 2: Implement Safe Cleanup and Failure Semantics

**Files:**

- Modify: `src/runtime/runArtifactCleanup.ts`
- Modify: `test/runtime/runArtifactCleanup.test.ts`

- [ ] **Step 1: Write failing cleanup tests**

Extend `test/runtime/runArtifactCleanup.test.ts` with:

1. A dirty registered worktree under `.forge/worktrees/run-session` is removed successfully through Git.
2. A nested teammate worktree is removed before its parent worktree.
3. A stale worktree registration is pruned.
4. `.forge/sessions` and `.forge/worktrees` disappear after success.
5. `.forge/mcp.json`, `.forge/plugins`, `.forge/memory`, `.forge/skills`, and unrelated files remain byte-for-byte unchanged.
6. `forge/run/*` and `forge/teammate/*` branch refs remain after cleanup.
7. A second cleanup is a successful no-op.
8. With an injected adapter whose `remove` fails for one registered path, all other removals are attempted, `prune` is attempted, both generated roots remain, and the result contains the failure.
9. With an injected adapter whose `prune` fails, both generated roots remain and the result contains the prune failure.

For ordering assertions, inject a recording `GitWorktreeAdapter` and verify nested paths precede parents.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run test/runtime/runArtifactCleanup.test.ts
```

Expected: cleanup tests fail because the cleanup API is absent.

- [ ] **Step 3: Add the cleanup result types and implementation**

Add:

```ts
export interface RunArtifactCleanupFailure {
  operation: "remove_worktree" | "prune";
  path: string;
  message: string;
}

export interface RunArtifactCleanupResult {
  inventory: RunArtifactInventory;
  removedWorktrees: string[];
  failures: RunArtifactCleanupFailure[];
  pruned: boolean;
  sessionsRemoved: boolean;
  worktreesRootRemoved: boolean;
}

export async function cleanupRunArtifacts(options: {
  cwd: string;
  git?: GitWorktreeAdapter;
}): Promise<RunArtifactCleanupResult>;
```

Implement this exact sequence:

1. Call `inspectRunArtifacts`.
2. Call `git.remove(cwd, path)` for every registered path in inventory order using `git worktree remove --force <path>`.
3. Collect removal errors and continue.
4. Call `git.prune(cwd)` once using `git worktree prune`; collect a prune error.
5. If any Git failure exists, return without recursively deleting either generated root.
6. Otherwise validate that each deletion target has parent `.forge` and the expected basename.
7. Remove the exact `.forge/worktrees` and `.forge/sessions` roots with `fs.rm(..., { recursive: true, force: true })`.

Convert unknown thrown values to stable messages without exposing an arbitrary object string. Do not add branch deletion commands.

- [ ] **Step 4: Run runtime cleanup tests and confirm GREEN**

Run:

```bash
npx vitest run test/runtime/runArtifactCleanup.test.ts
```

Expected: all inspection, success, preservation, ordering, and failure tests pass.

- [ ] **Step 5: Review the cleanup runtime**

```bash
git diff -- src/runtime/runArtifactCleanup.ts test/runtime/runArtifactCleanup.test.ts
```

Expected: only cleanup lifecycle behavior and its tests have changed. Do not commit without separate user confirmation.

---

## Task 3: Add the Confirming Cleanup CLI

**Files:**

- Create: `src/cli/cleanup.ts`
- Create: `test/cli/cleanup.test.ts`

- [ ] **Step 1: Write failing parser and flow tests**

Test exported `parseCleanupArgs` and `runCleanupCli` with injected inventory, cleanup, confirmation, and output dependencies.

Cover:

1. No arguments returns `{ yes: false }`.
2. `--yes` returns `{ yes: true }`.
3. Duplicate `--yes`, positional arguments, and unknown flags return a usage error.
4. No artifacts prints `nothing to clean`, skips confirmation and cleanup, and returns exit code `0`.
5. Interactive default prints counts, rejects the default/negative answer, prints `cleanup canceled`, skips cleanup, and returns `0`.
6. Interactive `y` runs cleanup and returns `0`.
7. Non-TTY input without `--yes` does not prompt, explains how to use `--yes`, and returns `1`.
8. `--yes` skips confirmation and runs cleanup.
9. Runtime failures are printed and return `1`.

Use a small writable collector instead of spying on global `process.stdout`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run test/cli/cleanup.test.ts
```

Expected: failure because `src/cli/cleanup.ts` does not exist.

- [ ] **Step 3: Implement the parser and injectable runner**

Export:

```ts
export type CleanupCliArgs = { yes: boolean } | { error: string };

export function parseCleanupArgs(args: string[]): CleanupCliArgs;

export async function runCleanupCli(options: {
  args: string[];
  cwd: string;
  stdinIsTTY: boolean;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  inspect?: typeof inspectRunArtifacts;
  cleanup?: typeof cleanupRunArtifacts;
  confirm?: () => Promise<boolean>;
}): Promise<number>;
```

Runner behavior:

- Print `sessions`, `registered worktrees`, and `worktree root entries` before confirmation.
- Use `Delete these run artifacts? [y/N] ` for the interactive prompt.
- Accept case-insensitive `y` or `yes`; all other input cancels.
- On non-TTY input, print `cleanup requires an interactive terminal or --yes`.
- On failure, print one line per operation/path/message and return `1`.
- On success, print removed worktree and directory counts and return `0`.

- [ ] **Step 4: Add the executable module boundary**

At the bottom of `src/cli/cleanup.ts`, compare `import.meta.url` with `pathToFileURL(process.argv[1]).href`. Only for a direct invocation:

- Create the default confirmation function with `node:readline/promises`.
- Pass `process.argv.slice(2)`, `process.cwd()`, `Boolean(process.stdin.isTTY)`, and process streams to `runCleanupCli`.
- Assign the returned value to `process.exitCode`.
- Catch unexpected top-level errors, print one concise message, and set exit code `1`.

This guard keeps module imports side-effect free in Vitest.

- [ ] **Step 5: Run CLI tests and confirm GREEN**

Run:

```bash
npx vitest run test/cli/cleanup.test.ts
```

Expected: all parser, prompt, non-TTY, success, and failure tests pass.

- [ ] **Step 6: Review the CLI slice**

```bash
git diff -- src/cli/cleanup.ts test/cli/cleanup.test.ts
```

Expected: only the dedicated cleanup entrypoint and CLI tests have changed. Do not commit without separate user confirmation.

---

## Task 4: Wire the npm Command and Document Its Boundary

**Files:**

- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/tutorial/c14-worktree-isolation.md`

- [ ] **Step 1: Add the npm script**

Add this exact script:

```json
"clean:runs": "npm run --silent build && node dist/cli/cleanup.js"
```

Keep the existing `start`, build, smoke, and test scripts unchanged.

- [ ] **Step 2: Add shared cleanup documentation to README**

After the setup/environment section, add a short `## Clean run artifacts` section in Chinese that:

- Names the accumulation pain point.
- Shows interactive `npm run clean:runs`.
- Shows non-interactive `npm run clean:runs -- --yes`.
- States that only `.forge/sessions/` and `.forge/worktrees/` are removed.
- States that `.forge/mcp.json`, plugins, memory, skills, and Git branches are preserved.
- Notes that registered worktrees are removed through Git before filesystem cleanup.

- [ ] **Step 3: Update the c14 future-gap paragraph**

Replace the claim that cleanup is only a future mechanism with a concise checkpoint-aware note:

- c14 itself still retains worktrees for inspection.
- The current integrated repository now provides the shared cleanup command documented in `README.md`.
- Branch retention remains intentional and is not handled by this command.

Link to the README section instead of duplicating all usage details.

- [ ] **Step 4: Run the required humanizer-zh pass**

Read `.codex` skill instructions for `humanizer-zh`, review only the newly written Chinese documentation, and remove mechanical or AI-like phrasing without changing commands, paths, identifiers, or safety guarantees.

- [ ] **Step 5: Re-check documentation literals**

Confirm:

- Both npm commands match `package.json`.
- `.forge/sessions/` and `.forge/worktrees/` are spelled exactly.
- Preserved paths and branch behavior match the implementation.
- The c14 README link resolves.

- [ ] **Step 6: Review package and docs**

```bash
git diff -- package.json README.md docs/tutorial/c14-worktree-isolation.md
```

Expected: one npm script and the two bounded documentation updates. Do not commit without separate user confirmation.

---

## Task 5: Run Smoke Tests and Full Verification

**Files:**

- Verify only; fix failures in the smallest owning file.

- [ ] **Step 1: Build the executable**

Run:

```bash
npm run build
```

Expected: TypeScript emits `dist/cli/cleanup.js` without errors.

- [ ] **Step 2: Smoke-test the no-op command safely**

Use a temporary Git repository without run artifacts and invoke the compiled CLI from that temporary working directory:

```bash
node /home/poter/resume-pj/forge-harness/dist/cli/cleanup.js --yes
```

Expected: `nothing to clean` and exit code `0`.

- [ ] **Step 3: Smoke-test real cleanup in a temporary repository**

In a temporary Git repository:

- Commit a base file.
- Create `.forge/mcp.json`.
- Create one session directory.
- Add a dirty worktree under `.forge/worktrees/demo`.
- Run the compiled cleanup CLI with `--yes`.
- Assert the two generated roots are absent, `.forge/mcp.json` remains, the worktree is no longer registered, and its branch still exists.

Do not run the cleanup command against the development repository during verification.

- [ ] **Step 4: Run focused tests**

```bash
npx vitest run test/runtime/runArtifactCleanup.test.ts test/cli/cleanup.test.ts
```

Expected: all cleanup tests pass.

- [ ] **Step 5: Run repository-required verification**

Run:

```bash
npm run test
npm run typecheck
npm run build
```

Expected: all commands exit `0`.

- [ ] **Step 6: Check documentation links and working tree**

Run:

```bash
test -f README.md
test -f docs/tutorial/c14-worktree-isolation.md
rg -n "clean:runs|run artifacts" README.md docs/tutorial/c14-worktree-isolation.md
git status --short
```

Confirm the README link target exists and distinguish the cleanup feature files from the user's pre-existing max-tool-round changes.

- [ ] **Step 7: Review the final diff against the design**

Verify every design invariant:

- exact deletion scope;
- Git-aware deepest-first removal;
- stale prune;
- fail-closed root deletion;
- interactive default and `--yes`;
- non-TTY refusal;
- idempotent no-op;
- preserved branches and config;
- no changes to the main `start` CLI.

- [ ] **Step 8: Review any verification-only fixes**

If verification required changes, inspect only the owning cleanup files:

```bash
git diff -- src/runtime/runArtifactCleanup.ts src/cli/cleanup.ts test/runtime/runArtifactCleanup.test.ts test/cli/cleanup.test.ts package.json README.md docs/tutorial/c14-worktree-isolation.md
```

Do not stage or commit unrelated user changes, and do not create a commit without separate user confirmation.
