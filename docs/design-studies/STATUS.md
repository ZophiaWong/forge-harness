# Research Status

最后更新：2026-08-01。

## 当前阶段

Phase 0–9 已完成。三个 repository snapshot 已冻结，六篇核心文章和综合报告已经交叉审校，根 README 入口已接入；引用、链接、固定结构、Mermaid 围栏、术语、语言与 repository safety 均已复核。

研究分支：`research/agent-runtime-design-studies`。

## Phase 状态

| Phase | 状态 | 可审阅结果 |
| --- | --- | --- |
| 0. Repository grounding | Complete | 三个 snapshot 已冻结；Forge c17c current-state 已核对 |
| 1. Research foundation | Complete | `SOURCES.md`、`METHODOLOGY.md`、本状态文件与 evidence ledger 已建立 |
| 2. Loop and completion | Complete | [01](01-agent-loop-and-completion.md) |
| 3. Tool runtime | Complete | [02](02-tool-runtime-and-action-boundary.md) |
| 4. Context and compaction | Complete | [03](03-context-construction-and-compaction.md) |
| 5. Session and branching | Complete | [04](04-session-persistence-and-branching.md) |
| 6. Delegation and coordination | Complete | [05](05-delegation-and-coordination.md) |
| 7. Extensibility and trust | Complete | [06](06-extensibility-governance-and-trust.md) |
| 8. Synthesis | Complete | [07](07-agent-runtime-design-synthesis.md) |
| 9. Integration and QA | Complete | 根 README 入口、`humanizer-zh`、citation/link/structure/diff/project checks |

## 已验证证据

- Forge snapshot、Pi snapshot 与 Claude local snapshot 的 remote、branch、commit、package version 和 dirty state 已记录在 `SOURCES.md`。
- Forge `main@75714f2` 确认包含 `c17c Coordination / Completion Protocol`，roadmap 明确把 attempts、resume、idempotency、reconciliation 和 event replay 留给 future `c18`。
- 研究 worktree 从 local `main` 创建，未携带 primary checkout 的 `docs/portfolio-hardening/`。
- Forge baseline：source typecheck、test typecheck 与 build 通过；55 个 test files 通过，387 tests passed、1 个 sandbox-aware nested-spawn test skipped；两个 c17c smoke tests 通过。

## 最终验证记录

- 14 份本次检查覆盖的 Markdown 文件通过相对链接、围栏、固定结构与本机绝对路径检查；六篇核心文章均有 16 节、Mermaid 和 interview takeaway。
- 813 处带行号引用通过 repository、commit、path 与 line-range 校验。
- DS01 的完整 test-name filter 已登记；DS02 的 fixture、专用 config、stdout 与 SHA-256 已保留在 `experiments/`，且不进入普通 test suite。
- `git diff --check` 通过；最终变更范围只有根 `README.md` 与 `docs/design-studies/`。
- Forge source typecheck、test typecheck 与 build 通过。
- Forge full deterministic suite：55 files passed；387 tests passed；1 个 workspace-sandbox-aware nested-spawn case skipped。
- Claude 与 Pi checkout 的 commit 未变化且 `git status` clean；没有写入第三方 tracked source。
- 未执行 push、PR、release 或任何外部发布。

## Open evidence gaps

- Claude local snapshot 的泄露/修复 provenance 使部分 product behavior 无法升级为 High confidence。
- Claude snapshot 缺少 conventional tests，部分 imported implementation 也不在本地 tree；对应结论只能保持 Medium 或 Unknown。
- Pi checkout 没有可用的 `node_modules`/build artifacts，focused test command 未能启动；Pi 行为依据 current source 与 repository tests，不能写成 fresh run。
- 需要凭证的 Claude/Forge live model experiments 不会执行；对应行为只使用 local code/test 或标记为 `Not executed`。

## 后续研究问题

1. Claude local snapshot 与当前官方 Claude Code release 的等价性仍无法从本地材料证明。
2. Pi same-file branch 在 append 前重开时的 leaf 行为值得补一条 file-backed characterization test。
3. Forge c18 可围绕 Attempt identity、idempotency 与 owner-local reconciliation 继续研究，但本分支不实现这些机制。
