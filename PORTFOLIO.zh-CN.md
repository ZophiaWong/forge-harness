# Forge Harness — 招聘者入口

Forge Harness 是一个从零实现的 TypeScript coding-agent Runtime。核心判断是：模型说“done”只是 candidate，不是完成证明。

## 为什么不能直接相信 “done”

一句流畅回答不能证明写入经过授权、改动发生在正确 workspace、verifier 已通过，或被委派的工作已集成。Forge 把这些判断变成显式状态，并保留可复核证据。

## Runtime 拥有哪些决定权

- handler dispatch 前，permission policy 先决定 `allow`、`ask` 或 `deny`。
- Prompt context 有界；append-only Trace 保存历史证据。
- Worktree ownership、TaskGraph transition、plan approval、source fingerprint、verification、Git receipt 和 CompletionGate 都是 Runtime obligation。
- root verifier 决定 candidate 能否成为 final answer。

完整映射见 [Evidence Index](docs/evidence-index.md)，架构边界见 [Architecture overview](docs/architecture-overview.md)。

## 三条 failure story

1. **Permission before dispatch。** 格式正确的 write 仍可能越权；Runtime 在 handler 运行前 deny，demo 用 dispatch counter 证明实现没有被调用。
2. **Context 与 Trace 分离。** Compaction 让下一次决策保持有界，append-only Trace 保存有序事实。Compacted context 是决策视图，不是审计账本。
3. **Offline-eval compaction regression。** 固定场景检测到 ordered-read 从 `3` 降到 `2`，Trace 隔离 repeated-compaction loss；candidate 按 identity 冻结，不为了绿色结果重抽样。见 [Offline-eval guide](docs/offline-eval.md) 和 [regression report](docs/assets/evidence/offline-eval-regression-report.md)。

三条是招聘叙事，不是完整 capability 清单。完整边界请看 Evidence Index。

## 三分钟 deterministic demo

前提：Linux、macOS 或 WSL2 上的 Node.js `>=20.19`、Git 和 Bash。不声明 native Windows shell 或 WSL1 支持，因为 Runtime 执行 Bash command。

```bash
npm ci
npm run demo:portfolio
```

命令不调用模型、不读取 `.env`，只创建临时 Git repository/worktree，并输出三个稳定 receipt：

```text
scene.action-boundary PASS deny-before-dispatch
scene.verification-recovery PASS recovery-before-final
scene.coordination-completion PASS receipt-before-ready
```

三个 scene 独立演示，不冒充一个 live Session。见 [demo source](src/portfolio/demo.ts) 和 [CI](.github/workflows/ci.yml)。

## 明确没有实现的能力

当前 c17c Runtime 不声称具备 OS-level sandbox、crash-safe resume/reconciliation、分布式调度或共识、跨 run durable queue、deterministic model reasoning、统计显著性评估或 hosted Web UI。已批准 extension 仍在当前进程和 host permissions 下运行。

实现取舍见 [engineering case study](docs/engineering-case-study.md)，口述节奏见 [cue cards](docs/interview-cue-cards.zh-CN.md)。

