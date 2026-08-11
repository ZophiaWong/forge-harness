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

The live path keeps the Runtime action boundary in force and succeeds only when its fixed fixture acceptance checks and deterministic verifier evidence are satisfied. A model response, a provider failure, or a skipped/missing credential is not evidence by itself. The CLI must report these outcomes with stable sanitized status/reason codes; it must not turn a failed or unavailable live observation into a passing deterministic claim.

The deterministic command continues to accept only `--help` and `--explain`; `--help` is standalone. Any unknown argument, duplicate flag, or unsupported flag combination writes a concise usage error to stderr and exits `2` without creating a fixture or contacting a provider. The Live walkthrough is a separate operator command, not a flag or explain variant of the deterministic walkthrough.

### Recruiter presentation boundary

The bilingual Portfolio pages present `npm run demo:portfolio -- --explain` as the roughly three-minute screen-share command. It runs the same three independent no-model scenes as the default deterministic command. The `--explain` annotations are stable and sanitized.

`npm run demo:portfolio:live` is an optional 5 to 8 minute extension. It needs an interactive TTY, Git, Bash, Node.js `>=20.19`, `OPENAI_API_KEY`, and `OPENAI_MODEL`. It uses a disposable fixture and manual approvals. Its real model output varies. CI does not run it, and its transcript is not reusable evidence. If Live is unavailable or fails in an interview, the operator returns to the deterministic walkthrough without debugging the Live run.

The Portfolio pages keep the presentation brief. They do not include a video or a full interview script. They make no claim that post-fix compaction evidence is closed or independently validated.

### Fixture, output, and evidence boundaries

Each valid walkthrough invocation owns a fresh temporary fixture under the system temporary directory after its arguments have been parsed. It may create its fixture Git repository and worktree there only, and must remove them in `finally` on success, assertion failure, provider failure, or interruption that reaches cleanup. `--help` and invalid-argument paths create no fixture. A walkthrough must not mutate the caller's checkout, source tree, existing worktrees, or credentials.

The deterministic mode keeps the strict no-secret output policy: stdout and stderr may contain only stable aliases, statuses, receipts, sanitized reason codes, help text, usage text, and `--explain` annotations. They must never print environment values, API keys, authorization headers, raw provider errors, prompts, raw model text, absolute paths, unredacted Trace data, or temporary-fixture contents beyond the named evidence aliases.

The Live command is an interactive operator walkthrough. It inherits the existing CLI terminal so the operator can inspect and answer manual approvals; that transcript may therefore include variable model/tool text, provider failures, and Runtime paths. The wrapper's own preflight and final receipt remain sanitized and never print environment values, API keys, or authorization headers. The disposable fixture does not copy Forge plugin or MCP configuration.

The deterministic walkthrough validates its own assertions and cleanup. The Live LLM walkthrough validates only that its one temporary fixture reached the stated Runtime-owned evidence boundary: policy/approval decisions, deterministic verifier result, and any required completion or receipt facts. It does not validate model reasoning, repeatability, production readiness, security outside the Runtime boundary, or future provider behavior. Durable live evidence, if retained, is sanitized and is reviewed against that boundary before it can be cited outside the command output.

## Public information architecture

- `PORTFOLIO.md` and `PORTFOLIO.zh-CN.md` answer the recruiter questions directly.
- `docs/interview-cue-cards.md` and its Chinese counterpart contain only a 2 to 3 minute speaking rhythm, trade-offs, evidence links, and follow-up prompts.
- `README.md` and `README.zh-CN.md` expose links near the first screen but do not duplicate the portfolio narrative.
- The canonical detailed facts remain in `docs/engineering-case-study.md`, `docs/evidence-index.md`, and operational runbooks.

The public entry point presents the full Runtime first: its model-tool loop, five architecture responsibilities, and c17c integration path. Three representative engineering decisions then provide depth: permission-before-dispatch, context-vs-Trace, and offline-eval compaction regression. A separate c17c story connects TaskGraph, plan approval, Worktree editing, fingerprint verification, Git receipts, and CompletionGate. These stories are selective recruiter narratives; the Evidence Index remains the complete capability map.

## Platform and CI boundary

The project supports Linux, macOS, and WSL2 with Node >=20.19, Git, and Bash. Native Windows shell and WSL1 are not supported because the Runtime intentionally executes Bash commands. Ubuntu CI runs the deterministic demo as a no-secret, no-model smoke check.
