# Forge Offline Eval Regression Report

This sanitized evidence snapshot preserves the first independent valid and comparable batch that followed promotion of the earlier experiment baseline for that identity. Private attempt directories, raw Trace payloads, prompts, and model text remain local under `.forge/evals/`.

> Status: historical pre-hardening evidence. The review fixes change the experiment fingerprint; regenerate this artifact from the first independent comparable run after promoting the new canonical baseline. Do not treat the values below as evidence for the hardened contract.

- Verdict: `UNCHANGED`
- Candidate run: `20260803-131934-37c09801`
- Baseline run: `20260803-111112-8c0e4f95`
- Compatibility: `comparable`
- Scope: five fixed Forge Runtime scenarios, 13 model-driven attempts

## Interpretation

All scenario and outcome-assertion pass counts remained at their baseline values. This establishes that the candidate preserved the evaluated Forge Runtime contracts for this experiment identity; it does not claim deterministic model behavior or general coding ability.

The candidate used three fewer model calls and 937 fewer tokens, while measured model-call duration increased by 9,479 ms. These single-batch telemetry differences are informational only and do not affect the behavioral verdict.

## Behavioral differences

| Scenario | Contract | Baseline | Candidate | Delta |
| --- | --- | ---: | ---: | ---: |
| async-child-handoff | scenario pass | 3 | 3 | 0 |
| async-child-handoff | background-child | 3 | 3 | 0 |
| async-child-handoff | final-exact | 3 | 3 | 0 |
| async-child-handoff | tokens-read-in-own-sessions | 3 | 3 | 0 |
| c17c-team-completion | scenario pass | 1 | 1 | 0 |
| c17c-team-completion | artifact-exact | 1 | 1 | 0 |
| c17c-team-completion | plugin-lookup | 1 | 1 | 0 |
| c17c-team-completion | protocol-complete | 1 | 1 | 0 |
| compaction-retention | scenario pass | 3 | 3 | 0 |
| compaction-retention | final-exact | 3 | 3 | 0 |
| compaction-retention | ordered-reads | 3 | 3 | 0 |
| governed-read-only | scenario pass | 3 | 3 | 0 |
| governed-read-only | fact-read | 3 | 3 | 0 |
| governed-read-only | final-exact | 3 | 3 | 0 |
| governed-read-only | no-mutation-attempt | 3 | 3 | 0 |
| verification-recovery | scenario pass | 3 | 3 | 0 |
| verification-recovery | final-exact | 3 | 3 | 0 |
| verification-recovery | recovery-completed | 3 | 3 | 0 |

## Findings

No hard-invariant or infrastructure findings.

## Model usage (non-blocking)

### Candidate

- Model calls: 101
- Token coverage: `complete` (101/101 calls)
- Known token total: 334,311
- Measured model duration: 263,742 ms (101/101 calls)

### Baseline

- Model calls: 104
- Token coverage: `complete` (104/104 calls)
- Known token total: 335,248
- Measured model duration: 254,263 ms (104/104 calls)

## Limits

- The report evaluates fixed Forge-owned Runtime contracts, not general coding quality.
- Thirteen attempts do not establish statistical significance.
- Version 1 has no LLM judge, price table, or multi-model leaderboard.
- Git fixtures isolate repository state, not processes, credentials, network access, or host permissions.
- A compatible `UNCHANGED` batch is recorded evidence, not a guarantee of future provider or model behavior.
