# c02-inspect-message-history: 看见模型真正收到的 History

c01 已经把第一条真实 loop 跑起来了。现在先别急着加新机制，先看一眼模型每轮输入进去的东西。

你能在 terminal 里看到 round、bash command、tool result 和 final answer。但这只是给人看的 transcript。模型下一轮真正收到的不是 transcript，而是 harness 维护的 local input history。

这一章加一个 `--show-history` 开关，把每轮 Responses API 调用前的 input history 打印出来。

```text
transcript: 给人看的运行过程
history:    下一轮 model call 的真实 input
```

这两个东西不能混在一起。

## 为什么要看 History

c01 的 smoke run 里，模型可能会执行一个很普通的命令：

```sh
ls -R
```

terminal 里你看到的是一段 `tool_result`。但对下一轮模型来说，那段 result 已经变成了一个 `function_call_output` item，和 user task、model 的 `function_call` 一起放进了 input history。

所以最小 loop 的状态不是一串 terminal 文本，而是这样的 input item 列表：

```text
round 1 input:
  [0] user message

round 2 input:
  [0] user message
  [1] function_call: bash
  [2] function_call_output: status/stdout/stderr/exit_code
```

c02 先把这份列表打印出来。

## 本章会实现什么

代码边界继续收窄：

- CLI 增加一个 `--show-history` flag。
- `runMinimalLoop` 在每轮 model call 前触发 `historySnapshot` callback。
- `src/core/historyInspector.ts` 把 provider-shaped `ResponseInputItem[]` 转成简短 summary。
- 默认 transcript 不变。只有显式打开 `--show-history`，CLI 才打印 history。

暂时不做这些：

- 不打印完整 raw JSON。
- 不加 `--model`、`--cwd`、`--max-rounds`。
- 不把 history 转成自己的 domain model。
- 不做 `Context Projection`、`Observation`、`Trace` 或 `Session`。

这一章只是加一个观察入口，不是引入新的 runtime 机制。

## 运行一次

先确认测试和 build：

```sh
npm run test
npm run typecheck
npm run build
```

然后打开 history inspection：

```sh
npm run start -- --show-history "inspect this project scaffold and summarize what is implemented"
```

你应该能看到每轮 model call 前多出一段 `input_history`：

```text
[round 1] model=gpt-5.4-mini
[round 1] input_history:
[0] type=message role=user chars=64 preview="inspect this project scaffold and summarize what is implemented"

[round 1] bash: ls -la
...

[round 2] model=gpt-5.4-mini
[round 2] input_history:
[0] type=message role=user ...
[1] type=function_call name=bash call_id=... preview="{\"command\":\"ls -la\"}"
[2] type=function_call_output call_id=... preview="status: completed\ncommand: ls -la..."
```

重点看 round 2。tool result 不只是出现在 terminal 里，它已经进入下一轮 model input。

## History Summary 怎么读

每一行是一条 input item。

```text
[2] type=function_call_output call_id=call_123 chars=240 preview="status: completed..."
```

先看这些字段：

- index：这条 item 在本地 input history 里的位置。
- type：provider item 类型，例如 `message`、`function_call`、`function_call_output`。
- role/name/call_id/status：如果 item 上有这些字段，就打印出来。
- chars：preview 来源文本的长度。
- preview：短预览，不是完整内容。

> 这里故意不 dump 完整 JSON。c02 要看的是 history 怎样增长，不是把 terminal 变成更大的 raw output。

## 这还不是 Context Projection

看到 history 后，你很可能会想：能不能只挑重要内容给模型？

后面会做，但不是现在。

这一章打印的仍然是 local input history 的 summary。它没有改变模型看到的内容，也没有筛选、摘要或重写任何 tool output。

```text
现在：inspect history
以后：project context
```

`Context Projection` 要解决的是“下一轮模型应该看到什么”。c02 先回答更朴素的问题：下一轮模型真正看到了什么？

## 这一章暴露了什么

看见 history 后，几个问题会变得更难忽略。

tool call 和 tool result 还是 provider-shaped item。Stage 1 直接使用 Responses API 的形状没问题；等工具变多，harness 就需要自己的 tool schema、metadata、dispatcher 和 result protocol。

`bash` result 现在只是一段临时拼出来的普通字符串。它能工作，但无法稳定表达 success/error、side effect、risk、output summary 等信息，后面需要把它升级成稳定的 result protocol。

raw stdout/stderr 会进入 history。粗糙截断只能防止输出爆掉，不能判断哪些信息应该进入下一轮 input。

c02 先把这些问题放到眼前。下一章进入 `c03-inline-bash-pain`，从 inline `bash` tool 的结构问题开始。

## 进入下一章前

这一章先记住这些：

- transcript 是给人看的运行日志。
- history 是下一轮 model call 的真实 input。
- `function_call_output` 会进入 local history，而不是只打印到 terminal。
- history summary 是观察工具，不是 `Trace`。
- preview/truncation 是 terminal 展示策略，不是 `Context Projection`。
- 下一章开始处理 inline `bash` tool 不可扩展的问题。
