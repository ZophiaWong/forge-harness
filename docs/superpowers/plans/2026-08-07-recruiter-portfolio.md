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
- Add only first-screen recruiter links to both READMEs.

## Guardrails

- No model calls, `.env` reads, network, or new runtime capability.
- The demo does not claim the three scenes are one live Session.
- Detailed facts are not duplicated into cue cards; they remain in the case study/runbooks/Evidence Index. Candidate/final language stays in the concrete verification and c17c sections rather than defining the whole project.
