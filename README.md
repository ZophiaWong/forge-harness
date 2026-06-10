# Forge Harness

Forge Harness 是一个从零实现 coding agent harness 的教程项目。

它不从完整平台开始。课程先写一圈能跑的 agent loop：

```text
user -> LLM -> tool_call -> tool_result -> LLM -> done
```

然后把这圈 loop 里暴露的问题一个个拉出来：工具怎么接入，动作怎么治理，模型该看到什么，运行过程怎么记录，任务完成前怎么验证。

这个项目的目标不是复刻 Claude Code、Codex 或某个 agent framework。它要做的是把 coding agent runtime 的关键机制写出来，并把实现过程整理成可运行的教程。

## 当前状态

课程线已重置到干净起点。

当前分支只保留项目定位和课程架构文档。之前的实验实现和教程分支已经归档到 `archive/pre-reorg/*`，不会出现在新课程正文里。

后续会按章节重新加入源码、测试和 tutorial milestone。

## 课程结构

新课程分两部分：

- `Part 1: Core Harness`
- `Part 2: Scale & Extensions`

`Core Harness` 先把单 agent 的基础 runtime 打稳：loop、tools、permission、context、trace、state、verification。

`Scale & Extensions` 再接上更长任务和更大边界：hooks、tasks、skills、compaction、background work、subagents、worktrees、MCP 和 team protocols。

完整路线见 [docs/02-tutorial-roadmap.md](docs/02-tutorial-roadmap.md)。

## 五层架构

Forge 用五层来描述最终 harness：

```text
L1 Loop & Execution
L2 Governance & Action Boundary
L3 Context & Knowledge
L4 State, Evidence & Reliability
L5 Coordination & Scale
```

这五层不是章节顺序。章节顺序仍然按问题生长：先写到不舒服，再引入机制。

更多说明见 [docs/01-course-architecture.md](docs/01-course-architecture.md)。

## 写作原则

教程文档使用中文。技术词保留 English，例如 `Agent Loop`、`Tool Runtime`、`Context Projection`、`RuntimeState`。

每章都应该回答四件事：

- 当前代码哪里不够用。
- 天真的实现会怎样变坏。
- 新机制解决哪个具体问题。
- 这一章完成后能运行什么。

写法细节见 [docs/03-writing-style.md](docs/03-writing-style.md)。

## 给 coding agents 的说明

在这个仓库工作前先读 [AGENTS.md](AGENTS.md)。

不要直接实现完整 agent runtime。每次只做当前章节需要的最小机制，并保留可运行 checkpoint。
