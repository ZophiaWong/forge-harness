# Context management

## Pressure

A coding-agent loop accumulates instructions, tool schemas, file content, command output, approvals, and coordination messages. Forwarding all of it on every round raises cost and makes current obligations harder to find. Deleting old messages blindly loses the reasons behind earlier decisions.

Forge treats the active prompt and the historical record as different artifacts.

## Forge design

[`assemblePrompt()`](../../src/context/promptAssembly.ts) gives base instructions, tool rules, project memory, selected skill content, and the skill catalog a stable order. A leading slash invocation selects one skill body. Other skills expose only catalog metadata.

[`projectObservation()`](../../src/context/projection.ts) converts a `ToolResult` into bounded model-facing content. The result status and summary survive even when verbose content is truncated. [`createInputHistoryManager()`](../../src/context/compaction.ts) pins the original task, retains recent rounds, and replaces older material with a structured summary when the configured character budget is reached.

The Session Trace is not compacted. It remains the ordered historical ledger while the prompt becomes a smaller decision view. If compaction fails, the Runtime records that failure instead of silently claiming a successful summary.

## Comparison

| System | Current approach | Useful contrast for Forge |
| --- | --- | --- |
| [Pi](https://pi.dev/docs/latest/compaction) | Compaction keeps a recent tail and writes a structured summary; branch summarization preserves context when moving through the Session tree. | Pi exposes a richer interactive Session tree. Forge uses a linear root run and focuses on separating compacted input from Trace evidence. |
| [Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents) | Subagents move bounded work and noisy intermediate output into separate threads, returning summaries to the main thread. | Forge child Sessions serve the same context-isolation pressure, but also record explicit parent/child handoff and completion obligations inside the Runtime. |
| [Claude Code](https://code.claude.com/docs/en/context-window) | Startup instructions, file reads, tool definitions, skills, and conversation history share the window; compaction summarizes history and reloads selected persistent inputs. Its [MCP Tool Search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search) defers most external tool definitions. | Forge currently loads the active Tool Runtime explicitly and has no dynamic tool search. Its smaller scope makes prompt assembly directly inspectable. |
| [Aider](https://aider.chat/docs/repomap.html) | A token-budgeted repository map ranks and includes important symbols from the code graph. | Forge has no repository map or RAG layer. It reads files through governed tools and keeps context control at the transcript and observation level. |

## Trade-offs

Forge's character budget is easy to explain and test, but it is less precise than provider token accounting. Its compaction summary can omit details, so durable facts that affect completion must live in Runtime state, TaskGraph, or Trace rather than only in conversation history.

Selected skills reduce prompt load, but selection depends on an explicit leading invocation. The Runtime does not search a large skill library or retrieve repository knowledge automatically.

## Boundary

The c17c design does not include RAG, embeddings, a vector store, semantic code indexing, cross-Session memory synthesis, or automatic context-quality evaluation. Those are separate systems, not implied by compaction.

## Deep dive

For a frozen source-level comparison with the research evidence ledger, read [Context Construction and Compaction](https://github.com/ZophiaWong/forge-harness/blob/research/agent-runtime-design-studies/docs/design-studies/03-context-construction-and-compaction.md) on the separate research branch.
