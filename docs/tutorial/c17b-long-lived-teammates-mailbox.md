# c17b Long-Lived Teammates / Mailbox

c15 的 child session 适合一次性委派：接收 task，运行，交回 handoff，然后结束。它解决了“把一段工作交给另一个上下文”的问题，却不能继续回答下面这些需求：

- 第一次调查结束后，Leader 想追问同一个成员，而不是启动一个失去上下文的新 child。
- 成员正在工作或暂时离线时，消息需要排队，不能只靠当前函数调用是否还在等待。
- edit 成员失败后，恢复过程要沿用原 worktree，同时明确建立新的运行实例。
- Leader 准备 final answer 时，不能靠反复调用模型来询问后台成员是否结束。

c17b 增加 root-session scoped teammate 与 mailbox。teammate 有稳定名字、独立 Node process 和跨 turn history；每次 start 或 rejoin 则分配新的 `sessionId`。这两个 identity 分开后，消息可以一直发给 `docs-editor`，trace 仍能区分它失败前后的两个 process。

## 问题

如果直接把 c15 child 留在内存里，会遇到三个边界问题。

第一，函数返回值不是 mailbox。成员 busy 时，新消息没有稳定落点；Leader 进程或 worker 在投递中途退出，也无法判断消息是否已经被接收。

第二，成员名字和 process identity 不能混用。`repo-researcher` 是协作中的固定地址，`20260727-...` 这类 session ID 才代表一次具体运行。rejoin 应保留前者、替换后者。

第三，后台等待不能变成 model polling。Leader 每看到一次“还在运行”就请求模型，会白白消耗 rounds，下一轮也未必正好等到结果。

本章先解决持续寻址和消息传递，不给消息附加任务所有权。普通 direct message 或 broadcast 不会 assign、claim、完成或 review TaskGraph task。

## 解决方案

Leader 是本章唯一 supervisor，也是 mailbox 文件的唯一读写者。每个 teammate 在独立 Node process 中运行，通过 `child_process.fork()` 得到独立 V8 与双向 IPC channel。Node 官方文档把 `fork()` 定义为带 IPC channel 的新 Node process；本章据此传递 typed messages，而不是用 `fs.watch` 监听 mailbox。后者在不同平台和文件系统上的可用性与行为并不一致，不适合作为这里的进程协议。[Node child process 文档](https://nodejs.org/api/child_process.html)、[fs.watch caveats](https://nodejs.org/download/release/v25.9.0/docs/api/fs.html)

文件落在当前 root session 下：

```text
.forge/sessions/<root-session-id>/team/
├── teammates/
│   └── <name>/
│       ├── definition.json
│       ├── runtime.json
│       └── sessions/<teammate-session-id>/
│           ├── session.json
│           └── trace.jsonl
└── mailboxes/
    └── <address>/
        ├── inbox.jsonl
        └── cursor.json
```

`definition.json` 保存稳定事实：`name`、profile、standing instructions、可选 `taskId`、resolved `maxToolRounds` 与 edit workspace。`runtime.json` 保存当前 `sessionId`、trace path、lifecycle 和 failure。rejoin 只改 runtime，不重写 definition。

生命周期只有五个状态：

```text
starting -> busy -> idle
    |         |       |
    +---------+------> failed --explicit rejoin--> starting

idle --root cleanup--> stopped
```

`failed` 仍占八人上限。它不会自动 restart；Leader 必须调用 `teammate_rejoin({ name, recovery })`。

### Mailbox 的处理语义

每个 recipient 有独立 sequence：

```text
msg_repo-researcher_000001
msg_repo-researcher_000002
msg_docs-editor_000001
```

`MailboxStore` 只暴露三个核心动作：

```ts
interface MailboxStore {
  append(input: AppendTeamMessageInput): Promise<TeamMessage>;
  claimUnread(address: string): Promise<MailboxClaim>;
  inspect(address: string): Promise<MailboxInspection>;
}
```

worker 空闲时，broker 把当前全部 unread messages 按 FIFO 快照成一个 model turn。快照形成以后到达的新消息留给下一批。

`claimUnread()` 在 dispatch 之前推进 `cursor.json`。因此自动处理是 at-most-once：若 worker 已收到 batch，但 model request 随后失败，这批消息不会自动重放。failure notice 会进入 Leader mailbox；rejoin 的 recovery message 会先投影，离线期间排队的 unread messages 接在后面。

这项选择故意偏向可解释性。c17b 不猜一个失败 turn 做到了哪一步，也不把可能已经产生副作用的 batch 静默再跑一次。attempt identity、checkpoint、reconciliation 和 replay 留给 c18。

## 最小实现

### 1. 一个 session 可以运行多个 turn

`src/core/minimalLoop.ts` 把原来的单次函数拆成 stateful session：

```ts
interface MinimalLoopSession {
  runTurn(input?: string, options?: {
    maxToolRounds?: number;
  }): Promise<MinimalLoopResult>;

  close(status: SessionEndStatus): Promise<void>;
}
```

history、tool runtime、todo、compaction summary 和全局 round number 都由 session 持有。每次 `runTurn()` 重新计算自己的 round budget；一个 turn 返回 final answer 后，session 不关闭。现有 `runMinimalLoop()` 仍是兼容 wrapper：运行一次 turn，再关闭 session。

若 teammate 的第一个 turn 使用 rounds 1、2，下一封 mailbox message 会从 round 3 开始。rejoin 不读取旧 history，而是建立新 `sessionId` 和全新的 stateful session。

### 2. Leader broker 负责持久化与唤醒

`src/extensions/teammates.ts` 管理 definition、runtime、process 和 mailbox delivery。direct message 根据 recipient 当前状态返回：

| 状态 | delivery |
| --- | --- |
| `idle` | `woken` |
| `starting` | `queued_starting` |
| `busy` | `queued_busy` |
| `failed` | `queued_offline` |

unknown、self 和 `stopped` recipient 会被拒绝。

broadcast 先固定 recipient snapshot，再逐个 append。某个 mailbox 写入失败时，结果会同时列出 `delivered` 和 `failed`；已经成功的写入不回滚。它不是 group chat，只有 Leader 能发起。

公开工具如下：

```ts
teammate_start({
  name,
  profile: "research" | "edit",
  instructions,
  message,
  taskId?,
  maxToolRounds?
})

teammate_list({})
teammate_rejoin({ name, recovery })
message_send({ to, content })
message_broadcast({ content })
```

所有成员都有 `teammate_list` 和 `message_send`。start、rejoin、broadcast 只出现在 Leader tool catalog。research start 是 `allow`；edit start 与全部 rejoin 是 `ask`。

名字必须匹配 `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`，长度为 1 到 32，`leader` 是保留地址。

### 3. Worker 只通过 IPC 请求团队动作

`src/cli/teammateWorker.ts` 是内部 worker entry。Leader 与 worker 使用固定协议：

```text
Leader -> worker:
initialize, run_batch, approval_result,
message_result, list_result, shutdown

worker -> Leader:
ready, turn_result, failure,
message_request, list_request, approval_request
```

research worker 只有 `read`、`ls`、`grep`、`find`、`todo`、允许的 `task_*` 读取/证据工具，以及 `teammate_list`、`message_send`。edit worker 在此基础上得到 `edit`、`write`，不获得 `bash`、delegate、cron、MCP 或 plugin tools。

worker 的 `edit` / `write` approval request 回到 Leader 的 FIFO approval queue。CLI approval 文本带 teammate name，Leader 可以逐项判断；approval result 再通过 IPC 返回原 worker。

每个 mailbox message 都独立投影：

```text
<mailbox_message>
id: msg_repo-researcher_000002
from: leader
kind: direct
content:
Compare this with your previous finding.
</mailbox_message>
```

模型仍在同一个 stateful session 里，所以 follow-up 能看到之前的 raw history 或 compaction summary。

### 4. edit worktree 绑定成员，而不是 process

edit teammate 第一次 start 时创建：

```text
branch: forge/teammate/<root-session-id>/<name>
path:   .forge/worktrees/<root-session-id>/teammates/<name>
```

binding 写入 definition。rejoin 直接复用它，不创建新 branch，也不删除旧 worktree。

每个成功 edit turn 都重新运行 `git status --porcelain`，把当前完整 `changedFiles` snapshot 排序后放进 `turn_result`。这是 preview evidence，不是 commit、review 或 merge。

### 5. final gate 等事件，不询问模型

Leader 模型给出 candidate final 时，`settleBeforeFinal()` 先检查：

- 是否还有 `starting` 或 `busy` teammate；
- 是否有未结算 IPC / approval；
- Leader mailbox 是否有尚未投影的消息。

若团队仍活跃，runner 等 broker activity promise。事件到达后，mailbox message 被投影，模型才得到下一轮请求。worker failure 会先写 `failure_notice`，随后进入 `failed`；notice 对 Leader 可见以后，`failed` 不会永久挡住 final。

正常 root cleanup 只向 idle workers 发送 `shutdown`。SIGINT / SIGTERM 会终止全部 children。shutdown 和 terminate 使用独立 deadline，超时后升级信号，避免遗留 orphan process。edit worktree 与 branch 保留给人工查看。

### 6. trace 与 RuntimeState 保存摘要

root trace 记录：

- teammate registration、session fencing、state transition 和 rejoin；
- mailbox persist / claim 与 broadcast partial result；
- brokered approval；
- graceful / terminate cleanup。

worker trace 保留自己的 model、tool、permission、todo 与 compaction events。root trace 不复制完整 worker trace。

`RuntimeState.teammates` 只投影 name、profile、state、session、unread count、trace 与 workspace，不缓存 mailbox body。需要原始消息时读取 `inbox.jsonl`。

## 运行验证

先完成 [README Setup](../../README.md#setup)。下面三次 smoke 都会创建新的 root session；启动时若出现与本章无关的 MCP / plugin trust prompt，可以拒绝。

### 1. research follow-up 保留 history

```bash
npm run start -- 'Run a c17b long-lived research smoke. First call teammate_start with name="repo-researcher", profile="research", instructions="Keep findings across mailbox turns. For the first message read package.json, then answer with the package name. For follow-up messages answer from conversation history unless explicitly asked to reread.", message="Read package.json and report the package name.", taskId=null, and maxToolRounds=3. Do not use delegate. Wait for its turn_result. Then call message_send to repo-researcher with content="Without rereading package.json, repeat the package name and say this is a follow-up." Wait for the second turn_result, then report both answers and the stable teammate name.'
```

应看到同一个 `repo-researcher` 产生两条 `turn_result`，第二条仍使用原 `sessionId`。worker trace 的 round number 单调增加。

### 2. 两名成员、broadcast 与 edit preview

```bash
npm run start -- 'Run a c17b broadcast and edit-preview smoke. Start research teammate repo-researcher with instructions="Answer mailbox messages briefly.", message="List the top-level docs directory and summarize it.", taskId=null, maxToolRounds=3. Then start edit teammate docs-editor with instructions="Work only in your stable worktree. On the first message create c17b-smoke.txt containing exactly c17b edit preview followed by a newline. On later messages answer briefly without another edit.", message="Create the requested preview file.", taskId=null, maxToolRounds=3. Approve the edit/write prompt. Then call message_broadcast with content="Reply with your name, profile, and whether your first task is done." Wait for all turn results. Report both session IDs plus docs-editor workspace branch, path, and changedFiles.'
```

edit start 会触发 Leader approval。最终回执应列出 `c17b-smoke.txt`，文件位于 teammate worktree，不在当前 checkout。broadcast 若在成员 busy 时到达，会显示 `queued_busy`，并在下一批处理。

### 3. failure、offline queue 与 explicit rejoin

```bash
npm run start -- 'Run a c17b failure and rejoin smoke. Start research teammate recovery-researcher with instructions="If a mailbox batch contains DO_FAIL, call read on package.json first. If it contains RECOVER, do not call a tool; answer directly and mention every queued message you can see.", message="DO_FAIL after the read, explain the package.", taskId=null, maxToolRounds=1. Its required read consumes the only round, so wait for failure_notice. Then call message_send to recovery-researcher with content="QUEUED_OFFLINE: include this exact token after recovery" and keep the queued_offline result. Call teammate_rejoin with name="recovery-researcher" and recovery="RECOVER: answer directly without tools." Wait for turn_result. Report the old and new sessionId, confirm the recovery text appeared before QUEUED_OFFLINE, and confirm the original DO_FAIL batch was not replayed.'
```

第一次 worker 会在 claimed batch 上失败。离线消息仍在 unread 区域；rejoin 分配新 `sessionId`，先投影 recovery，再投影离线消息。最终 answer 不应再次包含 `DO_FAIL`。

可以检查持久化文件：

```bash
find .forge/sessions/<root-session-id>/team -maxdepth 5 -type f | sort
rg 'teammate_|team_mailbox_|team_cleanup' .forge/sessions/<root-session-id>/trace.jsonl
```

`inbox.jsonl` 保留消息正文，`runtime.json` 显示当前 session 与 lifecycle；root `RuntimeState` 和 CLI 摘要不会复制正文。

## 下一步缺口

c17b 只建立成员、生命周期和消息通道。TaskGraph 仍没有 owner，也没有 assign / claim、自动完成、plan approval、review、commit、merge 或 integration。它们属于 c17c Coordination / Completion Protocol。

本章也没有 group chat、共享 team event log、任意 metadata、priority、attachment、reply-to 或 capability routing。普通消息只有 `to` 与非空 `content`；system receipt 只有固定的 workspace、changedFiles、session 和 failure 字段。

worker 没有 heartbeat、turn timeout、跨成员循环检测或 lifetime message budget。Leader 故障后，children 不会自治运行。root session 结束后也不能重新进入这支团队；磁盘文件只服务审计和同一 root 生命周期内的 explicit rejoin。

跨 root resume、history checkpoint、自动 restart/replay、Attempt、idempotency 与 reconciliation 留给 c18。c17b 的 failure recovery 是一次明确的新 session，不是假装旧 turn 从未失败。
