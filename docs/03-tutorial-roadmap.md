# Tutorial Roadmap

Forge Harness should evolve through runnable vertical slices. The docs provide the learning order, while source directories provide maintainable implementation boundaries.

This roadmap uses three different planning terms:

- `Stage`: a broad topic arc, such as Tool Runtime or Permission Governance.
- `Chapter`: one tutorial lesson in `docs/tutorial/`.
- `Milestone`: a runnable git checkpoint captured after a chapter is complete.

Stages group the learning path. Chapters are what readers follow. Milestones are what branches and tags preserve.

The tutorial rhythm is:

```text
direct implementation
  -> exposed pain point
  -> forged harness mechanism
  -> stronger implementation
```

The first loop should be intuitive. Later stages should earn every abstraction.

## Stage 0: High-Level Overview

- What is an agent harness?
- What is Forge Harness?
- What is the direct agent-loop data flow?
- Why start from `user -> LLM -> tool_use -> bash -> tool_result -> LLM -> done`?

Outcome: readers understand that the harness will be forged from a working loop, not designed as a large architecture first.

## Stage 1: Minimal Real LLM Loop

Build the smallest TypeScript coding-agent loop that uses a real LLM.

- CLI input.
- Real LLM call.
- One simple `bash` tool.
- Messages history.
- Tool-call detection.
- Tool execution.
- Tool result appended back into messages.
- Loop until the model stops requesting tools.
- Very thin dangerous-command blocking as a visible problem seed.

Pain points exposed:

- The bash tool is too powerful.
- Tool logic is inline and will not scale.
- Raw output can be huge or noisy.
- There is no durable trace of what happened.
- There is no real session boundary.
- The model can claim success without proof.

Outcome: readers see the core agent pattern run for real before learning the harness mechanisms around it.

## Stage 2: Tool Runtime Enhancement

The Stage 1 loop has one inline bash function. That is fine for the first lesson, but it does not scale once tools multiply.

Forge the first tool runtime:

- Tool schema.
- Tool metadata.
- Tool registry.
- Dispatcher.
- Result / error protocol.
- Basic file/search tools when needed by the lesson.

Outcome: tool calls become structured and teachable rather than ad hoc function calls.

## Stage 3: Permission Governance Enhancement

The Stage 1 bash tool can mutate files, run destructive commands, or hide side effects. A tiny deny list is only a warning sign, not a policy system.

Forge permission governance:

- Risk classification.
- Read-only auto allow.
- File mutation governance.
- Dangerous command deny rules.
- Approval model for risky actions.
- Safe bash executor concerns such as cwd, timeout, output capture, exit code, and non-interactive execution.

Outcome: side effects are explicitly governed before execution.

## Stage 4: Context Management Enhancement

The direct loop feeds messages and tool results back to the model. That works at first, then becomes noisy, expensive, and hard to steer.

Forge context management:

- Context projection.
- Observation normalization.
- Tool output truncation.
- Failure summary.
- Relevant state selection.
- Skill loading placeholder.

Outcome: the model receives a deliberate projection of the run instead of raw accumulated data.

## Stage 5: Session / Trace Enhancement

The direct loop is hard to inspect after the fact. If it crashes or the user wants to resume, there is no durable execution container.

Forge session and trace persistence:

- JSONL trace.
- Session metadata.
- Trace event vocabulary.
- Resume.
- Fork.
- Replay basics.

Outcome: executions become inspectable, resumable, and easier to debug.

## Stage 6: Verification / Recovery

The model may say it is done, but coding work should be checked.

Forge verification and recovery:

- Run tests.
- Capture command result.
- Summarize failures.
- Repair loop.
- Retry policy.
- Stop condition.

Outcome: the harness can verify work and recover from common failures before claiming completion.

## Stage 7: Extensions

Once the single-agent harness has a real loop, governed tools, projected context, trace/session persistence, and verification, extensions can be introduced without stealing the center of gravity.

Forge extension points:

- Skills.
- Context compaction.
- Hooks.
- Subagent as child session.
- MCP adapter.
- Worktree isolation.
- Team protocols.
- Bounded autonomy.

Outcome: advanced capabilities are added as extensions to a working single-agent foundation.

## Testing Support

Deterministic model fixtures can be added later for tests, docs, and offline examples. They should support the tutorial; they should not replace the Stage 1 experience of seeing a real LLM use a tool.

## Chapter Map

Tutorial chapters should be written in Chinese. Technical terms such as `Agent Loop`, `Tool Runtime`, `Context Projection`, `Session`, `Trace`, `Observation`, `Permission Policy`, and `ChangeSet` should stay in English.

Initial chapter map:

- Stage 0: Orientation
  - `c00-overview`
- Stage 1: The Direct Loop
  - `c01-minimal-real-llm-loop`
  - `c02-cli-and-message-history`
- Stage 2: Tool Runtime Grows Out Of Bash
  - `c03-inline-bash-pain`
  - `c04-tool-schema-and-registry`
  - `c05-tool-result-and-error-protocol`
- Stage 3: Permission Governance
  - `c06-risk-classification`
  - `c07-permission-policy`
  - `c08-safe-command-execution`
- Stage 4: Context Management
  - `c09-observations`
  - `c10-context-projection`
  - `c11-context-pressure-and-compaction`
- Stage 5: Session And Trace
  - `c12-jsonl-trace`
  - `c13-session-metadata`
  - `c14-resume-and-replay`
- Stage 6: Verification And Recovery
  - `c15-run-tests-tool`
  - `c16-failure-summary-and-repair-loop`
- Stage 7: Extensions
  - `c17-skills-and-hooks`
  - `c18-child-session-subagent`
  - `c19-worktree-and-mcp-boundary`

## Tutorial Docs, Branches, and Tags Strategy

Tutorial documents, branches, and tags serve different jobs:

- `main` is the latest integrated harness.
- `docs/tutorial/` is the readable tutorial path on `main`.
- `tutorial/cNN-name` branches are living chapter milestone lines.
- `tutorial-cNN-name` tags are stable chapter milestone checkpoints.

Do not create tutorial branches or tags until the corresponding chapter milestone exists. Even then, create them only after explicit user confirmation.

Recommended tutorial document layout:

```text
docs/tutorial/
  c00-overview.md
  c01-minimal-real-llm-loop.md
  c02-cli-and-message-history.md
  c03-inline-bash-pain.md
```

Tutorial documents should live in `docs/tutorial/` for discoverability. Git branches and tags preserve the runnable historical state of each lesson. Docs explain the path; git captures the checkpoint.

Do not copy each stage's complete source tree into `docs/tutorial/`. Keep source code in `src/` and use branches/tags to preserve historical versions.

Conceptual branch names:

- `tutorial/c00-overview`
- `tutorial/c01-minimal-real-llm-loop`
- `tutorial/c02-cli-and-message-history`
- `tutorial/c03-inline-bash-pain`

Suggested policy:

- `main` contains the latest integrated version.
- `docs/tutorial/*` contains the latest readable tutorial sequence.
- `tutorial/cNN-name` branches represent living chapter milestone lines that may receive fixes or improvements.
- `tutorial-cNN-name` tags capture stable tutorial checkpoints and should not move.
- Docs follow milestone learning order.
- Source code follows engineering module boundaries.
- Branches represent vertical slices.
- Tags represent frozen runnable checkpoints.

Example:

```text
branch: tutorial/c01-minimal-real-llm-loop
tag:    tutorial-c01-minimal-real-llm-loop
```

If a published checkpoint needs a fix, update the matching branch and create a new tag such as `tutorial-c01-minimal-real-llm-loop-v2`. Do not move the old tag.

Important principle:

```text
docs order != source directory order != branch structure != tag history
```

They serve different purposes:

- Docs: learning path.
- Source: maintainable implementation.
- Branches: living chapter milestone development lines.
- Tags: stable tutorial checkpoints.
