# c00-overview: 先看一圈 Agent Loop

这一章先不写代码。

我们先把 coding agent 最小的一圈看清楚：用户提出任务，LLM 判断下一步要不要调用工具，harness 执行工具，再把工具结果交回给 LLM。

最小数据流是这样：

```text
user -> LLM -> tool_use -> bash -> tool_result -> LLM -> done
```

后面的 `c01` 会把这条数据流写成一个真实运行的 TypeScript loop。现在先把几个基础概念放稳。

## Agent Loop 是什么

`Agent Loop` 是 coding agent 反复执行的一圈动作。

你可以先这样理解：

```text
用户给一个任务
  -> LLM 生成下一步
  -> 如果下一步需要工具，harness 执行工具
  -> harness 把 Tool Result 放回上下文
  -> LLM 继续判断下一步
  -> 直到 LLM 不再请求工具
```

这里有两个重点。

第一，LLM 不只是生成最终答案。它也会生成 `Tool Call`，比如请求执行一个 shell command。

第二，工具不是由 LLM 自己执行。LLM 只提出意图，harness 负责真正执行工具，并把 `Tool Result` 交回给模型。

这就是 agent harness 开始出现的地方。

## Agent Harness 做什么

`agent harness` 是包在 LLM 外面的一圈 runtime。

它至少要做几件事：

- 保存 message history。
- 调用 LLM。
- 识别模型返回的 `Tool Call`。
- 执行对应工具。
- 把 `Tool Result` 放回 message history。
- 判断 loop 是否继续。

Stage 1 只会实现这条最小 execution path：

```text
message history
  -> LLM
  -> Tool Call
  -> bash
  -> Tool Result
  -> message history
```

先不要急着加入完整架构。只要这一圈能跑起来，你就已经看到 coding agent 的核心结构。

## Forge Harness 要做什么

Forge Harness 是一个用 TypeScript 从零实现 coding agent harness 的教程项目。

它有两条产物：

- runnable code：每个 tutorial milestone 都应该能运行。
- tutorial docs：每一章解释当前代码为什么需要下一个机制。

这个项目最后会逐渐长出这些部分：

```text
Agent Loop
+ Tool Runtime
+ Context Projection
+ Permission Governance
+ Session / Trace Persistence
+ Runtime State Model
+ Verification / Recovery
```

第一步先写一个真实的 loop，然后观察它哪里不够用。

教程节奏会保持这样：

```text
direct implementation
  -> exposed pain point
  -> harness mechanism
  -> stronger implementation
```

每个机制都要从上一章的痛点里长出来。

## Stage 1 会先写什么

下一章会实现一个最小真实 LLM loop：

```text
User Task
  ↓
Messages
  ↓
LLM
  ↓
Tool Call
  ↓
bash
  ↓
Tool Result
  ↓
Messages
  ↓
LLM
  ↓
Final Answer
```

实现边界会很窄：

- CLI 接收用户任务。
- 调用一个真实 LLM。
- 提供一个简单 `bash` tool。
- 保存 messages。
- 检测模型返回的 tool call。
- 执行工具。
- 把 tool result 追加回 messages。
- 当模型不再请求工具时停止。

暂时不做这些：

- provider abstraction。
- 完整 `Tool Runtime`。
- 完整 `Permission Governance`。
- `Session` store。
- `Trace` persistence。
- `Context Projection`。
- recovery loop。

它们会在直接 loop 暴露问题之后再加入。

## 后续机制从哪里来

直接 loop 很快会让问题变具体。

`bash` 太强大。它能读文件、改文件、删文件，也可能执行危险命令。这个问题会推动 `Permission Governance`。

一个 inline bash function 不会长期可维护。工具一多，就需要 schema、metadata、dispatcher 和 result protocol。这个问题会推动 `Tool Runtime`。

raw tool output 会变得很吵。命令输出可能很长，直接塞回 messages 会影响下一轮判断。这个问题会推动 `Observation` 和 `Context Projection`。

console output 只能看当下。运行结束后，如果你想 inspect、resume、fork 或 replay，就需要更稳定的记录。这个问题会推动 `Trace` 和 `Session`。

模型停止请求工具，不等于 coding task 已经完成。后面要用 tests、type-check、build 或 acceptance checks 来确认结果。这个问题会推动 `Verification / Recovery`。

## 进入 c01 前

进入 `c01-minimal-real-llm-loop` 前，先带走这几件事：

- `Agent Loop` 是用户任务、LLM、Tool Call、工具执行、Tool Result 之间的循环。
- `agent harness` 负责执行 LLM 的工具意图，并把结果交回上下文。
- Stage 1 会先实现一条真实但很窄的 execution path。
- `bash` tool 会先保持简单，因为它要暴露后续问题。
- 后续的 `Tool Runtime`、`Permission Governance`、`Context Projection`、`Trace`、`Session` 和 `Verification` 都要从这些问题里长出来。

下一章开始写代码。
