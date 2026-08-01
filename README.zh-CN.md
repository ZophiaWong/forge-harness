# Forge Harness

[English](README.md)

Forge Harness 是一个可运行的 TypeScript Coding Agent Runtime。模型声称任务已经完成时，Runtime 将它视为 candidate answer，而不是完成证据。权限、执行证据、隔离工作区和验证命令共同决定本次运行能否结束。

当前实现停在 `c17c Coordination / Completion Protocol`。仓库以源码形式提供，可供阅读和本地运行，不包含托管服务。中文教程单独解释这些机制如何逐章演进。

## 一次实际完成记录

当前的 [c17c live snapshot](docs/assets/evidence/c17c-team-completion.json) 记录了一次模型实跑：

```text
pre-approval writes  blocked
edit plan            approved
artifact write       completed in teammate Worktree
task verification    passed
Git integration      receipt recorded
premature candidate  deferred
teammates            stopped, unread=0
root verification    passed
session              completed in 31 rounds
```

这条记录只对应一次运行，不代表模型以后一定会有相同行为。`npm run smoke:c17c-capstone` 不调用模型，只确定性检查 TaskGraph ownership、review、verification、Git integration 和 CompletionGate 不变量，不会复现这次实跑。

## Runtime 概览

![Forge Harness c17c Runtime 架构](docs/assets/architecture-overview.svg)

一次 root run 负责完整的决策链：

```text
prompt assembly
  -> model response
  -> permission policy 与可选 approval
  -> Tool Runtime
  -> 有界 observation 与 Trace evidence
  -> TaskGraph、child、teammate 与 Git obligations
  -> CompletionGate
  -> root verifier
  -> final answer
```

Forge 的五层是分析架构的视角，不代表教程顺序：

| 层 | 职责 |
| --- | --- |
| `L1 Loop & Execution` | 模型轮次、工具分发和最终回答流程。 |
| `L2 Governance & Action Boundary` | 权限判断、审批、路径边界和扩展信任。 |
| `L3 Context & Knowledge` | Prompt assembly、memory、已选 skills、observations 和 compaction。 |
| `L4 State, Evidence & Reliability` | Session metadata、Trace events、RuntimeState、verification 和 receipts。 |
| `L5 Coordination & Scale` | Background work、Worktrees、child Sessions、TaskGraph、teammates 和 CompletionGate。 |

[架构总览](docs/architecture-overview.md)详细说明了模块归属、状态边界与 c17c 完成协议。

## Runtime 管理哪些事实

- Built-in 和 MCP 工具在执行前都要经过明确的 `allow`、`ask` 或 `deny` 决策。
- Tool result 通过统一结构进入有界 observation、RuntimeState 和 append-only Trace。
- Candidate answer 只有在异步活动收敛、CompletionGate ready、root verifier 通过后才会成为 final answer。
- 可能修改文件的 root、child 和 teammate 工作可以放入生成的 Git Worktree，并记录 source identity。
- Plugin 在 import 或启动 MCP 之前要经过 descriptor preflight 和本 Session 的信任确认。
- c17c 要求 actor-owned evidence、review、edit plan approval、source verification、Git integration receipt、teammate shutdown 和完整的 team state。

[证据索引](docs/evidence-index.md)把这些陈述逐项对应到源码、测试、确定性 smoke、可选 live evidence 和明确限制。

## 环境与安装

需要 Node.js `20.19.0` 或更新版本。

```bash
npm install
cp .env.example .env
npm run build
```

在 `.env` 中配置模型连接：

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
OPENAI_BASE_URL=
```

使用 OpenAI 默认端点时保持 `OPENAI_BASE_URL` 为空；也可以显式配置兼容网关。

## 运行 CLI

可以先执行一个只读任务：

```bash
npm run start -- "Read package.json and summarize the available Runtime commands. Do not modify files."
```

需要命令级完成条件时，注册 root verifier：

```bash
npm run start -- --verify "npm run build" "Inspect the project and report readiness only after the verifier passes."
```

任务可能修改文件时，把 root run 绑定到生成的 Git Worktree：

```bash
npm run start -- --worktree "Inspect the repository and make one explicitly requested change."
```

这些命令会调用 `.env` 配置的模型服务。文件修改、plugin trust、外部工具、verification 和 Git integration 可能要求交互审批。

## 确定性验证

以下检查不会调用模型服务：

```bash
npm run docs:check
npm run typecheck
npm run test
npm run build
```

c17c 还有两条不依赖模型输出的集成 smoke：

```bash
npm run smoke:c17c-capstone
npm run smoke:c17c-child
```

Capstone smoke 串起 TaskGraph ownership、review、verification、Git integration 与 CompletionGate；child smoke 聚焦 one-shot edit source 的集成。它们不证明未来模型一定遵守协议，也不验证外部服务是否可用。

## Demo 操作手册

- [Verification / Recovery](docs/demos/verification-recovery.md)
- [Worktree isolation](docs/demos/worktree-isolation.md)
- [Async child handoff](docs/demos/async-child-handoff.md)
- [MCP and plugin trust](docs/demos/mcp-plugin-trust.md)
- [c17c team completion](docs/demos/c17c-team-completion.md)

每篇 runbook 都把可重复的确定性检查与可选的模型实跑分开说明。

## 文档入口

- [架构总览](docs/architecture-overview.md)：当前 c17c 的执行、状态、信任、隔离与完成边界。
- [工程案例](docs/engineering-case-study.md)：哪些具体失败迫使 Runtime 增加机制，以及没有采用哪些替代方案。
- [证据索引](docs/evidence-index.md)：能力陈述与源码、测试、smoke、live evidence 的对应关系。
- [Design Studies](docs/design-studies/README.md)：上下文管理、Tool Runtime、Session persistence 和多 Agent 协调。
- [Agent Runtime 深度研究](https://github.com/ZophiaWong/forge-harness/tree/research/agent-runtime-design-studies/docs/design-studies)：独立 research branch 上的源码研究，对照 Forge、Pi 与 provenance 受限的 Claude 本地快照，讨论 loop completion、tool boundary、context、Session、coordination 和 extension trust。
- [教程路线图](docs/02-tutorial-roadmap.md)：两部分中文学习路径。
- [项目架构](docs/01-project-architecture.md)：教程视角下的目标边界与 checkpoint 对应关系。
- [Appendix](docs/appendix/minimal-mcp-server.md)：扩展章节使用的本地 MCP 与 plugin fixtures。
- [Agent instructions](AGENTS.md)：本仓库对 coding agent 的工作约束。

## 教程路径

教程回答的是另一个问题：这个 Runtime 如何一步步演进到当前形态？

- `Part 1: Core Harness` 建立单 Agent 的执行、治理、上下文、证据和验证链。
- `Part 2: Scale & Extensions` 加入 background work、Worktrees、隔离委派、MCP、plugins、TaskGraph、teammates 与 c17c completion。

可以从 [c00 Orientation](docs/tutorial/c00-orientation.md) 开始，也可以先看[教程路线图](docs/02-tutorial-roadmap.md)。教程继续使用中文，不会改写成作品集或发布宣传材料。

## 清理本地运行产物

运行后可能在 `.forge/sessions/` 和 `.forge/worktrees/` 留下本地数据：

```bash
npm run clean:runs
```

命令会显示数量并要求 `y/N` 确认。自动化可以显式跳过确认：

```bash
npm run clean:runs -- --yes
```

清理流程先通过 Git 移除已注册的生成 Worktree，再只删除这两个运行产物目录。`.forge/mcp.json`、plugins、memory、skills 和 Git branches 都会保留。

## 明确边界

c17c Runtime 没有实现 crash-safe resume、Attempts、idempotent replay、reconciliation、distributed coordination、remote workers、high availability、操作系统 sandbox、plugin marketplace、RAG、vector database、Web UI 或 hosted control plane。

Git Worktree 隔离的是文件改动，不是进程、凭据、网络或主机权限。获批的 plugin hook 是进程内可信代码。Live model run 只是运行样本，确定性测试与 smoke command 才是可重复的证据层。

## License

本项目使用 [Apache License 2.0](LICENSE)。
