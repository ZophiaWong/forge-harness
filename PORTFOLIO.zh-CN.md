# Forge Harness：招聘者入口

## Forge Harness 构建了什么

Forge Harness 是一个从零构建的 TypeScript coding-agent Runtime。项目从可运行的 model-tool loop 起步，通过可独立运行的 checkpoint 逐步加入受治理的工具执行、上下文管理、持久化运行证据、可信扩展、Worktree 隔离委派与多 Agent 协作。

教程路径保留了 22 个可运行 checkpoint。当前实现推进到 `c17c Coordination / Completion Protocol`。源码、测试、deterministic smoke、经过整理的 live evidence 和 offline eval report 共同说明各项机制的行为边界。

## Runtime 负责哪些机制

| 层 | Runtime 职责 |
| --- | --- |
| `L1 Loop & Execution` | 模型轮次、模型请求、tool call、tool result 和最终回答流程。 |
| `L2 Governance & Action Boundary` | 权限判断、审批、路径边界和扩展信任。 |
| `L3 Context & Knowledge` | Prompt assembly、memory、skills、observations、mailbox message 和 compaction。 |
| `L4 State, Evidence & Reliability` | Session metadata、Trace events、RuntimeState、verification、receipts 和 eval reports。 |
| `L5 Coordination & Scale` | Background work、child Sessions、Worktrees、TaskGraph、teammates 和 CompletionGate。 |

## 代表性工程决策

下面是便于面试展开的选择性入口，不是完整 capability 清单。

1. **Permission before dispatch。** 一个格式正确的 write 仍然要先经过明确的 `allow`、`ask` 或 `deny` 决策，handler 才能运行。Deterministic demo 检查被拒绝请求的 handler dispatch count 仍为零。
2. **Context 与 Trace 分离。** 下一次模型决策使用有界 observation 和有损 compaction summary。append-only Trace 保存有序的 Runtime 事实。Prompt projection 不是历史账本。
3. **Offline eval 发现 regression。** 固定 compaction 场景检测到 ordered reads 从 `3` 降到 `2`。Trace 证据把问题定位到 repeated-compaction loss。有效的红色 candidate 按 identity 冻结，没有为了绿色 verdict 重抽样。见 [offline eval guide](docs/offline-eval.md) 和 [regression report](docs/assets/evidence/offline-eval-regression-report.md)。

## c17c 集成结果

c17c 把多个层次围绕一个 edit task 串起来。teammate 先提交 plan，Leader 审批后，修改才会在独立 Worktree 中发生。Runtime 随后记录 source fingerprint，使用注册的 verification command 检查 source，创建 commit，并通过 Git receipt 完成集成。Candidate 提前到达时，`CompletionGate` 会返回缺失的 obligation；只有 team state 完整后，root verification 才会运行。

公开 live snapshot 记录了一次实际运行，不代表模型未来一定重复相同的行为。详细状态转换见 [c17c evidence](docs/assets/evidence/c17c-team-completion.json) 和 [architecture overview](docs/architecture-overview.md)。

## 面试演示模式

前提：Linux、macOS 或 WSL2 上的 Node.js `>=20.19`、Git 和 Bash。不声明 native Windows shell 或 WSL1 支持，因为 Runtime 执行 Bash command。

约三分钟的屏幕演示使用：

```bash
npm ci
npm run demo:portfolio -- --explain
```

这条确定性命令不调用模型、不读取 `.env`，只使用临时 Git repository 和 Worktree。它运行与默认命令相同的三个独立 scene，并为每条 receipt 补充稳定、经过脱敏的 Runtime 边界说明：

```text
scene.action-boundary PASS deny-before-dispatch
scene.verification-recovery PASS recovery-before-final
scene.coordination-completion PASS receipt-before-ready
```

三个 scene 是确定性的机制检查，不是同一个 live Session。这也是 CI 使用的路径。见 [demo source](src/portfolio/demo.ts) 和 [CI job](.github/workflows/ci.yml)。

如果具备 interactive TTY、Git、Bash、Node.js `>=20.19`、`OPENAI_API_KEY` 和 `OPENAI_MODEL`，可以把 `npm run demo:portfolio:live` 作为可选的 5 到 8 分钟延伸。它使用一次性的临时 fixture，并需要手动 approval。真实模型输出每次都可能不同，因此它不是 CI 检查，也不是可复用证据。Live 运行失败时，立刻回到确定性 walkthrough，不要在面试中排查。

## 证据与边界

[Evidence Index](docs/evidence-index.md) 把每项主张对应到源码、focused tests、deterministic smoke、可选 live evidence 和明确限制。[Engineering case study](docs/engineering-case-study.md) 按演进顺序说明问题和设计取舍。

当前 c17c Runtime 不声称具备 OS-level sandbox、crash-safe resume 或 reconciliation、分布式调度、跨 run durable queue、deterministic model reasoning、统计显著性评估或 hosted Web UI。已批准的 extension 仍在当前进程和 host permissions 下运行。
