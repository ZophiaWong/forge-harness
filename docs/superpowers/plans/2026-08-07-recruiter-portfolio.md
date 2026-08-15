# Recruiter Portfolio Implementation Plan

## Checkpoint 1: design

- Commit the demo contract, scene boundaries, documentation ownership, Bash platform boundary, and the Runtime-first recruiter information architecture.

## Checkpoint 2: red tests

- Add CLI and scene tests before implementation.
- Assert scene order, deny-before-dispatch, recovery-before-final, early gate blocking, receipt-before-ready, non-zero failure, and temporary-resource cleanup.

## Checkpoint 3: deterministic demo

- Implement a small `src/portfolio` runner using existing governance, verification, completion-gate, Git/worktree, and task protocol APIs.
- Keep output stable and redact absolute paths, model text, environment values, and raw Trace.
- Add `demo:portfolio` to `package.json`.

## Checkpoint 4: CI and docs

- Add the demo to the existing Ubuntu workflow.
- Add bilingual Portfolio pages and cue cards with links to canonical evidence. Lead with the from-scratch Runtime and five architecture responsibilities, then use three representative engineering decisions plus a c17c integration story.
- Present deterministic `--explain` as the screen-share command and document the optional Live boundary on the Portfolio pages. Keep the README and cue cards concise rather than turning them into an interview script.
- Keep the Live contract explicit: `session_ended` is the terminal core event, while a constrained cleanup and hook suffix may follow. Describe submitted-path validation, the Forge-child watchdog, and normal-path cleanup without claiming final root Git reconciliation or end-to-end cancellation.
- Add only first-screen recruiter links to both READMEs.

## Guardrails

- The deterministic demo makes no model call, reads no `.env`, uses no network, and adds no Runtime capability. The optional Live launcher is documented separately and remains outside the Runtime.
- [Issue #15](https://github.com/ZophiaWong/forge-harness/issues/15) owns final root Git reconciliation. [Issue #16](https://github.com/ZophiaWong/forge-harness/issues/16) owns end-to-end cancellation, fixture ownership, and initial-test failure classification.
- The demo does not claim the three scenes are one live Session.
- Detailed facts are not duplicated into cue cards; they remain in the case study/runbooks/Evidence Index. Candidate/final language stays in the concrete verification and c17c sections rather than defining the whole project.
