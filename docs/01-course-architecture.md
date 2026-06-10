# 课程架构

Forge 的课程有两个视角。

第一个视角是 growth path：从一圈 loop 开始，按问题一步步长出 harness。

第二个视角是 architecture layers：最终系统由哪些关注点组成。

这两个视角不要混在一起。章节顺序负责学习路径，架构层负责定位机制。

## 五层模型

Forge 用五层解释最终 harness。

```text
L1 Loop & Execution
L2 Governance & Action Boundary
L3 Context & Knowledge
L4 State, Evidence & Reliability
L5 Coordination & Scale
```

### L1 Loop & Execution

这一层回答：agent 怎么行动。

内容包括 `Agent Loop`、model call、tool call、tool result、tool dispatcher、shell execution、file tools、MCP adapter。

最早的实现会很直接：一个 LLM，请求一个 `bash` tool，再把结果交回给模型。

### L2 Governance & Action Boundary

这一层回答：哪些动作可以执行，执行前要过什么边界。

内容包括 risk classification、permission policy、approval、deny rules、safe executor、reviewable file editing、worktree boundary。

`bash` 能做很多事，所以它不能长期只靠模型自觉。

### L3 Context & Knowledge

这一层回答：模型下一轮应该看到什么。

内容包括 message history、`Observation`、`ContextProjection`、system prompt assembly、memory、skills、context compaction。

直接把所有 raw output 塞回模型可以跑，但很快会变吵。

### L4 State, Evidence & Reliability

这一层回答：运行中发生了什么，现在处于什么状态，完成前怎样证明。

内容包括 `Session`、`TraceEvent`、`RuntimeState`、checks、failure summary、recovery loop。

Console output 只能看当下。一个可靠 harness 需要能 inspect、resume、replay，也需要在完成前验证。

### L5 Coordination & Scale

这一层回答：任务变长、变多、变并行后怎么组织。

内容包括 hooks、todo/task state、background tasks、cron、child sessions、subagents、team protocols、comprehensive agent turn。

这一层不能太早出现。它依赖前四层已经有稳定接口。

## 章节如何生长

每章用同一个节奏：

```text
problem
  -> naive code or pain
  -> mechanism
  -> runnable milestone
  -> next pressure
```

例如 `Tool Runtime` 不应该一上来被定义成架构组件。它应该从这样的代码变坏开始：

```ts
if (toolCall.name === "bash") {
  return runBash(JSON.parse(toolCall.arguments));
}

if (toolCall.name === "read_file") {
  return readFile(JSON.parse(toolCall.arguments));
}

return `unknown tool: ${toolCall.name}`;
```

第二个工具出现后，loop 开始知道每个工具的 schema、参数、错误和输出格式。这个痛点才需要 `Tool Runtime`。

## Part 1 和 Part 2

`Part 1: Core Harness` 只处理单 agent 基础 runtime。终点是一个能行动、受治理、能投影上下文、能记录状态、能验证结果的 harness。

`Part 2: Scale & Extensions` 在 core 稳定后再加入扩展能力。它不是插件清单，而是把任务长度、并发、外部工具和协作边界拉进来。

## c00 的任务

`c00` 不写代码。

它负责把三件事讲清楚：

- agent 需要 harness，不只是 LLM 加 tools。
- Forge 的五层最终长什么样。
- 课程会按问题生长，而不是先讲完整平台。
