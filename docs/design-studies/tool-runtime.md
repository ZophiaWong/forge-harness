# Tool Runtime

## Pressure

A function call from a model mixes three questions that should not share one answer: is the request structurally valid, is it authorized, and did it execute successfully? Extensions add another question: when did external code become trusted enough to register tools or hooks?

Forge keeps those boundaries explicit.

## Forge design

Tool definitions describe model-visible inputs. A permission policy classifies a requested call as `allow`, `ask`, or `deny`. Optional approval happens next. Only an approved call reaches its owning Tool Runtime, which returns the common `ToolResult` shape.

[`createToolRuntime()`](../../src/tools/runtime.ts) dispatches built-ins. [`composeToolRuntimes()`](../../src/tools/compositeRuntime.ts) combines approved MCP tools with built-ins and rejects duplicate names. Calls, decisions, approvals, results, and lifecycle hook outcomes are recorded separately.

Plugin startup has its own trust boundary. Descriptor and component preflight run before import or process startup, then the CLI collects a per-Session trust decision. MCP annotations inform classification, but do not override Forge policy. Approved in-process hooks remain trusted code with the current user's permissions.

## Comparison

| System | Current approach | Useful contrast for Forge |
| --- | --- | --- |
| [Pi](https://pi.dev/docs/latest/extensions) | TypeScript extensions can register tools, intercept events, alter compaction, and add UI or commands. The documentation states that extensions run with full system permissions. | Forge plugins are also trusted in-process code, but preflight and per-Session activation make the startup decision visible. Forge deliberately has no extension UI. |
| [Codex](https://learn.chatgpt.com/docs/agent-approvals-security) | Local clients combine OS-enforced sandbox modes with an approval policy. MCP servers connect through shared configuration and expose external tools. | Forge implements only the in-process policy and approval layer. It should not be described as equivalent to Codex's OS sandbox. |
| [Claude Code](https://code.claude.com/docs/en/permissions) | Permission rules cover built-in, MCP, and agent tools; Bash sandboxing adds OS-level filesystem and network enforcement. | The separation between permission and sandbox is the closest conceptual match. Forge stops at the permission boundary and Git workspace isolation. |
| [Aider](https://aider.chat/docs/git.html) | Editing is closely coupled to Git commits and undoable history. | Forge treats Git as edit provenance and integration evidence, while non-edit tools still use the same policy and `ToolResult` path. |

## Trade-offs

A common result type and one policy path make failure behavior testable across built-in and MCP tools. They also require adapters to normalize external schemas and errors. Fail-closed handling of unknown tools is safer than accidental execution, but it means extensions must complete registration correctly before the model can use them.

Per-Session plugin trust avoids a hidden persistent allowlist. It also makes interactive startup unsuitable for unattended CI. Deterministic tests cover preflight and activation; live plugin runs remain an explicit operator action.

## Boundary

Forge is not a process sandbox, container runtime, network proxy, package manager, extension marketplace, malware scanner, or persistent trust database. Plugin preflight validates declared structure and ownership, not arbitrary code safety.

## Deep dive

For a frozen source-level comparison with the research evidence ledger, read [Tool Runtime and Action Boundary](https://github.com/ZophiaWong/forge-harness/blob/research/agent-runtime-design-studies/docs/design-studies/02-tool-runtime-and-action-boundary.md) on the separate research branch.
