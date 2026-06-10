# 项目定位

Forge Harness 是一个 tutorial-driven coding agent harness 项目。

它的重点不是展示 API 用法，也不是复刻现成工具。它要把一个 coding agent 周围的 runtime 机制拆开：模型怎样请求工具，工具怎样执行，动作怎样受治理，上下文怎样进入下一轮，运行过程怎样留下证据，最后怎样证明任务真的完成。

## Mission

从最小可运行 loop 开始，逐步实现一个 production-like single-agent harness。

这里的 production-like 不是 SaaS、dashboard、多租户或企业权限系统。它指的是这些性质：

- 行动受治理。
- 运行可观察。
- 状态可恢复。
- 结果可验证。
- 扩展有边界。

## 起点

第一条数据流很小：

```text
user -> LLM -> tool_call -> tool_result -> LLM -> done
```

这一圈先真实跑起来。后面的机制都从它的问题里长出来。

## 非目标

第一轮课程不做这些：

- 完整 agent platform。
- 多 agent 团队系统。
- MCP 平台。
- dashboard。
- benchmark suite。
- provider abstraction。
- framework-first orchestration。
- production SaaS structure。

这些概念可以在后半段出现，但不能挤掉 `Core Harness`。

## 学习目标

读完并跑完课程后，你应该能说清楚：

- `Agent Loop` 为什么不是一次 model call。
- `Tool Runtime` 为什么不能一直写在 loop 里。
- `Permission Governance` 为什么要在执行前出现。
- `Context Projection` 为什么比堆 message history 更可靠。
- `Session`、`Trace`、`RuntimeState` 分别回答什么问题。
- `Verification / Recovery` 为什么是 coding agent 的完成条件。

## 工程目标

源码是主要产物。文档解释为什么这样写。

每个 runnable chapter 都要有边界：这章写了什么，暂时不写什么，下一章为什么需要新机制。

不要提前堆抽象。抽象必须由上一章的痛点逼出来。
