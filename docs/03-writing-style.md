# 写作风格

Forge 的教程写给正在动手的人。它不是宣传页，也不是 API reference。

写作时始终围绕这条链路：

```text
遇到问题 -> 解决方案 -> 最小实现 -> 运行验证 -> 下一步缺口
```

如果一章读完后只让人觉得“这个概念很重要”，但不知道该改哪个文件、跑什么命令、看什么输出，这章通常要重写。

## 语气

像一个工程师在带另一个工程师拆 runtime。

优先用：

- `你`
- `我们`
- `这一章`
- `现在先看`
- `下一步`

少用：

- `读者会理解`
- `本文将`
- `面向用户展示`
- `核心价值在于`
- `为后续奠定基础`

## 章节约束

写一章之前，先列出 `Chapter Contract`。它是作者和 agent 的写作约束，不应默认放进教程正文。

```text
当前状态：读者或系统现在有什么能力，还差哪一步？
当前痛点：继续用当前做法会卡在哪里？
本章产物：这一章结束后新增什么能力？
触达文件：主要新增或修改哪些文件？
可观察结果：运行什么 command，看到什么 output？
暂时不做：哪些 production 机制不进入这一章？
下一步缺口：本章留下的哪个限制会引出下一章？
```

`当前状态` 不一定是“上一章实现了什么”。有时更应该从读者能感受到的缺口开始，比如“模型能提出命令，但不会自己执行，也不会把结果带回下一轮”。章节内容和当前 branch 实现不一致时，先修一致性，再润色句子。

## 章节节奏

默认节奏：

```text
问题
  -> 解决方案
  -> 最小实现
  -> 运行验证
  -> 下一步缺口
```

不是每章都要机械套标题，但这些问题都要回答。

开头优先让读者进入场景。先说明他们现在会怎么手动处理、哪里重复或不可靠，再把这一章的机制作为自然的解决方案拿出来。不要先抛作者视角的章节元数据。

## 用代码暴露问题

解释机制前，尽量先给一个短小的坏例子。

例如讲 `Tool Runtime` 时，不要先定义 registry。先让 loop 里出现这种代码：

```ts
if (toolCall.name === "bash") {
  return runBash(JSON.parse(toolCall.arguments));
}

if (toolCall.name === "read_file") {
  return readFile(JSON.parse(toolCall.arguments));
}
```

然后再说：第三个工具出现后，loop 会继续膨胀，所以 routing 要移出去。

## 代码块附近要交代清楚

每个代码块附近至少回答三件事：

```text
这段代码放在哪个文件？
它改变了哪条数据流？
怎么验证它真的工作了？
```

讲实现时，优先按解决方案的数据流拆成小段代码。比如先讲 user task 怎样进入 `input[]`，再讲 `input + tools` 怎样发给模型，然后讲怎样判断 `function_call`、怎样执行 tool、怎样回填 `function_call_output`。最后再说明这些步骤怎样被外层 loop 包起来。

不要为了显得完整而直接贴整个函数。读者需要看到概念和代码怎样一一对应，不需要在教程里读完所有分支和错误处理。

不要只写“接下来实现 Tool Runtime”。要写清楚当前章节的边界，比如：

```text
先新建 `src/runtime/bash.ts`。这一章的 runtime 只接收 command string，调用本机 shell，然后返回 stdout、stderr 和 exitCode。
```

## 验证点

只要章节涉及代码修改，就给出最小验证方式：

- 运行什么 command
- 预期看到什么 output
- 如果失败，先检查哪里

教程不是让人读完点头。教程要让人做完后看到状态变化。

面向读者的 tutorial 里，验证应该聚焦最小 smoke run 和可观察结果。详细测试覆盖可以放在 PR、commit notes 或维护文档里；除非测试本身就是这一章要讲的机制，不要把 coverage 清单塞进教程正文。

全局环境配置放在 `README.md`。教程章节只链接到 shared setup，再给出本章自己的 command 和 observation。

解释 transcript 或 command output 时，要说清楚结论从哪里来。比如看到 `function_call`，要指出它来自 harness 从 `response.output` 里筛出的 `type === "function_call"`；看到 `tool_result`，要指出它来自本地 tool 执行后的 stdout/stderr/exit code；看到 `[final]`，要指出 loop 走到了没有 tool call 的分支。

## 图和可视化

只在图片能降低理解成本时使用图。图不是装饰，也不是每章必须有。

机制图优先画本章新增的局部路径，不要把后续所有机制都堆进一张不断变大的总图。总图可以单独存在；章节图更像显微镜，只解释这一章新增的那段。

讲代码流或数据流时，可以使用 `Code Trace` 风格：把 `input[]`、`responseCreate({ input, tools })`、`response.output`、`function_call_output` 这类代码概念串起来。这样图和后面的代码片段能一一对应。

条件判断要保留，因为它通常是 loop 的出口或分支点。但不一定要画成传统流程图菱形。对于 `Code Trace` 图，可以直接写成代码式 `if/else`：

```text
toolCalls = filter(function_call)
if toolCalls.length === 0 -> final
else -> run local tool
```

如果一个机制跨多个模块，可以换成 swimlane 或 sequence diagram。不要为了统一风格牺牲可读性。

## 保留 English technical terms

这些词优先保留 English：

- `Agent Loop`
- `Tool Call`
- `Tool Result`
- `Tool Runtime`
- `Permission Governance`
- `Context Projection`
- `Observation`
- `Session`
- `Trace`
- `RuntimeState`
- `Verification`
- `Recovery`
- `ChangeSet`

可以用中文解释，但不要翻译 identifier、filename、command、API name。

## 避免 AI 味

少写：

- 大段价值宣言。
- 重复的“不是 X，而是 Y”。
- 没有例子的“逐步构建”“持续演进”“完整体系”。
- “关键作用”“复杂格局”“核心价值”这类空话。
- 每段都用同一种句式开头。
- 结尾只写“为后续打下基础”。

优先写具体对象和具体动作：

- 哪个文件会改。
- 哪条数据流变了。
- 哪个 command 能跑。
- 哪个 output 说明它工作了。
- 哪个缺口引出下一章。

## `$humanizer-zh`

每次新增、重写或扩展 `docs/tutorial/*.md`，最后跑一遍 `$humanizer-zh`。

处理顺序：

```text
写章节
  -> 查章节约束
  -> 查技术事实、路径和命令
  -> 用 $humanizer-zh 去掉 AI 味
  -> 再查 code block、identifier、command 没有被误改
```

`$humanizer-zh` 只负责改句子，不负责改技术设计。如果章节缺少数据流、命令或实现边界，先重写结构，再润色。

## 审稿清单

提交教程文档前检查：

- 开头是否让读者看到当前问题或能力缺口。
- 是否先讲当前卡点，而不是项目口号或章节元数据。
- 是否有短代码、数据流或 command 说明痛点。
- 是否引用了当前 branch 不存在的 API 或文件。
- 是否重复了 `README.md` 里的共享环境配置。
- 命令是否能在当前 branch 跑。
- 是否说明本章暂时不做什么。
- 是否说明下一步缺口从哪里来。
- 代码讲解是否按概念步骤拆开，而不是整段贴完整函数。
- 图是否真的帮助理解机制，且没有把全课程复杂度提前塞进当前章。
- `docs/tutorial/*.md` 是否做过 `$humanizer-zh` review。
