# 面试 cue cards（中文）

这是口述提示，不是第二份 case study。先根据时间使用 30 秒或 90 秒项目总览，再按追问选择一个故事。每条深入回答控制在 2 到 3 分钟，事实回指 canonical evidence。

## 项目总览：30 秒

节奏：Forge Harness 是一个从零构建的 TypeScript coding-agent Runtime。项目从可运行的 model-tool loop 起步，将工具治理、上下文管理、持久化运行证据、隔离委派、可信扩展和协作协议逐步实现为可独立运行的 checkpoint。

证据：[项目架构](01-project-architecture.md)、[招聘者入口](../PORTFOLIO.zh-CN.md)。

## 项目总览：90 秒

节奏：用五层解释完整 Runtime。L1 把模型输出变成工具执行，L2 管理 action boundary，L3 控制下一次决策看到的 context，L4 保存状态与证据，L5 组织后台工作、隔离 session 和团队完成协议。c17c 把这些职责围绕 plan approval、Worktree 修改、verification、Git integration 和 completion gate 串起来。

取舍：Runtime 保持本地、可检查。当前边界不包含 OS sandbox、crash-safe resume 或 distributed coordination。

证据：[架构总览](architecture-overview.md)、[engineering case study](engineering-case-study.md)。

## c17c 集成故事

节奏：teammate 先提交 edit plan，Leader 审批后才在 Worktree 中修改。Runtime 随后记录 source fingerprint，执行注册的 verification command，创建 commit，并通过 Git receipt 完成集成。Candidate 提前到达时，`CompletionGate` 会保持 incomplete，直到剩余 task 和 team obligations 收敛。

取舍：Verification 通过只代表 edit 已提交，不能代替 integration evidence。公开 live snapshot 只记录一次模型实跑，不保证未来模型一定遵守相同顺序。

证据：[c17c live snapshot](assets/evidence/c17c-team-completion.json)、[c17c demo](demos/c17c-team-completion.md)、`npm run smoke:c17c-capstone`。

追问：Worktree 隔离文件改动，不隔离进程、credentials、network access 或 host permissions。

## Permission before dispatch

节奏：Model 提出 write，policy 先分类，必要时再 approval，之后才允许 owning handler dispatch。Decision 和 result 进入统一的 ToolResult 与 Trace 路径。

取舍：In-process policy 可检查、可测试，但不是 OS sandbox。

证据：`src/governance/defaultPolicy.ts`、`test/governance/defaultPolicy.test.ts`、`npm run demo:portfolio` scene 1。

追问：Approved plugin 仍在当前进程运行，并经过 Forge 的 tool、result 和 Trace 路径。

## Context 与 Trace

节奏：Raw history 变长后，bounded observation 和 compaction 为下一轮模型提供 decision view，append-only Trace 保存有序的 Runtime 事实。

取舍：Compaction 是有损的。Trace 是 durable evidence，不是 model context。

证据：`src/context/compaction.ts`、`src/runtime/trace.ts`、`test/context/compaction.test.ts`。

追问：c17c 不提供 crash-safe replay 或 resume，这是明确的边界。

## Offline eval 发现 regression

节奏：五个固定场景组成 13-attempt contract。Compaction 场景的 ordered-read 从 `3/3` 降到 `2/3`。报告按 identity 保留首个有效且可比较的 candidate，不重新抽样。

取舍：有效的红色结果本身就是证据。为了绿色结果重抽样会破坏可比性。

证据：[offline eval](offline-eval.md)、[regression report](assets/evidence/offline-eval-regression-report.md)、`src/eval/`。

追问：Eval 不证明通用 coding 能力、统计显著性、生产流量或 deterministic model reasoning。
