# Agent Runtime Design Studies

这组文章研究一个具体问题：成熟 coding agent runtime 如何持有控制流、动作边界、上下文、连续性、协作与治理责任，而 Forge Harness 为什么只采用其中一部分机制。

研究对象固定为三个本地源码快照：Claude Code 的本地研究副本、Pi Agent 和 Forge Harness `c17c`。版本与来源见 [SOURCES](SOURCES.md)，证据选择和置信度规则见 [METHODOLOGY](METHODOLOGY.md)。

这些文章不是 feature checklist。每篇都沿同一条分析路径展开：

```text
runtime problem
→ responsibility owner
→ data and control flow
→ invariant
→ failure semantics
→ design trade-off
→ Forge decision
```

阅读时需要一直区分四种状态：

| 对象 | 回答的问题 |
| --- | --- |
| Session History | 过去发生过什么？ |
| Runtime State | 当前执行处于什么状态？ |
| Model Context | 下一轮模型能看到什么？ |
| Workspace State | 文件、Git、进程和外部副作用现在是什么状态？ |

也需要区分三类保证：`Mechanism` 是代码提供的能力，`Policy` 是系统选择的规则，`Product behavior` 是用户最终观察到的表现。

## 研究目录

- [Agent loop 与 completion](01-agent-loop-and-completion.md)：run 何时才算真正完成。
- [Tool Runtime 与 Action Boundary](02-tool-runtime-and-action-boundary.md)：tool call 如何越过确定性动作边界。
- [Context 构造与 Compaction](03-context-construction-and-compaction.md)：系统信息如何投影成下一轮 model context。
- [Session 持久化与分支](04-session-persistence-and-branching.md)：session history、resume 与 runtime recovery 的边界。
- [Delegation 与 Coordination](05-delegation-and-coordination.md)：child、worker、teammate 与 team 的不同协作协议。
- [Extensibility governance 与 trust](06-extensibility-governance-and-trust.md)：配置何时变成以用户权限执行的代码。
- [Agent Runtime Design Synthesis](07-agent-runtime-design-synthesis.md)：统一 responsibility map、设计张力与 Forge 设计谱系。

研究过程的当前状态见 [STATUS](STATUS.md)，逐条证据与实验索引见 [EVIDENCE_LEDGER](EVIDENCE_LEDGER.md)。DS02 的可复现 fixture、专用 config 与运行输出保存在 [experiments](experiments/README.md)，不会进入项目的普通 test suite。

第一次阅读可以先看 synthesis，再按问题回到专题。要理解单 agent 的主链，依次阅读 `01 -> 02 -> 03`；要理解跨进程连续性与多 agent 交付，阅读 `04 -> 05`；要审查 plugin、MCP、worktree、permission 与 sandbox 的边界，阅读 `06`。

## 范围边界

本研究解释 `c17c` 的当前实现，不实现 `c18`。durable recovery、attempt identity、idempotency、reconciliation 与 event replay 只作为 production-hardening 研究问题出现。研究结果不证明大规模线上流量、多租户运营、完整 secure sandbox 或 durable workflow engine。
