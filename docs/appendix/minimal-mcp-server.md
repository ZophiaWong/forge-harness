# Minimal MCP Server Fixture

这份附录只解释仓库里的 local MCP server fixture。它不是一章正式教程，也不是 c16a 的学习目标。

[c16a MCP Tool Integration](../tutorial/c16a-mcp-tool-integration.md) 要处理的问题是：Forge 作为 coding agent host，怎样把外部 MCP tools 接进同一条 `Tool Runtime`、permission、`ToolResult` 和 trace 路径。为了让这个 checkpoint 不依赖 GitHub、Notion、Linear 或网络账号，仓库提供一个本地 MCP server 作为外部系统替身。

## 这个 fixture 做什么

源码在：

```text
src/extensions/mcpDemoServer.ts
```

build 之后，c16a 的 tracked `.forge/mcp.json` 用这个 command 启动它：

```bash
node dist/extensions/mcpDemoServer.js
```

server 只暴露两个 raw MCP tools：

| Tool | 含义 | 预期 Forge governance |
| --- | --- | --- |
| `lookup_issue` | 查询固定 demo issue `FH-16`。 | inspect / allow |
| `create_note` | 把一条 note 追加到本地 demo notes 文件。 | mutating / ask |

这两个名字是 MCP server 暴露的原始 tool name。c16a 的 adapter 会在 Forge 侧加 server 前缀，得到 `mcp_demo_lookup_issue` 和 `mcp_demo_create_note`。前缀不是这个 fixture 的职责。

## 本地状态文件

`create_note` 会写入：

```text
.forge/mcp-demo-notes.json
```

这个文件模拟真实外部系统里的副作用，比如创建 issue comment、Notion page 或 Linear note。它放在 `.forge/` 下，属于本地 runtime artifact，不应该进入课程 checkpoint。

notes 文件是一个 JSON array，元素形状为：

```json
{
  "id": "note-1",
  "issueId": "FH-16",
  "body": "Require approval for create_note.",
  "createdAt": "2026-07-17T08:01:00.000Z"
}
```

## 这个 fixture 不做什么

它不读取 `.forge/mcp.json`，不决定 permission，不知道哪些 tools 应该被 allow、ask 或 deny，也不写 Forge trace。那些都是 c16a 要实现的 host-side adapter 和 governance 工作。

它也不实现真实产品需要的 MCP server 管理能力：多 server、远程 HTTP transport、OAuth、环境变量注入、trust prompt、tool allowlist、输出截断、重连和 server registry 都不在这里。

所以读 c16a 时，可以把这个 server 当成已经存在的外部 MCP server。重点不是“怎么写 MCP server”，而是 Forge 怎样安全、可追踪地使用它。
