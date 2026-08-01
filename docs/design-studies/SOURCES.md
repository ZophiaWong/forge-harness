# Sources

研究日期：2026-08-01（Asia/Hong_Kong）。

文章中的 `Claude`、`Pi`、`Forge` 均指下表冻结的本地快照。引用先通过本表绑定 repository、commit 与 version，再使用 `Repo@commit:path:Lx-Ly` 定位源码。

| 研究标签 | 本地项目名 | Canonical repository | Git remote | Snapshot branch | Commit | Tag / package version | 工作区状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Forge | Forge Harness | `ZophiaWong/forge-harness` | `git@github.com:ZophiaWong/forge-harness.git` | `main` | `75714f28a80e4423a324044c4afcc5e6bee82f82` | 无指向该 commit 的 tag；`forge-harness@0.0.0` | 研究 worktree 创建时 clean；primary checkout 中已有并继续出现与本研究无关的未跟踪文档，本研究不读取、不携带、不触碰 |
| Pi | Pi Agent Harness | `earendil-works/pi` | `https://github.com/earendil-works/pi.git` | `main` | `977ec833bbb86e245057e9162dbc1443c7b6e707` | packages `0.83.0`；`git describe` 为 `v0.83.0-118-g977ec833` | clean |
| Claude | Claude Code Haha | `NanmiCoder/claude-code-haha` | `git@github.com:NanmiCoder/claude-code-haha.git` | `main` | `430502e7bbe7e502d08619722ebc869b92bdd826` | 无 tag；local package `claude-code-local@999.0.0-local` | clean |

## 仓库身份判定

### Forge

remote、`package.json`、README、source layout 与 tutorial history 一致表明该仓库是 Forge Harness。`main`、`origin/main` 与研究基线均指向 `75714f2`，commit subject 为 `feat: add c17c coordination and completion protocol (#6)`。

仓库级指令：`AGENTS.md`。当前实现边界以 source、tests 和 `c17c` tutorials 为准；roadmap 中的 `c18` 是 future work。

### Pi

remote、根 README 和 workspace package metadata 一致表明该仓库是 `earendil-works/pi`。核心研究范围主要落在 `@earendil-works/pi-agent-core@0.83.0`、`@earendil-works/pi-coding-agent@0.83.0` 与 `@earendil-works/pi-ai@0.83.0`。

仓库级指令：`AGENTS.md` 与 `CONTRIBUTING.md`。本研究只读，不运行被仓库指令禁止的 full build/test，也不修改 generated model data。

### Claude

该本地仓库并非 Anthropic 的官方 public source repository。它的 README 将自身描述为基于 2026-03-31 泄露源码修复的可运行副本；remote 指向 `NanmiCoder/claude-code-haha`，package version 是人为设置的 `999.0.0-local`。因此：

- `Claude@430502e` 只证明该本地快照中的实现，不自动证明当前官方 Claude Code 产品行为；
- 修复层、stub、generated code、bundled/minified artifact 与原始实现之间可能存在差异；
- 无法由源码和测试交叉验证的产品行为降为 `Medium` 或 `Unknown`，并显式记录 evidence gap。

该仓库未发现 `AGENTS.md`、`CLAUDE.md` 或 `CONTRIBUTING.md`。

## 冻结命令

版本冻结使用只读 Git 与 package metadata：

```text
git remote -v
git branch --show-current
git rev-parse HEAD
git describe --tags --always --dirty
git status --short --branch
```

研究期间不 fetch、不切换第三方仓库 branch，也不把后续 upstream 变化混入当前引用。
