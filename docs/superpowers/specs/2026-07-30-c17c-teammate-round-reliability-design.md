# c17c Teammate 轮次可靠性设计

## 问题

c17c 实跑命令把两名长期 teammate 的 `maxToolRounds` 固定为 `4`。这个预算只够覆盖理想调用序列，没有给模型的额外协调调用或一次失败重试留下空间。

本次失败暴露了两个具体问题：

- `protocol-researcher` 在任务尚未成功分配时开始执行，先后产生一次失败的 evidence 调用和一次补充 claim，最终没有预算执行 `submit_result`。
- `protocol-editor` 在 Leader 已明确禁止的情况下仍先调用 `todo`，第四轮完成 `submit_plan` 后没有剩余轮次返回最终响应。

Teammate 会话失败后，当前协议会把它拥有的活动任务标记为 `owner_failed` 并冻结为 `blocked`。`teammate_rejoin` 只恢复会话，不恢复任务，所以 Leader 后续无法通过继续轮询或再次审批完成任务。

## 目标

提高 c17c 实跑演示对轻微模型偏差的容忍度，同时保持当前章节的任务失败和恢复边界不变。

成功标准：

- 两名长期 teammate 的单次邮箱流程有足够预算完成一次额外调用或失败重试。
- Teammate 能明确区分 TaskGraph 协调与本地 `todo` 规划，默认不为短协议流程创建 todo。
- Leader 在调用 `teammate_start` 时知道初始 `message` 会立即触发执行，不能依赖尚未建立的任务或分配状态。
- c17c 教程中的实跑命令明确要求先启动 teammate，再创建和分配任务，最后发送执行消息。
- 同步 research child 继续使用 `maxToolRounds=4`，因为其流程只有 evidence 调用和最终响应。

## 方案

### 轮次预算

把 c17c 实跑命令中 `protocol-researcher` 和 `protocol-editor` 的 `maxToolRounds` 从 `4` 调整为 `6`。

不修改全局 `DEFAULT_MAX_TOOL_ROUNDS`。Root 已有 32 轮预算，本次失败发生在 teammate 的显式局部预算内，提高 root 默认值不能解决问题。

不改变 minimal loop 的轮次计算方式。本章只修正演示协议的预算配置，避免扩大运行时语义变更范围。

### Teammate 提示纪律

在长期 teammate 的基础提示中加入以下规则：

- TaskGraph 是跨 actor 的协调状态。
- 除非 Leader 的当前消息显式要求本地 todo，否则不要调用 `todo`。
- 对短邮箱协议直接执行要求的 TaskGraph 调用并返回结果。

这条规则不会删除 `todo` 工具。复杂任务仍可由 Leader 显式要求 teammate 使用本地规划。

### `teammate_start` 工具说明

更新工具定义中 `message` 与 `maxToolRounds` 的说明：

- `message` 会在 teammate 启动后立即作为首个邮箱批次执行。
- 如果首批工作依赖任务，调用方必须先保证任务已经存在且可以由 teammate 获取。
- `maxToolRounds` 是每个邮箱批次的上限；包含 claim、检查、证据和提交的协议应预留重试与最终响应空间。

这里只增强模型可见的契约，不改变工具参数和返回结构。

### c17c 实跑顺序

教程命令按以下阶段表达：

1. 启动两名不带 `taskId` 的 teammate，并让首个消息只要求待命。
2. 创建三个任务。
3. 把 `task_001` 分配给 Leader，把 `task_002` 分配给已存在的 `protocol-researcher`。
4. 分别向 researcher 和 editor 发送执行消息。
5. 继续现有 evidence、plan review、verification、integration 和 shutdown 协议。

这样可以避免向尚未注册的 teammate 分配任务，也能避免首个启动消息在任务准备完成前触发业务调用。

## 不在本次范围内

- 不让 `teammate_rejoin` 自动重新打开 `blocked` 任务。
- 不新增 unblock、retry task 或 ownership transfer 协议。
- 不修改 `owner_failed -> blocked`。
- 不增加 minimal loop 的 final-only grace round。
- 不修改其他 tutorial 章节。

## 测试

增加或调整测试以覆盖：

- 长期 teammate 基础提示包含默认不使用 `todo` 的规则。
- `teammate_start` 工具定义说明初始消息立即执行，并解释合理的轮次预算。
- c17c 教程命令使用 `maxToolRounds=6`，同步 child 仍使用 `4`，且文本顺序先启动 teammate、再分配和发送执行消息。

完成后运行：

```bash
npm run test
npm run typecheck
npm run build
npm run smoke:c17c-capstone
```

实跑命令依赖模型和交互审批，不作为确定性单元测试的一部分；它仍用于章节的人工 smoke 验证。
