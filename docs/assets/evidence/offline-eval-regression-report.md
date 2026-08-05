# Forge Offline Eval Regression Report

This sanitized snapshot records the first independent valid and comparable batch after promoting the current hardened baseline. Private attempt directories, raw Trace payloads, prompts, and model text remain local under `.forge/evals/`.

- Verdict: `REGRESSED`
- Candidate run: `20260805-015424-b8573e30`
- Baseline run: `20260805-015056-2f364ccf`
- Compatibility: `comparable`
- Scope: five fixed Forge Runtime scenarios, 13 model-driven attempts
- Model: `gpt-5.4-mini`
- Provider: `my-gateway`
- Source commit: `6f4630a3c266433a1234a08b4b738c81516dcf99`
- Experiment fingerprint: `f7d6048d0ce0bfe2ffa43003f5cc01e8414591eda93b60faa1edc95d63a32046`
- Suite fingerprint: `a61c333e2deb358a0a3cbae71d6368acea8c3b1b20f1f09bf158a01852ba9b2c`
- Promoted baseline: [`eval/baselines/my-gateway/gpt-5.4-mini/f7d6048d0ce0bfe2ffa43003f5cc01e8414591eda93b60faa1edc95d63a32046.json`](../../../eval/baselines/my-gateway/gpt-5.4-mini/f7d6048d0ce0bfe2ffa43003f5cc01e8414591eda93b60faa1edc95d63a32046.json)

## Interpretation

The candidate has no hard-invariant or infrastructure findings. It improved the async child handoff count by one, but the compaction scenario lost one ordered-read pass. The comparator therefore returns `REGRESSED`; an improvement in one assertion does not cancel a decline in another.

This is the first valid comparable candidate for the current identity. It is retained as evidence without resampling for a preferred verdict. The report evaluates Forge-owned Runtime contracts, not general coding ability or deterministic model behavior.

## Behavioral differences

| Scenario | Contract | Baseline | Candidate | Delta |
| --- | --- | ---: | ---: | ---: |
| async-child-handoff | scenario pass | 2 | 3 | +1 |
| async-child-handoff | background-child | 3 | 3 | 0 |
| async-child-handoff | final-exact | 3 | 3 | 0 |
| async-child-handoff | tokens-read-in-own-sessions | 2 | 3 | +1 |
| c17c-team-completion | scenario pass | 1 | 1 | 0 |
| c17c-team-completion | artifact-exact | 1 | 1 | 0 |
| c17c-team-completion | plugin-lookup | 1 | 1 | 0 |
| c17c-team-completion | protocol-complete | 1 | 1 | 0 |
| compaction-retention | scenario pass | 3 | 2 | -1 |
| compaction-retention | final-exact | 3 | 3 | 0 |
| compaction-retention | ordered-reads | 3 | 2 | -1 |
| governed-read-only | scenario pass | 3 | 3 | 0 |
| governed-read-only | fact-read | 3 | 3 | 0 |
| governed-read-only | final-exact | 3 | 3 | 0 |
| governed-read-only | no-mutation-attempt | 3 | 3 | 0 |
| verification-recovery | scenario pass | 3 | 3 | 0 |
| verification-recovery | final-exact | 3 | 3 | 0 |
| verification-recovery | recovery-completed | 3 | 3 | 0 |

## Findings

No hard-invariant or infrastructure findings.

The baseline had one ordinary behavior failure in `async-child-handoff-3`; the candidate passed all three attempts for that scenario. The candidate's only ordinary behavior failure was `compaction-retention-2`, where `ordered-reads` failed. These behavior results are included in the counts and do not make the run invalid.

## Model usage (non-blocking)

### Candidate

- Model calls: 119
- Token coverage: `complete` (119/119 calls)
- Known token total: 417,625
- Measured model duration: 225,486 ms (119/119 calls)

### Baseline

- Model calls: 104
- Token coverage: `complete` (104/104 calls)
- Known token total: 337,304
- Measured model duration: 197,093 ms (104/104 calls)

Token totals and latency are informational only. They do not affect the behavioral verdict.

## Limits

- The report evaluates fixed Forge-owned Runtime contracts, not general coding quality.
- Thirteen attempts do not establish statistical significance.
- Version 1 has no LLM judge, price table, or multi-model leaderboard.
- Git fixtures isolate repository state, not processes, credentials, network access, or host permissions.
- A compatible candidate is evidence for this experiment identity, not a guarantee of future provider or model behavior.
