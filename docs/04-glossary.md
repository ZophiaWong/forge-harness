# Glossary

## Agent Loop

The repeated cycle where a user message goes to the LLM, the LLM may request a tool, the harness executes that tool, tool results are appended back to messages, and the loop continues until the model stops requesting tools.

As the harness hardens, this loop also includes context projection, permission decisions, trace events, runtime state updates, and verification.

## Agent Harness

The runtime around the model that turns a direct LLM tool loop into a governed coding-agent system.

It grows to manage tools, context, permissions, sessions, traces, state, verification, and recovery.

## Tool Call

A structured request from the LLM to invoke a named tool with specific input.

In Stage 1 this may be a direct provider tool call. Later, the harness normalizes tool calls into its own protocol.

## Tool Result

The output of a tool execution that is returned to the model.

Later stages normalize successful tool output so it can be traced, summarized, and projected into future context.

## Tool Error

The failed output of a tool execution.

Later stages normalize tool errors with enough detail for recovery without dumping unsafe or excessive raw output.

## Observation

A concise representation of a tool result or error that can be used by the agent loop and included in future context projections.

Observation exists because raw tool output is often too large, noisy, or low-level for the next model turn.

## Context Projection

The deliberate selection of instructions, state, observations, tool descriptions, and constraints that the model should see on a turn.

It grows out of the direct loop once raw messages and raw tool output are no longer the right context.

## Context Compaction

A later context-management technique that summarizes or transforms accumulated context when it becomes too large.

Compaction is not the first context concept. Context Projection comes first.

## Permission Decision

The result of applying policy to a proposed tool call or command before execution, such as allow, deny, or require approval.

It grows out of the direct loop once raw tool execution becomes too risky.

## Session

The persisted execution container for one agent task, including metadata such as id, workspace, status, trace path, and resume or fork information.

It grows out of the direct loop once a run needs identity, durability, resume, fork, or replay.

## Trace

An append-only structured event log recording what happened during a session.

It grows out of the direct loop once console output is not enough to inspect or debug a run.

## Runtime State

The current in-memory execution view used by the harness to decide what to do next.

In the direct loop, state is mostly implicit in variables such as messages and current tool results. Later stages make it explicit.

## Task State

The part of runtime state that tracks the user task, status, plan, acceptance criteria, and completion signals.

## Turn State

The part of runtime state that tracks one loop iteration, including context built, model response, tool calls, observations, and stop conditions.

## Verification

Checks used to confirm that work is actually complete, such as tests, type-checking, builds, or acceptance criteria.

Verification exists because the model stopping is not the same as the task being done.

## Recovery

The process of interpreting a failure, deciding whether repair is possible, making a correction, and re-running verification when appropriate.

## ChangeSet

A reviewable representation of a proposed or applied file mutation, usually expressed as a diff or structured edit.

## Skill

A reusable prompt, instruction bundle, or resource set that helps the harness perform a specialized task.

## Hook

An extension point that runs custom behavior at a defined runtime moment, such as before a tool executes or after a trace event is appended.

## Subagent

A specialized child execution that handles a bounded task, ideally represented as a child session rather than an uncontrolled independent agent.

## Replay

The process of reading a trace to reconstruct, inspect, or partially re-run a prior session.

## Worktree Isolation

Running agent work in a separate git worktree or isolated workspace so changes are contained and reviewable.

## MCP Adapter

An integration layer that connects the harness to Model Context Protocol servers or tools while preserving local governance and traceability.

## Bounded Autonomy

The principle that an agent may act independently only within explicit limits for tools, permissions, time, scope, and verification.
