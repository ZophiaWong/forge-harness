# Minimal Plugin Fixtures

这份附录只说明 c16b 仓库内置的两个 local plugin fixtures。它们让读者不依赖下载、账号或网络，也能完整走一遍 plugin discovery、trust、activation 和 MCP tool call。

正式章节见 [c16b Plugin Loading / Registration](../tutorial/c16b-plugin-loading-registration.md)。

## 为什么需要两个 fixture

只放一个“大而全”的 plugin，无法证明 loader 能同时处理多个 plugin；只放一个 skill-only plugin，又覆盖不到 hook 和 MCP。c16b 因此保留两个小 fixture：

| Plugin | Skills | Hooks | MCP servers | 用途 |
| --- | --- | --- | --- | --- |
| `issue-workflow` | `triage` | `audit` | `demo` | 走完整 activation 路径。 |
| `review-helper` | `review` | 无 | 无 | 证明 skill-only plugin 也需要 trust，且不会启动子进程。 |

它们通过项目根目录的 `.forge/plugins.json` 启用。这里记录的是原插件目录；如果 CLI 使用 `--worktree`，loader 仍从原目录读取 plugin code，但 `${projectRoot}` 会绑定到 execution worktree。

## issue-workflow

目录结构如下：

```text
examples/plugins/issue-workflow/
├── .forge-plugin/plugin.json
├── skills/triage/SKILL.md
├── hooks/hooks.json
├── hooks/audit.mjs
├── mcp/mcp.json
└── mcp/server.mjs
```

manifest 只声明 component registry 的位置，不直接执行代码。preflight 会先读完 manifest、skill、hook registry、MCP registry 和 host policy，并检查路径与命名冲突；trust 通过后才 import `audit.mjs`、启动 MCP server。

`demo` server 暴露两个 raw tool：

| Raw tool | Final tool name | Host policy | 行为 |
| --- | --- | --- | --- |
| `lookup_issue` | `mcp_issue-workflow-demo_lookup_issue` | `allow / inspect` | 返回固定 issue `FH-16`。 |
| `create_note` | `mcp_issue-workflow-demo_create_note` | `ask / mutating` | 把 note 写到当前 execution workspace 的 `.forge/plugin-demo-notes.json`。 |

`audit` hook 订阅全局 `permission_decision`，再在 handler 内检查 `event.toolName` 是否以 `mcp_issue-workflow-` 开头。它是 trusted in-process ESM，只观察事件，不拦截 permission decision。

## review-helper

这个 fixture 只有一个 `review` skill：

```text
examples/plugins/review-helper/
├── .forge-plugin/plugin.json
└── skills/review/SKILL.md
```

它没有 hook，也没有 MCP server，但仍会显示 plugin trust prompt。拒绝后，`review-helper:review` 不会进入 skill catalog。

## namespace 对照

仓库还保留一个 project skill `.forge/skills/triage/SKILL.md`。因此同一轮运行里可以同时出现：

- `/triage`：project skill；
- `/issue-workflow:triage`：plugin skill；
- `/review-helper:review`：另一个 plugin 的 skill。

plugin skill 不提供短别名。这个刻意的重名证明 namespace 由 host 注册规则决定，而不是靠安装者人工避让。

## fixture 的边界

这些目录是已经“安装好”的本地输入，不代表 c16b 实现了 downloader 或 marketplace。版本字段只做基础 SemVer 校验和 trust 展示；本章也不处理依赖安装、升级权限 diff、签名、persistent trust、hot reload、hook sandbox 或 MCP restart。
