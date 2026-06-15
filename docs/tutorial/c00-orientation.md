# c00 Orientation

现在这个 repo 是 documentation baseline。没有 `src/`，没有 `package.json`，也没有可运行 harness。这不是漏了实现，而是课程的起点。

`c00` 先讲清楚这门课要把什么东西做出来：从一个很小的 one-agent loop 开始，逐章补上 advanced coding agent 需要的核心能力。后面每个机制都要回答一个具体问题，不能提前把 repo 做成平台。

## 本章边界

| 项目 | 内容 |
| --- | --- |
| branch name | 当前在 `main` 的 documentation baseline；如果冻结 checkpoint，建议用 `tutorial/c00-orientation`。 |
| tag name | 如果需要冻结，建议用 `tutorial-c00-orientation`。本章不创建 branch 或 tag。 |
| 前置状态 | repo 只有 `README.md`、`AGENTS.md` 和 `docs/*.md`。 |
| 当前痛点 | 直接进入 `c01` 前，读者需要知道为什么当前没有 source scaffold，以及课程最终要补哪些能力。 |
| 本章产物 | 一篇 orientation chapter，说明 harness philosophy、能力地图、Forge 5 layers 和 `Chapter Contract`。 |
| 触达文件 | `README.md`、`docs/02-tutorial-roadmap.md`、`docs/tutorial/c00-orientation.md`。 |
| 验证命令 | `find README.md AGENTS.md docs -maxdepth 3 -type f | sort`、`test ! -e src && test ! -e package.json`、`git status --short`。 |
| 暂时不做 | 不建 `src/`，不建 `package.json`，不安装 dependencies，不接 LLM，不做 CLI，也不做 `Tool Runtime`。 |
| 下一章入口 | `c01 Minimal Real Loop` 会让 LLM 走通一次真实 `Tool Call` round trip。 |

## harness philosophy

课程从这一条线开始：

```text
user -> LLM -> tool_call -> tool_result -> LLM -> done
```

它看起来很小，但里面已经有 coding agent 的基本压力。模型会要求行动，harness 要决定能不能执行；工具会返回结果，下一轮模型不能什么都看；任务结束时，final answer 不能替代验证。

Forge Harness 的写法是：先让这个 loop 真的跑起来，再让痛点逼出机制。第二个 tool 让 routing 膨胀，才需要 `Tool Runtime`。高风险动作会改系统状态，才需要 `Permission Governance`。tool output 变多以后，才需要 `Context Projection`。长任务跑完以后说不清发生了什么，才需要 `Trace`、`RuntimeState` 和 `Verification`。

这里说的 `production-like` 不是 SaaS、dashboard、多租户、benchmark 或 UI。它指的是 advanced coding agent 的核心运行能力：能行动，能守边界，能管理上下文，能留下证据，能在任务变长后继续组织工作。

## 能力地图和 Forge 5 layers

Forge 5 layers 不是章节顺序，也不是目录清单。它们是读每一章时要问的五个问题。

| 核心能力 | Layer | 它问什么 | 后续会长出的例子 |
| --- | --- | --- | --- |
| 能行动 | `L1 Loop & Execution` | 模型输出怎样变成真实动作？ | `Tool Call`、`Tool Result`、shell/file tools、`Tool Runtime`。 |
| 能管边界 | `L2 Governance & Action Boundary` | 哪些动作可以执行，执行前要过什么边界？ | risk classification、approval、reviewable edits、worktree boundary。 |
| 能组织上下文 | `L3 Context & Knowledge` | 模型下一轮应该看到什么？ | `Observation`、`ContextProjection`、skills、memory、compaction。 |
| 能留证据并恢复 | `L4 State, Evidence & Reliability` | 运行中发生了什么，完成前怎样证明？ | `Session`、`TraceEvent`、`RuntimeState`、`Verification`、`Recovery`。 |
| 能处理长任务和扩展 | `L5 Coordination & Scale` | 任务变长、变多、变并行后怎么组织？ | hooks、todo/task state、background runs、subagents、MCP/plugin routing。 |

一章可以同时碰到多层。比如 file editing 是执行能力，也会碰到权限边界；worktree 是文件系统边界，也会影响恢复和并行工作。读章节时先问"这一章解决哪个痛点"，再看它落在哪几层。

## chapter contract

后面的 runnable chapter 都要有 `Chapter Contract`。它用来防止章节跑偏。

每章至少要说清楚：

- 上一章结束后已经有什么能力。
- 继续沿用上一章实现会卡在哪里。
- 本章新增哪个最小机制。
- 会碰哪些 source paths、commands 和 expected observations。
- 本章明确不做什么。
- 哪个限制会把课程推向下一章。

如果一章只说"这个概念很重要"，但没有指出哪个文件会改、运行什么 command、看到什么 output，它还不是 Forge 的教程章节。机制必须由痛点逼出来，验证也要能在当前 checkpoint 上看到。

## 检查当前 checkpoint

先看当前文件：

```bash
find README.md AGENTS.md docs -maxdepth 3 -type f | sort
```

你应该看到文档文件，包括这一章：

```text
AGENTS.md
README.md
docs/01-project-architecture.md
docs/02-tutorial-roadmap.md
docs/03-writing-style.md
docs/tutorial/c00-orientation.md
```

再确认 source scaffold 还没有回来：

```bash
test ! -e src && test ! -e package.json
```

这条命令没有输出，exit code 为 `0`，说明 `c00` 仍然是 docs-only checkpoint。

最后看 git 状态：

```bash
git status --short
```

在提交前，这里只应该出现本章和入口链接相关的文档改动，不应该出现 generated files、lockfile 或 runtime source。

## 下一章压力

`c00` 只把方向讲清楚。进入 `c01` 后，我们要让最小 loop 行动一次：模型发出一个 `Tool Call`，harness 执行一个工具，再把 `Tool Result` 交回模型。

这条线跑通以后，新的压力会马上出现。第二个工具会让 loop 里的 routing 开始变形，那就是 `c02 Tool Runtime` 的入口。
