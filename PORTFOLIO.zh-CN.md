# Forge Harness：招聘者入口

## Forge Harness 构建了什么

Forge Harness 是一个从零构建的 TypeScript coding-agent Runtime。项目从可运行的 model-tool loop 起步，通过可独立运行的 checkpoint 逐步加入受治理的工具执行、上下文管理、持久化运行证据、可信扩展、Worktree 隔离委派与多 Agent 协作。

教程路径保留了 22 个可运行 checkpoint。当前实现推进到 `c17c Coordination / Completion Protocol`。源码、测试、deterministic smoke、历史 curated snapshot 和 offline eval report 共同说明各项机制的行为边界。

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
3. **Offline eval 发现 regression。** 固定 compaction 场景检测到 ordered reads 从 `3` 降到 `2`。报告按 experiment identity 保留首个有效且可比较的 candidate，不为了绿色 verdict 重抽样。见 [offline eval guide](docs/offline-eval.md) 和 [regression report](docs/assets/evidence/offline-eval-regression-report.md)。

## c17c 集成结果

c17c 把多个层次围绕一个 edit task 串起来。teammate 先提交 plan，Leader 审批后，修改才会在独立 Worktree 中发生。Runtime 随后记录 source fingerprint，使用注册的 verification command 检查 source，创建 commit，并通过 Git receipt 完成集成。Candidate 提前到达时，`CompletionGate` 会返回缺失的 obligation；只有 team state 完整后，root verification 才会运行。

公开 live snapshot 记录了一次历史实际运行，不代表模型未来一定重复相同的行为，也不是当前 `HEAD` 的 fresh release evidence。详细状态转换见 [c17c evidence](docs/assets/evidence/c17c-team-completion.json) 和 [architecture overview](docs/architecture-overview.md)。

## 面试演示模式

前提：Linux、macOS 或 WSL2 上的 Node.js `>=20.19`、Git 和 Bash。不声明 native Windows shell 或 WSL1 支持，因为 Runtime 执行 Bash command。

约三分钟的屏幕演示使用：

```bash
npm ci
npm run demo:portfolio -- --explain
```

`npm ci` 安装依赖时可能通过网络访问 package registry。依赖安装完成后，`npm run demo:portfolio -- --explain` 不调用模型、不读取 `.env`、不访问网络，只使用临时 Git repository 和 Worktree。它运行与默认命令相同的三个独立 scene，并为每条 receipt 补充稳定、经过脱敏的 Runtime 边界说明：

```text
scene.action-boundary PASS deny-before-dispatch
scene.verification-recovery PASS recovery-before-final
scene.coordination-completion PASS receipt-before-ready
```

三个 scene 是确定性的机制检查，不是同一个 live Session。CI 运行默认的确定性命令，执行的 scene 与 `--explain` 相同。见 [demo source](src/portfolio/demo.ts) 和 [CI job](.github/workflows/ci.yml)。

如果具备 interactive TTY、Git、Bash、Node.js `>=20.19`、`OPENAI_API_KEY` 和 `OPENAI_MODEL`，可以运行 5 到 8 分钟的可选演示：

```bash
npm run demo:portfolio:live
```

Live launcher 会在系统临时目录现场生成一个不依赖外部 package 的 retry-policy repository，并先确认初始测试失败。测试覆盖首次调用成功、transient failure 重试后成功、`maxAttempts` 表示总执行次数，以及 permanent failure 立即停止。随后，launcher 使用 root Worktree 和根级 `npm test` verifier 启动现有 Forge CLI。终端会原样显示 Runtime transcript 和人工审批。

Prompt 把这次演示限制为一个 edit task 和一个同步 edit child。这样可以控制面试时长，也让 submission、verification 和 Git receipt 都有明确的 source。实现改动必须保持在 `src/**`。Prompt 还写明阶段顺序：child 返回后先记录 evidence，再用返回的 `childSessionId` 提交结果；submission 成功后才运行 `npm test`，verification 通过后才能 integration。具体使用哪个 tool、遇到安全拒绝后如何恢复，仍由模型决定。task 文案、读取哪些文件、实现方式和编辑次数也不固定。

报告 PASS 前，validator 要求最终恰好有一次成功的 task verification。在此之前，即使 verification call 失败，也只有 Trace 同时记录 TaskGraph 为 `healthy`、错误码为 `invalid_input` 时才可接受。这表示 Runtime 在 verifier 启动前就拒绝了请求。只要 verifier 真正运行后失败，或出现 source drift、异常 approval evidence、最终成功后的额外 verification call，Live 都会失败。Validator 还会把持久化的 submission 和 Git receipt 与最终 root Worktree 对账。Worktree 必须 clean；receipt 的 `targetBefore` 必须等于记录的 Worktree base；root `HEAD` 必须等于 `integratedCommit`；`targetBefore..HEAD` 的完整路径集合必须等于 child submission 的 `changedFiles`。固定拓扑只是演示边界，不代表 Runtime 只能处理一个任务。

Launcher 在分配 fixture 前启动 10 分钟 timer。fixture 初始化、初始测试、Forge child 和最终 evidence validation 共用一个 `AbortSignal`。这是协作式取消，不是硬性的 wall-clock deadline：遇到无法中断的操作时，launcher 会等它返回，再进入 cleanup。分配出的 fixture 路径只归外层 launcher 管理；无论前面如何结束，都只删除一次，cleanup 不接收取消 signal。timeout 或人工 `SIGINT`/`SIGTERM` 谁先到，谁就确定取消原因，后续信号不会改写结果。child 正在运行时，timeout 先发送 `SIGTERM`，人工信号则原样转发；两秒后仍未退出，launcher 再发送一次 `SIGKILL`。进入 cleanup 前会停止 10 分钟 timer，但 signal handler 会保留到 cleanup 完成；此时第一次收到人工信号，仍会阻止 PASS。若删除失败，`cleanup_failed` 优先于此前结果。这只是一次结果可变的模型运行观察，不是 benchmark、CI 检查或可复用证据。Live 失败时应立刻回到确定性 walkthrough，不在面试现场排查。

## 证据与边界

[Evidence Index](docs/evidence-index.md) 把每项主张对应到源码、focused tests、deterministic smoke、可选 live evidence 和明确限制。[Engineering case study](docs/engineering-case-study.md) 按演进顺序说明问题和设计取舍。

Fresh release claim 采用另一条经过 preregistration、raw bundle 封存和 SHA-256 复验的流程，详见 [Release evidence runbook](docs/release-evidence.md)。只有重新下载的 public/private Release assets 能通过 `npm run evidence -- verify`，对应版本才算完成闭环。

当前 c17c Runtime 不声称具备 OS-level sandbox、crash-safe resume 或 reconciliation、分布式调度、跨 run durable queue、deterministic model reasoning、统计显著性评估或 hosted Web UI。已批准的 extension 仍在当前进程和 host permissions 下运行。
