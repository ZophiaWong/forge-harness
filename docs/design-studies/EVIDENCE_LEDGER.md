# Evidence Ledger

本文件记录跨文章复用的证据、运行观察和 evidence gaps。版本映射见 [SOURCES](SOURCES.md)，标签与 confidence 规则见 [METHODOLOGY](METHODOLOGY.md)。

## 1. Repository grounding

| ID | Claim | Evidence | Confidence |
| --- | --- | --- | --- |
| SRC-F-01 | Forge 研究基线是已集成 c17c 的 `main@75714f2`。 | `[DOC][Forge@75714f2:README.md:L13-L15]`；commit/version 绑定见 [SOURCES](SOURCES.md) | High |
| SRC-P-01 | Pi snapshot 是 `main@977ec833`，core、coding-agent 与 ai packages 均为 `0.83.0`。 | `[CODE][Pi@977ec833:packages/agent/package.json:L1-L4]`；`[CODE][Pi@977ec833:packages/coding-agent/package.json:L1-L4]`；`[CODE][Pi@977ec833:packages/ai/package.json:L1-L4]` | High |
| SRC-C-01 | Claude snapshot 是非官方 repaired local copy，而非可直接代表当前官方产品的 canonical source。 | `[DOC][Claude@430502e:README.md:L1-L7]`；`[CODE][Claude@430502e:package.json:L1-L4]` | High for provenance; Unknown for equivalence to current official product |

## 2. Forge baseline runs

### RUN-F-BL-01 — Type and build baseline

```text
Research question: c17c snapshot 是否能在研究环境完成静态验证与 build？
Repository and commit: Forge@75714f2
Command:
  node ../../node_modules/typescript/lib/tsc.js --noEmit
  node ../../node_modules/typescript/lib/tsc.js -p tsconfig.test.json --noEmit
  node ../../node_modules/typescript/lib/tsc.js -p tsconfig.json
Preconditions: 从 research worktree root 执行；Node v22.22.2 可从 PATH 解析；使用已安装的共享 node_modules
Expected observation: 三条命令均以 exit 0 结束；前两条不输出 type error，第三条生成 ignored dist
Actual observation:
  source typecheck: passed
  test typecheck: passed
  build: passed
Artifacts: ignored dist output
Limitations: shell 中默认 npm 指向 Windows 安装，不能直接使用 npm wrapper
Conclusion: snapshot 的 TypeScript source 与 test types 在当前依赖集上成立
```

### RUN-F-BL-02 — Test baseline

```text
Research question: c17c snapshot 的 deterministic test suite 是否成立？
Repository and commit: Forge@75714f2
Command: env TMPDIR=/tmp TEMP=/tmp TMP=/tmp CODEX_PERMISSION_PROFILE=:workspace node ../../node_modules/vitest/vitest.mjs run
Preconditions: 从 research worktree root 执行；Node v22.22.2 与共享 node_modules 可用；workspace sandbox
Expected observation: suite passes，受限 stdio child-process case skipped
Actual observation: 55 test files passed；387 tests passed；1 test skipped
Artifacts: Vitest terminal output only
Limitations: skipped case 不证明真实 stdio nested child process；不调用 LLM API
Conclusion: 当前 deterministic contracts 在 workspace sandbox 下成立
```

### RUN-F-BL-03 — c17c capstone smoke

```text
Research question: TaskGraph、Git integration、root verifier 与 CompletionGate 能否完成 deterministic 闭环？
Repository and commit: Forge@75714f2
Command: env TMPDIR=/tmp TEMP=/tmp TMP=/tmp CODEX_PERMISSION_PROFILE=:workspace node ../../node_modules/vitest/vitest.mjs run test/smoke/c17cCapstone.test.ts
Preconditions: 从 research worktree root 执行；Node v22.22.2 与共享 node_modules 可用；Git CLI可用
Expected observation: one test passes
Actual observation: one test passed
Artifacts: test-created temporary Git repositories/worktrees
Limitations: test 直接调用 stores/services，不经过 model、public tool schema 或 permission path
Conclusion: c17c protocol services 能在 deterministic fixture 中闭环
```

### RUN-F-BL-04 — c17c child integration smoke

```text
Research question: one-shot edit child source 能否经 trusted source binding、verification 与 integration 完成？
Repository and commit: Forge@75714f2
Command: env TMPDIR=/tmp TEMP=/tmp TMP=/tmp CODEX_PERMISSION_PROFILE=:workspace node ../../node_modules/vitest/vitest.mjs run test/smoke/c17cChildIntegration.test.ts
Preconditions: 从 research worktree root 执行；Node v22.22.2、共享 node_modules 与 Git CLI可用
Expected observation: one test passes
Actual observation: one test passed
Artifacts: test-created child/target worktrees
Limitations: 不启动真实 child model/session
Conclusion: source binding 与 Git integration 的 deterministic path 成立
```

### RUN-F-DS01 — no-tool 与 pending-child completion

```text
Research question: no-tool response 在裸 loop 与 pending async child 下是否有不同 completion 语义？
Repository and commit: Forge@75714f2
Command: env TMPDIR=/tmp TEMP=/tmp TMP=/tmp CODEX_PERMISSION_PROFILE=:workspace node ../../node_modules/vitest/vitest.mjs run test/core/minimalLoop.test.ts -t 'stops immediately when the model returns no tool calls|lets the parent continue after async delegation and gates final until child handoff returns'
Preconditions: 从 research worktree root 执行；Node v22.22.2 与共享 node_modules 可用；不需要 API key、network 或真实 child process
Expected observation: bare no-tool case 一轮结束；pending child case 让 premature candidate 失效，terminal handoff 后才能接受 final
Actual observation: one test file passed；2 tests passed；35 unrelated tests skipped by name filter；exit 0；duration 434ms
Artifacts: Vitest terminal output only
Limitations: fake provider/child fixture；不调用真实模型或 child process
Conclusion: candidate-final 与 async convergence 的差别在当前 deterministic fixture 中成立
```

### RUN-F-DS02 — direct multi-call serial ordering

```text
Research question: 同一 response 中两个 direct tool calls 的 permission、execution 与 next-turn insertion 顺序是什么？
Repository and commit: Forge@75714f2
Command: env TMPDIR=/tmp TEMP=/tmp TMP=/tmp CODEX_PERMISSION_PROFILE=:workspace node ../../node_modules/vitest/vitest.mjs run --config docs/design-studies/experiments/vitest.ds02.config.ts
Preconditions: 从 research worktree root 执行；Node v22.22.2 与共享 node_modules 可用；主 Vitest config 不会自动包含 docs fixture
Expected observation: alpha permission/execution 完整结束后才开始 beta；两次 model request 都关闭 parallel tool calls；第二轮 input 保持 call_a、call_b source order
Actual observation: one research fixture passed；exit 0；duration 447ms；Node v22.22.2；Vitest v4.1.10
Artifacts: [fixture、config、stdout与SHA-256](experiments/README.md) 均随研究文档保留；fixture SHA-256 `9f3376f0161505a02e0d55af893cfb7be11b84831e3fbe9a7d0a0977f5d278ed`
Limitations: 这是不进入普通 test suite 的研究 characterization；fake provider/runtime 不覆盖真实 provider 并行输出
Conclusion: 当前 direct path 的 serial/source-order behavior 由 source 和本地 run 共同支持
```

## 3. Evidence matrix

证据 survey 按下列矩阵登记。`Open` 表示已定义的研究缺口，不表示推定结论。

| Study | Claude | Pi | Forge | Cross-check state |
| --- | --- | --- | --- | --- |
| Loop / completion | Source path mapped；无 conventional tests | Core source + focused tests mapped | Source + focused tests + DS01 run mapped | Complete in [01](01-agent-loop-and-completion.md) |
| Tool / action boundary | Source path mapped；rewrite 二次校验为实验候选 | Source + rewrite/parallel tests mapped | Source + deny/raw-argument tests + DS02 run mapped | Complete in [02](02-tool-runtime-and-action-boundary.md) |
| Context / compaction | Source mapped；部分 compact modules 缺失 | Source + compaction/resource tests mapped | Source + compaction/prompt tests mapped | Complete in [03](03-context-construction-and-compaction.md) |
| Session / branching | JSONL/replay/fork source mapped | Shipped coding-agent tree + tests mapped | Audit/lineage source + tests mapped；resume 明确缺失 | Complete in [04](04-session-persistence-and-branching.md) |
| Delegation / coordination | Agent/team/task/mailbox source mapped | Core absence + example extension mapped | c15/c17 protocol source + tests mapped | Complete in [05](05-delegation-and-coordination.md) |
| Extensibility / trust | Plugin/hook/MCP source mapped；live tests 缺失 | Loader/trust/reload source + tests mapped | Preflight/trust/activation source + tests mapped | Complete in [06](06-extensibility-governance-and-trust.md) |

## 4. Experiment register

| ID | Question | Evidence path | State |
| --- | --- | --- | --- |
| EXP-LOOP-01 | no-tool assistant response 是否等于 candidate final，后续还有哪些 gate？ | Forge loop/completion tests + Claude/Pi code | Existing evidence analyzed |
| EXP-TOOL-01 | parallel tool completion order 与 transcript order 是否一致？ | Pi focused test；Claude executor source；Forge serial-path analysis | Pi test evidence analyzed；未 fresh-run |
| EXP-TOOL-02 | invalid args、permission deny 与 input rewrite 的先后顺序是什么？ | Pi rewrite test；Forge deny/raw-argument tests；Claude source | Existing evidence analyzed；Claude rewrite case not executed |
| EXP-CTX-01 | compaction 后哪些 instruction、memory 与 skill 会重新注入？ | Pi compaction tests；Claude compact source；Forge c12 tests | Existing evidence analyzed |
| EXP-SES-01 | session fork 后 parent/child history 如何变化？ | Pi session tree tests；Claude local session code；Forge child-session tests | Existing evidence analyzed；Pi branch-before-append reopen remains candidate |
| EXP-COORD-01 | pending child、task 或 teammate 是否阻止 root final？ | Forge c15b/c17c tests；Claude/Pi code | Forge deterministic evidence analyzed |
| EXP-TRUST-01 | extension trust 前是否 import code 或 spawn process？ | Forge preflight/activation tests；Pi/Claude loader source | Forge deterministic evidence analyzed；第三方 live loading not executed |

## 5. Global evidence gaps

- Claude local snapshot 与当前官方 Claude Code release 的等价性无法从本地材料证明。
- 需要真实 provider、账户、凭证或外部 MCP service 的行为不会运行。
- crash 发生在 side effect success 与 receipt persistence 之间时，Forge `c17c` 没有 durable reconciliation；这是显式 production-hardening boundary，不是本研究要补的实现。
