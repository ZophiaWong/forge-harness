# Interview cue cards (English)

Speaking prompts, not a second case study. Keep each answer to 2–3 minutes and point to canonical evidence.

## Permission before dispatch

- **Beat:** Model proposes a write → policy classifies → approval if needed → handler dispatch → result/Trace.
- **Trade-off:** In-process policy is inspectable and testable, but is not an OS sandbox.
- **Evidence:** `src/governance/defaultPolicy.ts`, `test/governance/defaultPolicy.test.ts`, `npm run demo:portfolio` scene 1.
- **Follow-up:** Approved plugins still run in-process and use Forge tool/result/Trace paths.

## Context versus Trace

- **Beat:** Raw history grows → bounded projection/compaction feeds the next decision → append-only Trace retains ordered facts.
- **Trade-off:** Compaction is lossy; Trace is durable evidence, not model context.
- **Evidence:** `src/context/compaction.ts`, `src/runtime/trace.ts`, `test/context/compaction.test.ts`.
- **Follow-up:** c17c has no crash-safe replay/resume; that is an explicit boundary.

## Offline eval found a regression

- **Beat:** Fixed 13-attempt contracts detected `3→2` ordered reads → Trace isolated repeated-compaction loss → runtime/test fix → identity-aware baseline/candidate rules.
- **Trade-off:** A valid red result is evidence; resampling until green destroys comparability.
- **Evidence:** `docs/offline-eval.md`, `docs/assets/evidence/offline-eval-regression-report.md`, `src/eval/`.
- **Follow-up:** The eval does not prove general coding ability, statistical significance, production traffic, or deterministic reasoning.

