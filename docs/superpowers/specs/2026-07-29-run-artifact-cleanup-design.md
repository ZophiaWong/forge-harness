# Forge 运行产物清理设计

## 问题

每次运行 Forge Harness 都可能在 `.forge/sessions/` 写入 trace、task graph 和 teammate mailbox，并在 `.forge/worktrees/` 留下 root、child 或 teammate worktree。当前只能手动删除这些目录。直接运行 `rm -rf .forge` 会把 MCP、plugin、memory 和 skill 配置一起删掉；直接删除 worktree 目录还会在 Git 中留下失效注册。

## 命令

新增独立命令：

```bash
npm run clean:runs
```

命令先列出即将清理的 session 和 worktree 数量，再要求输入 `y/N`。自动化环境使用：

```bash
npm run clean:runs -- --yes
```

未传 `--yes` 且 stdin 不是交互终端时，命令直接失败，不等待输入。除 `--yes` 外的参数视为错误。npm script 先构建 TypeScript，再运行编译后的清理入口。

## 清理边界

命令只处理：

- `.forge/sessions/`
- `.forge/worktrees/`

以下内容必须保留：

- `.forge/mcp.json`
- `.forge/plugins.json`
- `.forge/memory.md`
- `.forge/skills/`
- 所有 Git branch，包括 `forge/run/*` 和 `forge/teammate/*`
- 仓库内外的其他文件

所有删除目标都先解析为绝对路径，并验证其位于当前仓库的 `.forge/sessions/` 或 `.forge/worktrees/` 下。清理逻辑不接受调用方传入任意路径。

## 执行顺序

1. 读取 `.forge/sessions/` 下的一级 session 数量。
2. 运行 `git worktree list --porcelain`，筛选位于当前仓库 `.forge/worktrees/` 下的注册 worktree。
3. 按路径深度从深到浅执行 `git worktree remove --force <path>`，先移除 teammate 等嵌套 worktree。
4. 运行 `git worktree prune`，清除目录已经丢失的 stale registration。
5. 删除 `.forge/worktrees/` 中未注册的残留内容。
6. 删除 `.forge/sessions/`。

`--force` 只传给 `git worktree remove`，用于删除运行 worktree 中尚未提交的 agent 产物；它不用于删除 branch。

若注册 worktree 删除失败，命令继续尝试其他注册 worktree 并收集错误，随后执行 `git worktree prune`。只要存在失败项，就不递归删除残留 worktree 根目录，也不删除 sessions。命令打印失败路径和 Git 错误后以非零状态退出。已经成功移除的 worktree 不回滚。

目录不存在或两处目录都为空时，命令输出 `nothing to clean` 并成功退出。

## 代码边界

- `src/runtime/runArtifactCleanup.ts` 负责发现目标、验证路径、调用 Git 和删除目录。该模块不读取终端输入。
- `src/cli/cleanup.ts` 负责参数解析、摘要输出、交互确认和 exit code。
- `package.json` 暴露 `clean:runs`，先执行 build，再运行 `dist/cli/cleanup.js`。

runtime API 接收仓库根目录和可替换的 Git/process adapter，返回包含 session 数量、worktree 数量、删除结果和失败项的结构化结果。CLI 只根据结果渲染文本。

## 验证

自动化测试在临时 Git 仓库中覆盖：

- 删除带未提交文件的注册 worktree，但保留对应 branch；
- 嵌套 worktree 按深度优先移除；
- stale worktree registration 经 `git worktree prune` 清除；
- 删除 sessions 和未注册残留目录；
- `.forge` 下的 MCP、plugin、memory 和 skill 配置保持不变；
- worktree 删除失败时保留 sessions 和残留目录，并返回非零状态；
- 没有运行产物时重复执行仍成功；
- CLI 默认要求确认，`--yes` 可跳过确认，未知参数会失败。

完整验证运行 `npm run test`、`npm run typecheck` 和 `npm run build`。手工 smoke 在测试仓库中先创建 session、脏 worktree 和保留配置，再执行 `npm run clean:runs -- --yes`，最后检查 Git worktree 列表、branch 和文件边界。

## 文档

README 记录共享清理命令、确认行为和保留边界。`docs/tutorial/c14-worktree-isolation.md` 原先把 cleanup 列为未来能力，修改后指向 README，说明命令只清理本地运行产物，不删除 branch。
