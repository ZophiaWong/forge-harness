# Architecture

## Engineering Summary

Forge Harness is built around:

```text
Agent Loop
+ Tool Runtime
+ Context Projection
+ Permission Governance
+ Session / Trace Persistence
+ Runtime State Model
+ Verification / Recovery
```

This summary describes the hardened shape of the harness. It is not the first thing the tutorial should force readers to implement.

## Architecture Grows From The Loop

The first runnable loop should be direct:

```text
User
  ↓
LLM
  ↓
tool_use
  ↓
bash
  ↓
tool_result
  ↓
LLM
  ↓
done
```

That loop is the source of the architecture.

- Inline bash becomes a Tool Runtime when one tool is no longer enough.
- A tiny dangerous-command check becomes Permission Governance when raw bash feels unsafe.
- Raw messages and tool output become Context Projection when the model starts seeing too much or the wrong data.
- Console output becomes Trace Persistence when the run needs to be inspected later.
- An ad hoc process becomes a Session when the run needs identity, resume, fork, or replay.
- A final answer becomes Verification / Recovery when the model needs to prove that code works.

The tutorial should keep returning to this question: what problem in the direct loop forced this mechanism to exist?

## High-Level Runtime Data Flow

The hardened runtime eventually looks like this:

```text
User Task
  ↓
Session Init
  ↓
Context Projection
  ↓
Agent Loop
  ↓
Model Response
  ↓
Tool Call
  ↓
Tool Validation
  ↓
Permission Decision
  ↓
Tool Execution
  ↓
Observation
  ↓
Trace Append
  ↓
Runtime State Update
  ↓
Continue / Stop
```

Key interpretations:

- Context Projection happens before the model call, after the direct messages flow becomes too noisy.
- Permission Decision happens before tool execution, after side effects need governance.
- Observation is a normalized representation of raw tool results.
- Trace is a structured event log.
- Runtime State is the current execution view.
- The agent loop uses observation and runtime state to decide whether to continue or stop.

## Agent Loop And Kernel

Stage 1 should not start with a heavy kernel abstraction. It should start with a readable loop:

- Send messages to a real LLM.
- Detect tool calls.
- Execute the requested tool.
- Append tool results to messages.
- Continue until the model stops requesting tools.

As the loop grows, the agent kernel becomes the small coordinator that owns turn orchestration:

- Start or resume a session.
- Build the context projection.
- Call the LLM integration.
- Interpret model responses.
- Route tool calls through the tool runtime.
- Update runtime state.
- Decide whether to continue or stop.

The kernel should stay small. It coordinates runtime parts without absorbing all policy and persistence logic.

## Tool Runtime

Tools begin as one direct bash function. That is useful because readers can see the loop work.

The tool runtime appears when that inline function creates obvious problems:

- Multiple tools need consistent names and schemas.
- Tool results and errors need a shared protocol.
- Tool side effects need metadata.
- Tool execution needs permission integration.
- Tool outputs need observation summaries.
- Tool activity needs trace events.

The tool runtime should eventually include:

- Tool registry.
- Tool schema.
- Tool dispatcher.
- Tool executor.
- Tool result protocol.
- Tool error protocol.
- Side-effect metadata.
- Observation summarizer.
- Permission integration.
- Trace event emission.

Conceptual tool pipeline:

```text
ToolCall
  ↓
Schema validation
  ↓
Risk classification
  ↓
Permission decision
  ↓
Execution
  ↓
Raw result / raw error
  ↓
Normalized ToolResult
  ↓
Observation summary
  ↓
Trace event
  ↓
Context projection
```

Early tools may be limited to simple examples such as `bash`, `read_file`, `grep`, `glob`, `edit_file`, `run_command`, or `run_tests`. They should be added only when the tutorial stage needs them.

## Permission Governance

Permission Governance decides whether an action is allowed.

It should be introduced because the direct bash loop is powerful enough to be dangerous. Stage 1 can include a very thin deny list to make the risk visible, but that is not the final design.

Basic direction:

- Read-only tools can usually be auto-allowed.
- File mutation tools should be governed and traceable.
- Shell commands should be risk-classified.
- Dangerous commands should be blocked.
- Risky commands may require approval or explicit policy.

Permission policy is separate from safe execution.

Example permission policy:

- Allow `npm test`.
- Deny `rm -rf /`.
- Ask or deny commands with shell redirection, `sudo`, destructive git commands, or suspicious file mutation.

Example safe command executor behavior:

- Restrict cwd.
- Apply timeout.
- Capture stdout and stderr.
- Truncate excessive output.
- Reject interactive commands.
- Capture exit code.
- Preserve traceability.

## Context Management

Context Management controls what information reaches the model.

In Stage 1, context can simply be the message history plus tool results. That simplicity is useful. The pain arrives when raw messages, raw tool output, and repeated failures make the next model call noisy or expensive.

The first hardened context concept is Context Projection:

- Select task instructions.
- Select relevant runtime state.
- Include recent observations.
- Include relevant trace summaries.
- Include tool availability and constraints.
- Omit irrelevant or overly large data.

Context Compaction comes later. It should summarize or transform accumulated context when sessions become too large.

## Session / Trace Runtime

Session and trace are related but separate.

The direct loop can print commands and results to the console. That is enough for the first lesson, but not enough to inspect, resume, fork, or replay a run.

Session is the persisted execution container for one agent task. It should eventually include:

- Session id.
- Workspace path.
- Parent session id.
- Status.
- Trace path.
- Session metadata.
- Resume and fork metadata.

Trace is the append-only structured event stream. JSONL is the likely starting format.

Example trace events:

- `session_started`
- `turn_started`
- `context_built`
- `model_requested`
- `model_responded`
- `tool_call_requested`
- `permission_decided`
- `tool_executed`
- `tool_failed`
- `observation_created`
- `changeset_applied`
- `test_result`
- `session_completed`

## Runtime State Model

Runtime State is the current in-memory execution view used by the harness.

In the direct loop, much of this state is implicit in variables such as messages, current tool calls, and command output. As the harness hardens, those implicit variables become explicit domain concepts.

Runtime State is not the same thing as trace. Trace records facts that happened. State is the current projection used for decisions.

State should be represented by explicit domain types and module-owned projections, not a giant centralized state module.

Examples:

- `TaskState`
- `TurnState`
- `ToolState`
- `ContextState`
- `PermissionState`
- `SessionState`
- `TraceEvent`

Snapshotting state may come later, but it is not part of the initial scaffold.

## Verification / Recovery

A coding agent should not claim completion without verification.

The direct loop can stop when the model stops asking for tools. That is an agent-loop stop condition, not proof that the task is done.

Verification may include:

- Type-checks.
- Tests.
- Linting.
- Build commands.
- User-provided acceptance checks.

Recovery may include:

- Summarizing failures.
- Deciding whether a retry is useful.
- Repairing known issues.
- Stopping when the loop reaches a limit or needs user input.

## Extension Points

Extensions should be explicit and late enough to avoid distracting from the core loop.

Potential extensions:

- Skills.
- Hooks.
- Context compaction.
- Child-session subagents.
- MCP adapter.
- Worktree isolation.
- Team protocols.
- Bounded autonomy.

Extension points should support the harness rather than redefine it as a plugin platform too early.

## Session / Trace / State Distinction

Use this principle throughout the project:

```text
Session is the execution container.
Trace is the append-only event log.
State is the runtime projection / domain model.
```

- Session answers: what task execution is this?
- Trace answers: what happened?
- State answers: what is the current execution view?
