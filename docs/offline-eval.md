# Offline eval and regression reports

Forge's offline eval is a pre-deployment behavioral check. “Offline” means that no real user traffic reaches the candidate Runtime. A canonical run still calls the configured model API, so it needs credentials and consumes tokens.

This is evergreen Runtime hardening, not tutorial chapter `c18`. The tutorial remains at `c17c Coordination / Completion Protocol`.

## What the suite measures

The suite evaluates Forge-owned contracts rather than general coding ability:

| Scenario | Attempts | Runtime contract |
| --- | ---: | --- |
| `governed-read-only` | 3 | Read an exact fact, ignore a prompt injection stored in the fixture, preserve Git state, and record a permission decision for every tool call. |
| `verification-recovery` | 3 | Reject the first candidate through a trusted deterministic verifier, recover exactly once, and accept only `RECOVERY_OK`. |
| `compaction-retention` | 3 | Read three tokens in order, trigger automatic compaction, retain the pinned task, and return the exact combined token line. |
| `async-child-handoff` | 3 | Start one background research child, keep root and child evidence separate, wait for the handoff, and finish with no pending child. |
| `c17c-team-completion` | 1 | Drive the local plugin/MCP lookup, research child, research and edit teammates, TaskGraph protocol, source verification, Git receipt, shutdown, CompletionGate, and exact artifact. |

Every attempt starts from its own minimal Git repository with an initial commit. Scenario policies restrict tools, paths, commands, and trusted fixtures. These checks govern calls routed through Forge; a Git Worktree is not an operating-system sandbox.

The deterministic graders read Runtime Trace events, Git snapshots, TaskGraph state, teammate/mailbox state, and output artifacts. Version 1 does not use an LLM judge.

## Run it

A full canonical run executes all 13 attempts serially:

```bash
npm run eval -- run --model <model>
```

When `OPENAI_BASE_URL` is set, supply a stable provider identity explicitly:

```bash
npm run eval -- run --model <model> --provider-id <provider>
```

For debugging, run the canonical repetition count for one scenario:

```bash
npm run eval -- run --model <model> --scenario compaction-retention
```

A scoped run compares only that scenario against a compatible full baseline. It cannot be promoted.

Each run writes:

```text
.forge/evals/<run-id>/
├── summary.json
├── report.json
├── report.md
└── attempts/
```

The attempt directories are private diagnostic material and can contain raw Trace data or model text. Public automation uploads only the three sanitized report files.

## Baseline and verdict

Promote a complete, valid, zero-hard-violation 13-attempt summary locally:

```bash
npm run eval -- promote --from .forge/evals/<run-id>/summary.json
```

Baselines live under:

```text
eval/baselines/<provider>/<model-slug>/<experiment-fingerprint>.json
```

They contain aggregate pass counts and metrics, not prompts, model text, absolute paths, or raw Trace payloads. Replacing the same experiment identity requires `--replace`; the CLI prints the old/new assertion diff before writing.

Experiment identity hashes the endpoint, provider ID, requested model, request settings, scenario tasks, fixtures, graders, action policies, attempt counts, and Runtime knobs. Candidate source, prompt implementation, tool implementation, dependency versions, and environment diagnostics are deliberately excluded because they are the variables under test.

Verdict priority is:

1. an observed hard-invariant violation is `REGRESSED`;
2. provider, fixture, verifier, workflow, or evidence failure is `INVALID`;
3. missing baseline is `NO_BASELINE`, while changed experiment identity is `INCOMPARABLE`;
4. any lower scenario or assertion pass count is `REGRESSED`;
5. no decrease plus at least one increase is `IMPROVED`; equal counts are `UNCHANGED`.

One improvement never compensates for another regression. Exit code `0` means `UNCHANGED` or `IMPROVED`, `1` means `REGRESSED`, and `2` covers invalid, incomparable, missing-baseline, and argument failures.

## Telemetry is informational

Model calls record optional duration and normalized token usage. Reports aggregate root, child, teammate, and compaction calls. Cached input and reasoning tokens are displayed as subsets; they are not added to `totalTokens` a second time.

Missing provider usage is reported as partial or unavailable. Token and latency changes do not affect the behavioral verdict. Version 1 deliberately omits a price table, multi-model leaderboard, statistical significance, LLM-as-a-judge, automatic pull-request runs, and nightly model calls.

## Manual GitHub workflow and cleanup

`.github/workflows/eval.yml` runs only through `workflow_dispatch`. It reads the API key from repository secrets, always writes the Markdown report to the GitHub Step Summary, and retains only the three sanitized report files for 14 days. Pushes, pull requests, and schedules do not invoke a model.

Remove completed or invalid marked runs with:

```bash
npm run eval -- clean
```

Automation can pass `--yes`. Cleanup refuses active runs, unmarked directories, symlinks, and paths outside `.forge/evals/<run-id>`, and removes registered Worktrees through Git before deleting a run.

No baseline or portfolio report is fabricated by the deterministic test suite. Until a real canonical batch is promoted, `NO_BASELINE` is the expected verdict for a valid batch with no hard violation. After promotion, the first independent comparable batch—not a resampled green run—should become `docs/assets/evidence/offline-eval-regression-report.md`.
