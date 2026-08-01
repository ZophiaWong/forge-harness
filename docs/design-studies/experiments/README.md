# DS02 direct multi-call characterization

这个 fixture 保留 [02-tool-runtime-and-action-boundary.md](../02-tool-runtime-and-action-boundary.md) 的 DS02-E1 实验。主 `vitest.config.ts` 只包含 `test/**/*.test.ts`，因此普通 `npm test` 不会自动运行这里的研究 fixture。

从 research worktree root 执行：

```bash
env TMPDIR=/tmp TEMP=/tmp TMP=/tmp CODEX_PERMISSION_PROFILE=:workspace \
  node ../../node_modules/vitest/vitest.mjs run \
  --config docs/design-studies/experiments/vitest.ds02.config.ts
```

实验同时断言：

- `alpha` 的 permission 与 execution 完全结束后才开始 `beta`；
- 两次 provider request 都设置 `parallel_tool_calls: false`；
- 下一轮的 `function_call_output` 保持 `call_a`、`call_b` 的 source order。

实际输出和 fixture digest 会在每次 fresh run 后登记到 [EVIDENCE_LEDGER.md](../EVIDENCE_LEDGER.md)。

最新记录（2026-08-01，`Forge@75714f2`）：

- Node `v22.22.2`，Vitest `v4.1.10`；exit code `0`；`1 file / 1 test passed`；duration `447ms`。
- Fixture SHA-256：`9f3376f0161505a02e0d55af893cfb7be11b84831e3fbe9a7d0a0977f5d278ed`。
- Config SHA-256：`6257327570811c3f8e7e54907fd685976d7877b0ea97239b05e69e496d19e971`。
- 去除 ANSI 控制码的 stdout 保存在 [ds02-direct-tool-order.output.txt](ds02-direct-tool-order.output.txt)。

这是 fake provider/runtime characterization，不调用模型 API，也不覆盖真实 provider 的并行输出。
