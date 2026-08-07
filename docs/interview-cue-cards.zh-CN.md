# 面试 cue cards（中文）

这是口述提示，不是第二份 case study。每条控制在 2–3 分钟，事实回指 canonical evidence。

## Permission before dispatch

- **节奏：** Model 提出 write → policy 分类 → 必要时 approval → handler dispatch → result/Trace。
- **取舍：** In-process policy 可检查、可测试，但不是 OS sandbox。
- **证据：** `src/governance/defaultPolicy.ts`、`test/governance/defaultPolicy.test.ts`、`npm run demo:portfolio` scene 1。
- **追问：** Approved plugin 仍在进程内运行，并经过 Forge tool/result/Trace 路径。

## Context 与 Trace

- **节奏：** Raw history 变长 → bounded projection/compaction 提供决策视图 → append-only Trace 保存有序事实。
- **取舍：** Compaction 故意有损；Trace 是 durable evidence，不是 model context。
- **证据：** `src/context/compaction.ts`、`src/runtime/trace.ts`、`test/context/compaction.test.ts`。
- **追问：** c17c 没有 crash-safe replay/resume，这是明确边界。

## Offline eval 发现 regression

- **节奏：** 固定 13-attempt contract 检测 `3→2` ordered reads → Trace 隔离 repeated-compaction loss → Runtime/test 修复 → identity-aware baseline/candidate 规则。
- **取舍：** 有效红结果就是证据；为了绿色重抽样会破坏可比性。
- **证据：** `docs/offline-eval.md`、`docs/assets/evidence/offline-eval-regression-report.md`、`src/eval/`。
- **追问：** eval 不证明通用 coding 能力、统计显著性、生产流量或 deterministic reasoning。

