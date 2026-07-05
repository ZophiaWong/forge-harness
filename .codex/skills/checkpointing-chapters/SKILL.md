---
name: checkpointing-chapters
description: Use when finishing a Forge Harness tutorial chapter checkpoint, especially before branch, commit, sync, push, tag, merge, rebase, or release work.
---

# Checkpointing Chapters

## Overview

Guard Forge Harness chapter checkpoints from polluted commits, unsafe sync, and mutable published tags. Treat local commit prep as allowed after the user asks for checkpointing; treat publishing and history integration as separate decisions that need explicit confirmation.

Core principle: a tutorial checkpoint is evidence for readers. Do not make Git history cleaner by making the checkpoint less auditable.

## Workflow

1. Inspect before deciding:
   - `git status --short --branch`
   - `git remote -v`
   - `git branch --list 'tutorial/c*'`
   - `git tag --list 'tutorial-*' --sort=refname`
   - identify the matching `docs/tutorial/cNN-*.md`
2. Derive names from the tutorial filename:
   - `docs/tutorial/c02-tool-runtime.md`
   - branch: `tutorial/c02-tool-runtime`
   - tag: `tutorial-c02-tool-runtime`
3. Isolate the checkpoint:
   - Prefer preparing the `tutorial/cNN-*` branch first.
   - Include only chapter-owned source, tests, docs, and assets.
   - Stop if dirty files look unrelated or ownership is unclear.
4. Verify before commit:
   - Runnable chapter: `npm run test`, `npm run typecheck`, `npm run build`, plus the smoke command and expected observation from the chapter tutorial.
   - Docs-only work: `git status`, link/path existence checks, and clearly marked future-only source layout notes.
5. Commit locally:
   - Default to one chapter checkpoint commit, for example `feat: add c02 tool runtime`.
   - Re-check `git status --short --branch` after committing.
   - Report the local checkpoint commit and ask whether to continue with: `publish the tutorial branch and merge to main`.
6. Publish or integrate only after explicit confirmation:
   - Ask before `git push`, `git tag`, `git push origin <tag>`, `git merge`, or any `main` integration.
   - Treat the user's confirmation to `publish the tutorial branch and merge to main` as permission to publish the checkpoint branch and fast-forward `main` using the guarded sequence below.
   - If the user explicitly asks to publish the tutorial branch, push the checkpoint branch without deleting it.
   - If the user explicitly asks to merge into remote `main`, fast-forward local `main` from the tutorial branch and push `origin/main`; preserve the tutorial branch.
   - Report exactly which commit, branch, tag, and remote will be affected.

## Sync Boundary

Use `git fetch` to inspect remote state. Only fast-forward automatically when local history has no unique commits.

Stop and ask when histories diverge. Do not treat "sync however you need" as permission to rebase, merge, or push.

```text
origin/tutorial/c03: B -> C
local tutorial/c03:  B -> D
```

This is divergence. Report it and ask which integration strategy to use after verification. Do not run `git pull --rebase`, create a merge commit, or push until the user confirms the exact strategy.

## Publishing and Main Integration

When the user confirms `publish the tutorial branch and merge to main`, or explicitly asks to publish a completed tutorial checkpoint and merge it to remote `main`, use this guarded sequence:

1. Fetch and inspect:
   - `git fetch origin`
   - `git status --short --branch`
   - `git rev-list --left-right --count main...origin/main`
   - `git rev-list --left-right --count tutorial/cNN-name...origin/tutorial/cNN-name` if the remote branch exists
2. Stop if the worktree is dirty, unless the only changes are intentionally staged and already verified for this checkpoint.
3. Stop if local and remote histories diverge. Ask for the integration strategy instead of rebasing, merging, or force pushing.
4. Publish the tutorial branch only when requested:
   - New branch: `git push -u origin tutorial/cNN-name`
   - Existing aligned branch: `git push origin tutorial/cNN-name`
5. Merge to `main` only when requested:
   - Ensure `origin/main` is an ancestor of `tutorial/cNN-name`.
   - `git switch main`
   - `git merge --ff-only tutorial/cNN-name`
   - `git push origin main`
6. Preserve the tutorial branch:
   - Do not delete local `tutorial/cNN-name`.
   - Do not delete remote `origin/tutorial/cNN-name`.
   - If the user asks to stay on the tutorial branch after publishing, switch back after pushing `main`.
7. Re-check:
   - `git status --short --branch`
   - `git branch -vv --list 'main' 'tutorial/cNN-name'`
   - `git rev-list --left-right --count main...origin/main`

Never use `git push --force`, `git branch -D`, or remote branch deletion as part of normal checkpoint publishing.

## Tag Rules

Published tutorial tags are immutable checkpoints.

- Never move, delete, or force-push an existing `tutorial-*` tag as part of normal checkpointing.
- If a published checkpoint needs a fix, update the branch and propose a new tag such as `tutorial-c02-tool-runtime-v2`.
- Creating and pushing any tag requires explicit confirmation.

## Red Flags

| Pressure | Required response |
| --- | --- |
| "Just push it, looks fine" | Verify first; ask before push/tag/merge. |
| "Sync however you need" | Fetch and inspect; stop on divergence. |
| "Retag it, nobody noticed" | Do not move published tags; propose `-v2`. |
| "Commit everything to save time" | Split unrelated dirty changes or stop. |
| "Force push will clean this up" | Refuse unless the user explicitly names the force operation. |

## Example

After finishing `docs/tutorial/c02-tool-runtime.md` with source and tests:

```bash
git status --short --branch
git switch -c tutorial/c02-tool-runtime
git add docs/tutorial/c02-tool-runtime.md docs/assets/c02-* src/tools test/tools
npm run test
npm run typecheck
npm run build
# run the c02 smoke command from docs/tutorial/c02-tool-runtime.md
git commit -m "feat: add c02 tool runtime"
git status --short --branch
```

Then report the local checkpoint commit and ask whether to continue:

```text
Local checkpoint commit: <sha> feat: add c02 tool runtime
Do you want me to publish the tutorial branch and merge to main?
```

Do not push or integrate into `main` until the checkpoint branch is ready and the user confirms this publish-and-merge step. Do not create or push a tag from this confirmation alone.

If the user later confirms `publish the tutorial branch and merge to main`, use:

```bash
git fetch origin
git push -u origin tutorial/c02-tool-runtime
git switch main
git merge --ff-only tutorial/c02-tool-runtime
git push origin main
git status --short --branch
```

Report that both `main` / `origin/main` and `tutorial/c02-tool-runtime` / `origin/tutorial/c02-tool-runtime` point at the checkpoint commit. Do not create or push a tag unless the user explicitly asks for the tag too.
