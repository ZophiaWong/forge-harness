# c01-minimal-real-llm-loop: 跑起第一条真实 Loop

从这一章开始写代码。

目标很窄：让一个真实 LLM 请求一个本地 `bash` tool，让 harness 执行命令，再把 `Tool Result` 放回下一轮 model input。模型不再请求工具时，loop 停止并打印 final answer。

这一章不是在搭完整 runtime。先只把这条路径跑通：

```text
user task
  -> Responses API
  -> function_call: bash
  -> local bash -lc
  -> function_call_output
  -> Responses API
  -> final answer
```

## 本章会实现什么

代码只分两个小边界。

`src/cli/` 只负责 CLI 入口：

- 读取 `.env`。
- 从 command line args 拼出一次 task。
- 调用 minimal loop。
- 打印轻量 transcript。

`src/core/` 负责最直接的 loop：

- `minimalLoop.ts` 调用 OpenAI Responses API。
- `bashTool.ts` 执行本地 `bash -lc`。
- `bash` tool 只有一个参数：`command`。
- 每轮把 model output 和 `function_call_output` 都放回本地 input history。
- Responses request 使用 `store: false`，所以这一章的 conversation state 会保存在本地 history 里。

这里暂时不做 `Tool Runtime`、`Permission Governance`、`Session`、`Trace`、`Context Projection` 或 `Verification / Recovery`。等这条直接 loop 跑出问题后，再逐个补这些机制。

## 准备环境

先确认 Node.js 版本至少是 `20.19.0`：

```sh
node --version
```

安装依赖：

```sh
npm install
```

复制环境变量示例：

```sh
cp .env.example .env
```

然后填入：

```text
OPENAI_API_KEY=你的 OpenAI API key
OPENAI_MODEL=gpt-5.4-mini
```

`OPENAI_MODEL` 可以不改。默认模型是 `gpt-5.4-mini`，因为这一章只需要跑一次成本低一点的 tool-calling smoke run。
如果要覆盖模型，请先选支持 Responses API tool calling、`reasoning` 和 `text.verbosity` 参数的 GPT-5.x 模型；这一章还不做 provider/model capability abstraction。

## 运行一次

先 build：

```sh
npm run build
```

再给 CLI 一个任务：

```sh
npm run start -- "inspect this project scaffold and summarize what is implemented"
```

你应该能看到类似这样的 transcript：

```text
[round 1] model=gpt-5.4-mini
[round 1] bash: ls -la
[round 1] tool_result:
status: completed
command: ls -la
exit_code: 0
duration_ms: ...
stdout:
...
stderr:
(empty)

[final]
...
```

不用在意具体回答内容。这里要确认的是，这几件事真的发生了：

- model 生成了 `function_call`。
- harness 在本地执行了 `bash`。
- harness 把 result 作为 `function_call_output` 放回 input history。
- model 根据工具结果给出 final answer。

## 先看 `bash` tool

这一章的 `bash` tool 故意很直接：

```text
bash({ command: string })
```

`cwd` 固定为你运行 CLI 时所在的项目目录。模型不能自己选择 cwd。

子进程不会继承名字明显像 secret 的环境变量，例如 `OPENAI_API_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`。这只是 c01 的最低限度保护，不是完整 secret management。

工具返回给模型的是一段人类可读文本：

```text
status: completed
command: npm run typecheck
exit_code: 0
duration_ms: 1234
stdout:
...
stderr:
...
```

这还不是正式的 `Tool Result` protocol。它只是第一章能看懂、能打印、能回填的结果格式。

## 先挡掉明显危险的命令

`bash` 太强了。即使第一章只是 minimal loop，也不能让它随便执行明显危险的命令。

这里先加一层很浅的 deny list，例如：

- `rm -rf`
- `sudo`
- `mkfs`
- `shutdown`
- `reboot`
- `git reset --hard`
- forced `git clean`

被阻断时，程序不会直接退出，也不会进入 approval。它会把 blocked result 回填给模型：

```text
status: blocked
blocked_reason: sudo is blocked in the minimal loop
```

这不是完整 `Permission Governance`。它只是把问题摆出来：工具一旦能执行，harness 就得介入。

## 为什么有输出上限

`bash` output 会被打印到终端，也会被放回下一轮 model input。

这意味着 raw stdout/stderr 是 model-visible data。不要要求模型打印 secret、token 或本机敏感信息；即使 harness 会 scrub 常见 secret-like env vars，命令输出本身仍然会进入下一轮 input。

如果模型执行了 `cat package-lock.json` 或扫描了大量文件，输出可能一下变得很大。所以这一章对 stdout/stderr 做粗糙截断，并标记：

```text
[truncated 12345 chars]
```

这仍然不是 `Context Projection`，也不是 `Observation`。它只是第一章的 safety valve。真正的问题还在：raw output 还是直接进了下一轮 input。

## 这一章暴露了什么

跑通以后，问题也会跟着冒出来。

第一，CLI transcript 只是 console output。它能帮你看当下发生了什么，但不能 resume、fork 或 replay。后面会因此补上 `Trace` 和 `Session`。

第二，`bash` tool 是 inline 的。现在只有一个工具还可以，一旦多几个工具，就需要 schema、metadata、dispatcher 和 result/error protocol。这就是 `Tool Runtime` 要解决的问题。

第三，deny list 很粗糙。它能挡住明显危险命令，但不能判断真实风险，也没有 approval model。这就是 `Permission Governance` 的入口。

第四，raw stdout/stderr 直接回填。截断只能防爆，不能告诉模型哪些信息重要。所以后面要做 `Observation` 和 `Context Projection`。

第五，模型停止请求工具，不等于任务真的完成。后面还需要 tests、type-check、build 或其他 acceptance checks，也就是 `Verification / Recovery`。

## 进入 c02 前

这一章先带走这些判断：

- `Agent Loop` 已经真实跑起来了。
- 本地 harness 执行工具，而不是 OpenAI hosted shell 执行工具。
- 本地 input history 明确保存 user task、model output 和 `function_call_output`。
- `bash` 的危险和 noisy output 已经出现，但还没有被完整治理。
- 下一章先用 `--show-history` 看清楚 local input history，不急着抽完整 `Tool Runtime`。
