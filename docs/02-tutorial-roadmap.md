# 教程路线

Forge 的教程按章节推进。每章都是一个 runnable milestone。

架构层用来定位章节，章节顺序用来解释生长过程。

## c00: orientation

`c00` 是总览章，不写代码。

它介绍：

- 为什么 agent 需要 harness。
- Forge 的五层模型。
- 每章的 problem-arc 写法。
- 什么叫 production-like。

## Part 1: Core Harness

### c01 Minimal Real Loop

Layer: `L1 Loop & Execution`

问题：LLM 只能回答，不能行动。

方案：实现最小真实 loop。CLI 接收任务，调用 LLM，模型请求一个本地 tool，harness 执行后把 result 放回下一轮 input。

章节内可以顺手展示 `transcript != model input history`。这不是独立机制，只是帮助你看清 loop 状态。

### c02 Tool Runtime

Layer: `L1 Loop & Execution`

问题：第二个工具出现后，Agent Loop 手写 routing 会膨胀。

方案：引入 tool adapter、tool definition collection、registry、dispatcher、unknown tool fallback、统一 result/error protocol。

### c03 Permission Governance

Layer: `L2 Governance & Action Boundary`

问题：工具调用会产生 side effects。`bash` 尤其危险。

方案：在执行前加入 risk classification、permission decision、allow/deny/approval model 和 safe executor 约束。

### c04 Reviewable File Editing

Layer: `L1 Loop & Execution` + `L2 Governance & Action Boundary`

问题：coding agent 需要改文件，但让 `bash` 随便改不利于 review、trace 和 recovery。

方案：先做 Pi-style exact edit 和 write tool，返回 diff-like result。后面再升级 `ChangeSet` 或 apply-patch style editing。

### c05 Context Projection

Layer: `L3 Context & Knowledge`

问题：raw history、tool output 和失败输出会挤满下一轮 input。

方案：引入 `Observation` 和 `ContextProjection`，明确模型下一轮应该看到什么。

### c06 Session / Trace

Layer: `L4 State, Evidence & Reliability`

问题：运行结束后无法 inspect、resume、fork 或 replay。

方案：加入 `Session` metadata 和 JSONL `TraceEvent`。

### c07 Runtime State Model

Layer: `L4 State, Evidence & Reliability`

问题：Trace 记录过去，但 harness 还需要当前决策视图。

方案：引入 `RuntimeState`。它是运行时投影，不是集中式 `src/state/` god module。

### c08 Verification / Recovery

Layer: `L4 State, Evidence & Reliability`

问题：模型给出 final answer 不等于任务完成。

方案：加入 checks、failure summary、repair loop、retry limit 和 stop condition。

## Part 2: Scale & Extensions

### c09 Hooks

Layer: `L5 Coordination & Scale` + `L4 State, Evidence & Reliability`

问题：生命周期扩展点不该散落在 core loop 里。

方案：在稳定 event points 上挂 hooks。

### c10 Task / Todo

Layer: `L5 Coordination & Scale` + `L4 State, Evidence & Reliability`

问题：复杂任务需要可见计划、状态和 acceptance。

方案：加入 task/todo state，并把它接入 trace、runtime state 和 context projection。

### c11 System Prompt / Skills / Memory

Layer: `L3 Context & Knowledge`

问题：可复用 instruction、项目知识和操作套路不能每次手写塞进 prompt。

方案：把 system prompt assembly、skills 和 memory 放进 context pipeline。

### c12 Context Compaction

Layer: `L3 Context & Knowledge` + `L4 State, Evidence & Reliability`

问题：长 session 会超过 context budget。

方案：加入 compaction policy，保留任务状态、关键 observations 和未解决问题。

### c13 Background / Cron

Layer: `L5 Coordination & Scale` + `L4 State, Evidence & Reliability`

问题：有些任务需要稍后继续、后台运行或定时检查。

方案：把 session persistence 扩展到 scheduled/background runs。

### c14 Child Sessions / Subagents

Layer: `L5 Coordination & Scale` + `L3 Context & Knowledge` + `L4 State, Evidence & Reliability`

问题：独立子任务会挤占主上下文。

方案：使用 child session 隔离上下文，用 summary handoff 回到主任务。

### c15 Worktree Isolation

Layer: `L2 Governance & Action Boundary` + `L4 State, Evidence & Reliability` + `L5 Coordination & Scale`

问题：并行或高风险修改会污染主工作区。

方案：把 session 和 worktree 绑定，合并前必须 review 和 verify。

### c16 MCP / Plugin Routing

Layer: `L1 Loop & Execution` + `L2 Governance & Action Boundary`

问题：内置 tools 不够，外部工具也要走统一治理路径。

方案：通过 Tool Runtime 接入 MCP/plugin tools，并复用 permission 和 result protocol。

### c17 Team Protocols / Comprehensive Harness

Layer: all layers

问题：机制多了以后，系统必须回到一条可解释的 agent turn。

方案：用一个 capstone run 串起 tools、permission、context、trace、state、verification、subagents 和 team handoff。

## Branch 和 tag

`main` 保留最新集成课程。

`tutorial/cNN-*` branch 保留对应章节的 runnable checkpoint。

`tutorial-cNN-*` tag 是冻结 checkpoint。不要移动已发布 tag。如果要修旧 checkpoint，更新对应 branch，再创建 `-v2` tag。

Pre-reorg branch 已归档，不写进新教程正文。

## Chapter contract

每个 runnable chapter 需要一份小 contract，可以放在章节末尾或 roadmap 表格里。

Contract 至少写：

- branch name
- source paths
- commands
- doc invariants
- verification steps

如果文档和实现不一致，先判断改动属于 evergreen docs、milestone docs 还是 shared fix。共享修复从最早受影响 branch 开始，再 cherry-pick 到后续 branches 和 `main`。

## forge-tutorial-maintenance

后续创建一个本地 skill：`forge-tutorial-maintenance`。

触发场景：

- tutorial branch changes
- chapter contract checks
- doc/implementation consistency checks
- backport 或 forward-port decisions
- tag readiness checks

第一版只需要 workflow。等检查稳定后，再补脚本。
