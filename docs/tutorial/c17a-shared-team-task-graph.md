# c17a Shared Team Task Graph

c10 的 `todo` 能让一次 run 记住自己的计划。到了 c15，parent、sync child 和 async child 都有独立 session，也各自拿到一份 `todo`。隔离上下文是好事，但局部计划无法回答团队问题：哪个任务依赖哪个任务，child 的结果算不算验收证据，另一个 session 现在能不能开始下一项工作？

c17a 增加一份 root-session scoped TaskGraph。它把 task contract、dependency、status 和 evidence 放进同一个磁盘快照，让 Leader 与 root-linked children 看到同一份工作状态。`todo` 没有被替换；它继续服务当前 session 的执行计划。

## 问题

假设 Leader 把工作拆成两项：

```text
task_001: 收集证据
task_002: 写结论，依赖 task_001
```

如果只用各 session 的 `todo`，Leader 和 child 会各自保存一份 snapshot。child 完成调查后，Leader 只能从 handoff 文本里猜 `task_001` 是否满足验收条件；另一个 child 也不知道 `task_002` 仍被 dependency 挡住。两个 session 同时改各自的副本，还会得到两份互不相干的“当前状态”。

先分开两个概念：

| 名称 | 生命周期 | 回答的问题 |
| --- | --- | --- |
| `todo` | 单个 session、内存态 | 这个 session 接下来准备怎么做？ |
| `task_*` / TaskGraph | root session 及其 children、磁盘态 | 团队有哪些共享任务，依赖和证据现在是什么？ |

把 TaskGraph 塞回每轮 prompt 也不合适。图会随任务和 evidence 增长，模型上下文会反复携带同一份快照。c17a 保留显式读取：模型需要当前共享状态时调用 `task_list` 或 `task_get`。

两个 session 还可能同时写共享文件。普通的“读 JSON、改对象、写回去”会丢失其中一次更新；半写入文件则会让后续 reader 读到损坏的 graph。因此 store 必须同时处理互斥写入、原子替换和严格校验。

## 解决方案

每个 root session 初始化一份 TaskGraph：

```text
.forge/sessions/<root-session-id>/
├── session.json
├── trace.jsonl
└── task-graph.json
```

child 的 `session.json` 不复制 graph，只保存一条指回 root 的 binding：

```ts
interface SessionTaskGraphBinding {
  delegatedTaskId?: string;
  rootSessionId: string;
  taskGraphPath: string;
}
```

`taskGraphPath` 是 absolute path。research child、edit child、同步和异步 delegation 都沿用它；即使 edit child 在另一个 worktree 执行，TaskGraph 仍写回 root session 的目录。新的 root run 会创建自己的 graph，不会接续上一轮的文件。

数据路径可以概括成：

```text
Leader todo  ──> Leader session memory
Child todo   ──> Child session memory

Leader task_* ─┐
               ├──> root task-graph.json
Child task_*  ─┘
```

TaskGraph 保存 current state，而不是 event log：

```ts
interface TeamTaskGraphFile {
  nextTaskSequence: number;
  revision: number;
  schemaVersion: number;
  tasks: TeamTask[];
}
```

每个成功 mutation 只增加一次 `revision`。`nextTaskSequence` 在锁内生成 `task_001`、`task_002` 这类不会因删除而复用的 ID。`ready` 不写进文件；读取时根据 task status 和 dependency status 计算，避免持久化一份可能过期的派生值。

### 角色权限

c17a 只有 `leader` 和 `child` 两种 actor，没有 owner、claim 或 verifier。

| Actor | `task_list` / `task_get` | `task_create` / `task_update` | `task_add_evidence` |
| --- | --- | --- | --- |
| Leader | 可以 | 可以 | 可以 |
| 带 `taskId` 的 child | 可以 | 不提供 | 只能写自己的 delegated task |
| 未带 `taskId` 的 ad-hoc child | 可以 | 不提供 | 不提供 |

`delegate({ taskId })` 只接受已经处于 `in_progress` 的 task。它建立 child 与 task 的关联，不会顺手改 status，也不会建立 ownership。多个 children 可以关联同一个 task。对于 linked child，harness 会在 generated child task prompt 里写入系统持有的 exact `delegatedTaskId`；它只传 ID，不附带 graph snapshot。

### 状态机

最小状态机有四个状态：

```text
pending --ready--> in_progress --evidence + Leader--> completed
pending --reason--> blocked --retry--> pending
in_progress --reason--> blocked
in_progress --retry--> pending
```

- `pending -> in_progress` 要求所有 dependencies 已经 `completed`。
- `pending | in_progress -> blocked` 必须给出非空 `blockedReason`。
- `blocked -> pending` 会清除 `blockedReason`。
- `in_progress -> pending` 用于重试，已有 evidence 不会被删掉。
- `in_progress -> completed` 只能由 Leader 执行，并且要求 dependencies 完成、evidence 非空。
- `completed` 是冻结状态，contract、status、evidence 和删除都不能再改。

Task contract 包含 `title`、`description`、`acceptance` 与 `dependencies`。contract 只能在 `pending` 或 `blocked` 时调整。这样 task 开始执行后，验收目标不会在 child 不知情时被改写。

## 最小实现

### 1. domain 层保存事实，`ready` 在读取时派生

`src/domain/teamTask.ts` 定义 persisted task：

```ts
export interface TeamTask {
  acceptance: string[];
  dependencies: string[];
  evidence: TeamTaskEvidence[];
  id: string;
  status: TeamTaskStatus;
  title: string;
  // description、timestamps、optional blockedReason
}
```

summary 才加入 `ready`：

```ts
return {
  dependencies: [...task.dependencies],
  evidenceCount: task.evidence.length,
  id: task.id,
  ready: isTeamTaskReady(graph, task),
  status: task.status,
  title: task.title,
};
```

`isTeamTaskReady()` 先验证整张 graph，再确认 task 是 `pending`，最后检查每个 dependency 是否 `completed`。graph 无效时，它直接返回 `false`。

### 2. root 初始化，child 只继承 binding

`src/runtime/session.ts` 根据 root session ID 得到 graph path：

```ts
const sessionDir = path.join(cwd, ".forge", "sessions", sessionId);

return {
  sessionDir,
  taskGraphPath: path.resolve(sessionDir, "task-graph.json"),
  // sessionMetadataPath、tracePath
};
```

root 创建 session 时初始化 store；child 只持久化传入的 binding：

```ts
if (!options.child) {
  await createFileTeamTaskStore({
    graphPath: paths.taskGraphPath,
  }).initialize();
}
```

store 还会在 graph 旁写一个 initialization marker。若已经初始化过的 graph 后来丢失，新的 store instance 会报告 `graph_missing`，不会悄悄创建空图并把 ID 从 `task_001` 重新开始。

### 3. 所有 mutation 共用一次锁内流程

`src/runtime/teamTaskStore.ts` 把 create、update、evidence 和 delete 收进同一个 mutation boundary：

```ts
const graph = await load();
const result = change(graph);
graph.revision += 1;
const validatedGraph = parseTeamTaskGraphFile(graph);
await write(validatedGraph);
```

完整写入顺序是：

1. 用 `open(..., "wx")` 获取 `<graphPath>.lock`；已占用时每 25 ms 重试，1,000 ms 后返回 `task_store_busy`。
2. 拿锁后重新读取并校验 graph，避免基于旧 snapshot 写入。
3. 执行一个 mutation，把 `revision` 增加一次，再校验 candidate graph。
4. 在同目录写入 unique temporary file，关闭后用 `rename` 原子替换 `task-graph.json`。
5. 在 `finally` 关闭并删除 lock。

c17a 不猜 stale lock 是否安全，也不按 TTL 抢锁。自动回收需要知道原 writer 是否仍在运行，这已经超出当前 checkpoint。

若 rename 已经提交新 revision、随后 lock cleanup 失败，store 会把 committed mutation 一并交给 tool adapter。tool result 仍是 `completed`，同时带 `store_io` degraded warning，避免 trace 把已经落盘的 mutation 错记成“没有发生”。

### 4. graph 损坏时 fail closed

每次读取都会严格解析 schema、字段、ID、dependency 和 DAG。以下情况不会返回部分结果：

| 问题 | stable code | health |
| --- | --- | --- |
| 文件丢失 | `graph_missing` | `degraded` |
| JSON 损坏 | `graph_malformed` | `degraded` |
| schema version 不支持 | `schema_unsupported` | `degraded` |
| unknown dependency、self edge、cycle 或非法字段 | `graph_invalid` | `degraded` |
| 等锁超时 | `task_store_busy` | `degraded` |

`degraded` 会让当前 `task_*` 调用 fail closed，但不会终止 agent loop；`read`、`ls`、`bash` 等不依赖 TaskGraph 的 tools 仍可继续使用。

合法 graph 上的请求拒绝，例如 `task_not_ready`、`evidence_required` 或 `permission_denied`，使用 `healthy`。它们说明规则挡住了请求，不代表存储已经损坏。

read APIs 不取 write lock，返回 deep clone。这样 reader 不会修改 store 内部对象，也不会因为另一个 session 正在思考而占住写锁。

### 5. evidence 必须显式写入

caller 只提交 task ID 与业务证据：

```ts
{
  id,
  summary,
  references?: [{ kind, value }],
}
```

tool runtime 从 actor 和当前 tool call context 注入 provenance，caller 不能自行填写。写入 task 的 evidence 是：

```ts
{
  summary,
  references?,
  reportedByRole,
  reportedBySessionId,
  callId,
  round,
  reportedAt,
}
```

reference 的 `kind` 只有 `artifact`、`trace` 和 `external`。evidence 只能在 task 为 `in_progress` 时追加；child 还必须与 `delegatedTaskId` 匹配。

child final answer 和 handoff 不会自动变成 evidence。二者只表示 child 已经结束并交回一段文本，不能证明 task contract 已满足。child 要主动调用 `task_add_evidence`，随后 Leader 读取证据并决定是否 `completed`。

### 6. trace 和 RuntimeState 只保留投影

每次 durable mutation 都产生一条 actor-local event：

```ts
{
  type: "task_graph_mutated",
  operation,
  taskId,
  previousStatus,
  nextStatus,
  revision,
}
```

child 写 evidence 时，revision mutation 留在 child trace；root trace 只记录 delegation lifecycle 和 handoff，不复制 child event。`RuntimeState.taskGraph` 也只保存 health、last seen revision、last mutation 与 last error，不缓存整张 graph。需要完整事实时仍然读取磁盘 store。

`todo` 继续走原来的 `task_state_updated`。Leader 和 child 各有自己的 event 与内存 snapshot，因此 child 的 `todo` 不会覆盖 Leader 的计划。

## 运行验证

先完成 [README Setup](../../README.md#setup)。本章的 smoke 使用 built-in tools，不需要 MCP 或 plugin；启动时若出现 c16a/c16b 的 trust prompts，直接按 Enter 拒绝即可。

运行一次包含 root 与 child 的完整流程：

```bash
npm run start -- 'Run this c17a smoke with exactly one tool call per round. The root must not call todo in this constrained smoke. Make these seven root tool calls in order: (1) task_create with title="Collect evidence", description="Collect explicit evidence from the linked child.", acceptance=["Child evidence exists"], and dependencies=[]; expect task_001. (2) task_create with title="Write conclusion", description="Use the verified result after task_001 completes.", acceptance=["Dependency is complete"], and dependencies=["task_001"]; expect task_002. (3) task_update task_002 to status="in_progress" and keep the expected task_not_ready failure. (4) task_update task_001 to status="in_progress". (5) delegate synchronously with profile="research", taskId="task_001", maxToolRounds=3, runInBackground=false, and task text that says: first call todo with summary="child-c17a", items=[{id:"child-step",title:"Record delegated evidence",status:"in_progress"}], and acceptance=["Evidence is appended to task_001"]; then call task_add_evidence with id="task_001", summary="child evidence recorded", and references=[{kind:"artifact",value:"README.md"}]; then answer without another tool. (6) after the handoff, task_update task_001 to status="completed" as Leader. (7) call task_list with {} and do not call another tool. Use round 8 for the final answer. Report both task IDs, the rejected reason code, the evidence reporter role and session, and the final ready value of task_002.'
```

root 不调用 `todo`，只按顺序调用上述七次 tools；round 8 用于回答。child 的三个 rounds 依次是 `todo`、`task_add_evidence` 和 final answer。应观察到：

- 两次 `task_create` 得到 `task_001` 和 `task_002`。
- 第一次启动 `task_002` 返回 `reason_code: task_not_ready`，graph 仍是 revision 2。
- `task_001` 进入 `in_progress` 后，`delegate` 成功启动 linked research child。
- child 的 `task_add_evidence` 写入 revision 4，provenance 中 `reported_by_role` 是 `child`。
- Leader 完成 `task_001` 后 graph 到 revision 5。
- 最后的 `task_list` 不修改 graph，并直接显示 `task_002 | status=pending | ready=true | dependencies=task_001`。

CLI 开头会打印 root session ID。查看共享 snapshot：

```bash
cat .forge/sessions/<root-session-id>/task-graph.json
```

应看到以下关键字段：

```json
{
  "nextTaskSequence": 3,
  "revision": 5,
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "task_001",
      "status": "completed",
      "evidence": [
        {
          "reportedByRole": "child",
          "summary": "child evidence recorded"
        }
      ]
    },
    {
      "id": "task_002",
      "status": "pending",
      "dependencies": ["task_001"]
    }
  ]
}
```

这是节选，不是完整文件。实际 task 还包含 contract、timestamps 和完整 provenance。文件里不应出现 `ready`；从 `pending task_002 + completed task_001` 读取时派生出 `ready=true`。

`delegate` result 会给出 child session ID 和 trace path。分别检查两条 trace：

```bash
rg 'task_not_ready|task_graph_mutated|task_state_updated|child_session_' .forge/sessions/<root-session-id>/trace.jsonl
rg 'task_graph_mutated|task_state_updated|child-c17a' .forge/sessions/<child-session-id>/trace.jsonl
```

root trace 应有 revisions 1/2/3/5 的 graph mutations，以及 `task_not_ready` 和 child lifecycle；它不应出现 child 的 `task_state_updated`。child trace 应有自己的 `child-c17a` todo event 与 revision 4 的 `add_evidence` mutation。child 的 `todo` 留在自己的 session，TaskGraph revision 则跨 session 连续增长。

## 下一步缺口

c17a 只让现有 one-shot children 共享 task state。它没有长期可寻址的 teammate，也没有 mailbox；这些由 `c17b Long-Lived Teammates / Mailbox` 处理。

TaskGraph 里没有 owner。assign、atomic claim 和 verifier 属于 `c17c Coordination / Completion Protocol`，届时 ownership、review、integration 与 team completion 才会进入同一条协议。c17a 的 Leader/child role 只是 tool authority，不是任务归属。

当前文件是 revisioned current-state snapshot，不是恢复日志。它没有 `Attempt` identity，也没有 resume、idempotency、reconciliation 或 event replay。进程在外部副作用之后、状态写回之前崩溃时，c17a 不能判断该重试还是采纳已有结果。这组问题留给新的 `c18 Attempts / Recovery / Reconciliation`。
