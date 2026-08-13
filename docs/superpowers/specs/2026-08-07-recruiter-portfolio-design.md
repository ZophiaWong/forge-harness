# Recruiter Portfolio Design

## Goal

Give a recruiter a truthful three-minute entry point into the from-scratch TypeScript coding-agent Runtime, showing how independently runnable checkpoints grow from the model-tool loop to the c17c coordination boundary without adding a product feature or pretending that three deterministic scenes are a live model session.

## Interview-demo modes and CLI contract

`demo:portfolio` has two deliberately separate modes. The default is the existing deterministic recruiter walkthrough; the optional Live LLM walkthrough is a variable, operator-started observation. Neither mode is a product feature, and the Live LLM walkthrough does not recast the three deterministic scenes as one continuous Session.

### Default deterministic walkthrough

`npm run demo:portfolio` remains unchanged: it uses no model, no `.env`, and no network. It emits the stable sequence of scene aliases, statuses, and short receipts:

1. `Action Boundary`: a write request is denied before dispatch; a dispatch counter proves the handler never ran.
2. `Verification Recovery`: a scripted candidate enters the real verification loop, fails once, recovers, then reaches final only after verification passes.
3. `Coordination Completion`: plan approval precedes an editor worktree write; an early `CompletionGate` is incomplete; fingerprint, verification, Git receipt, and a ready gate follow in order.

Any failed assertion exits non-zero. The scenes are independent demonstrations, not one continuous Session. CI continues to run this mode only.

`npm run demo:portfolio -- --explain` runs the same deterministic scenes and the same assertions, then adds stable, sanitized annotations that connect each receipt to the Runtime boundary it demonstrates. `--explain` does not enable a provider, read `.env`, use the network, change the scene order, or change the default command's output.

### Optional Live LLM walkthrough

`npm run demo:portfolio:live` explicitly requests one focused Live LLM walkthrough. It may require the operator's locally configured provider credentials and network access; neither is consulted by the default or `--explain` modes. The model may choose different wording, calls, order, or round counts on different runs. Its walkthrough is therefore evidence of one observed integration run, not a deterministic check, a replay of the default scenes, or a claim about general model capability.

The Live command is a thin interview launcher around the existing Forge CLI. It creates a disposable Git fixture, confirms that the fixture starts with failing tests, starts Forge with `--worktree --verify "npm test"`, checks the persisted c17c evidence after the CLI exits, and removes the fixture. The launcher stays outside the Runtime and writes no Trace or events. It has no diagnostic mode or public failure-code system.

The fixture is generated under the system temporary directory for each run. It contains `.gitignore`, `package.json`, `src/errors.mjs`, `src/retry.mjs`, and `test/retry.test.mjs`. The committed `.gitignore` excludes `.forge/`, so the Session files created before root Worktree setup do not make the fixture repository dirty. The retry tests cover first-attempt success, recovery from a transient error, `maxAttempts` as a total-attempt limit, and immediate failure for a permanent error. The fixture has no external dependencies and does not copy Forge plugin or MCP configuration.

The model receives a focused coding task rather than a tool-call script. It must preserve the tests, `package.json`, and the public API; keep implementation changes under `src/**`; track one edit task with `npm test` as its verification command; and use one synchronous isolated edit child. The prompt does not prescribe the bug, source file, task ID, title, acceptance wording, child round budget, edit method, or individual protocol calls. Fixing the coordination topology at one task and one child keeps the interview run bounded and makes source, verification, and integration evidence attributable to one child. It is an observation boundary for this walkthrough, not a limit on the Runtime.

The one-shot edit child keeps its current tool profile. It reads the contract and edits source files, but it does not receive Bash access for the demo. The Leader runs `task_verify` against the registered child source, `task_integrate` records the Git receipt, and the root verifier runs `npm test` after integration.

The Live run has a ten-minute wall-clock limit. On timeout, the launcher requests termination, escalates after two seconds if the CLI is still running, and then cleans the fixture. A model response, provider failure, missing credential, timeout, or incomplete evidence cannot become a passing deterministic claim.

The deterministic command continues to accept only `--help` and `--explain`; `--help` is standalone. Any unknown argument, duplicate flag, or unsupported flag combination writes a concise usage error to stderr and exits `2` without creating a fixture or contacting a provider. The Live walkthrough is a separate operator command, not a flag or explain variant of the deterministic walkthrough.

### Recruiter presentation boundary

The bilingual Portfolio pages present `npm run demo:portfolio -- --explain` as the roughly three-minute screen-share command. It runs the same three independent no-model scenes as the default deterministic command. The `--explain` annotations are stable and sanitized.

`npm run demo:portfolio:live` is an optional 5 to 8 minute extension. It needs an interactive TTY, Git, Bash, Node.js `>=20.19`, `OPENAI_API_KEY`, and `OPENAI_MODEL`. It uses a disposable fixture and manual approvals. Its real model output varies. CI does not run it, and its transcript is not reusable evidence. If Live is unavailable or fails in an interview, the operator returns to the deterministic walkthrough without debugging the Live run.

The Portfolio pages keep the presentation brief. They do not include a video or a full interview script. They make no claim that post-fix compaction evidence is closed or independently validated.

### Fixture, output, and evidence boundaries

Each valid walkthrough invocation owns a fresh temporary fixture under the system temporary directory after its arguments have been parsed. It may create its fixture Git repository and worktree there only, and must remove them in `finally` on success, assertion failure, provider failure, or interruption that reaches cleanup. `--help` and invalid-argument paths create no fixture. A walkthrough must not mutate the caller's checkout, source tree, existing worktrees, or credentials.

The deterministic mode keeps the strict no-secret output policy: stdout and stderr may contain only stable aliases, statuses, receipts, help text, usage text, and `--explain` annotations. They must never print environment values, API keys, authorization headers, raw provider errors, prompts, raw model text, absolute paths, unredacted Trace data, or temporary-fixture contents beyond the named evidence aliases.

The Live command inherits the existing CLI terminal so the operator can inspect the original Forge transcript and answer manual approvals. The launcher prints only short `[demo]` lines before and after that transcript. It does not filter, summarize, or replace the Runtime output. Its own lines never print environment values, API keys, authorization headers, raw exceptions, raw Trace data, or absolute temporary paths. On failure it gives one plain explanation, such as a failed Forge run, incomplete expected evidence, timeout, or cleanup failure. These messages are presentation text, not Forge events or a second diagnostic protocol.

The deterministic walkthrough validates its own assertions and cleanup. The Live walkthrough accepts variable task IDs, titles, descriptions, acceptance wording, edit counts, and model rounds. It passes only when:

- the fixture contains exactly one completed edit task and one matching synchronous edit child;
- the child is the submitted and integrated source;
- at least one file changed, and every changed path is under `src/**`;
- delegate, child mutation, task verification, and task integration were manually approved;
- the verification command and root verifier both passed `npm test`;
- the fingerprint remained current; and
- the Git receipt, final answer, and completed Session appear in the required order.

Artifact evidence is optional because the source binding, fingerprint, verification, and receipt already establish the edit chain.

This check confirms one observed Runtime integration path. It does not evaluate model reasoning, repeatability, general coding ability, production readiness, security outside the Runtime boundary, or future provider behavior. The command does not retain the Live run as public evidence.

## Public information architecture

- `PORTFOLIO.md` and `PORTFOLIO.zh-CN.md` answer the recruiter questions directly.
- `docs/interview-cue-cards.md` and its Chinese counterpart contain only a 2 to 3 minute speaking rhythm, trade-offs, evidence links, and follow-up prompts.
- `README.md` and `README.zh-CN.md` expose links near the first screen but do not duplicate the portfolio narrative.
- The canonical detailed facts remain in `docs/engineering-case-study.md`, `docs/evidence-index.md`, and operational runbooks.

The public entry point presents the full Runtime first: its model-tool loop, five architecture responsibilities, and c17c integration path. Three representative engineering decisions then provide depth: permission-before-dispatch, context-vs-Trace, and offline-eval compaction regression. A separate c17c story connects TaskGraph, plan approval, Worktree editing, fingerprint verification, Git receipts, and CompletionGate. These stories are selective recruiter narratives; the Evidence Index remains the complete capability map.

## Platform and CI boundary

The project supports Linux, macOS, and WSL2 with Node >=20.19, Git, and Bash. Native Windows shell and WSL1 are not supported because the Runtime intentionally executes Bash commands. Ubuntu CI runs the deterministic demo as a no-secret, no-model smoke check.
