# MCP and plugin trust

## Capability

Forge preflights configured local plugins before execution, resolves their final descriptors after workspace selection, and collects per-Session trust before importing hooks or starting plugin MCP processes. Approved MCP tools join the same permission, ToolResult, and Trace path as built-in tools.

## Prerequisites

- Node.js 20.19.0 or newer
- dependencies installed
- the tracked `.forge/mcp.json`, `.forge/plugins.json`, plugin fixtures, and skills
- `.env` configured only for the optional live run

## Deterministic check

```bash
npx vitest run test/extensions/pluginPreflight.test.ts test/extensions/pluginActivation.test.ts test/extensions/mcpSession.test.ts test/extensions/mcpToolAdapter.test.ts test/governance/mcpPolicy.test.ts
```

The focused cases cover descriptor validation, trust decisions, component activation, exact tool ownership, allowlists, missing or incompatible tools, permission composition, startup failures, and close ordering.

## Optional live run

The [c16b tutorial](../tutorial/c16b-plugin-loading-registration.md) owns the current two-plugin smoke prompt. Build first, then copy `Smoke 1` from its `运行验证` section:

```bash
npm run build
```

The CLI presents the resolved plugin root, hooks, skills, MCP commands, and tool policies before approval. Reject the unrelated standalone fixture if you want the output to show only plugin-provided tools. The write-like `create_note` tool requests a separate action approval.

## Expected observations

- rejected plugin code does not run;
- approved plugin skill IDs use a plugin namespace;
- plugin MCP tool names are namespaced and filtered by the declared allowlist;
- `plugin_trust_decided` precedes `plugin_activation_result`;
- each exposed MCP call records ordinary `permission_decision` and `tool_result` events;
- active MCP sessions stop during Session cleanup.

## Evidence

- Preflight boundary: [`src/extensions/pluginPreflight.ts`](../../src/extensions/pluginPreflight.ts)
- Activation sequencing: [`src/extensions/pluginActivation.ts`](../../src/extensions/pluginActivation.ts)
- MCP transport and adapter: [`src/extensions/mcpSession.ts`](../../src/extensions/mcpSession.ts), [`src/extensions/mcpToolAdapter.ts`](../../src/extensions/mcpToolAdapter.ts)
- Full claim map: [Evidence index](../evidence-index.md#mcp-and-plugin-trust)

## Limits

Trust lasts for the current foreground Session. Forge has no plugin downloader, publisher identity, upgrade diff, package manager, or persistent trust database. Approved ESM hooks execute in process with the current user's permissions.

## Cleanup

```bash
npm run clean:runs
rm -f .forge/plugin-demo-notes.json
```

The second command removes only the ignored local note fixture created by this Demo.
