# 写作风格

Forge 的教程写给正在动手的人。它不是宣传页，也不是 API reference。

写作时始终围绕这条链路：

```text
已经有什么 -> 卡在哪里 -> 加什么机制 -> 改什么代码 -> 怎么验证 -> 留下什么问题
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

写一章之前，先列出 `Chapter Contract`。正文不一定完整展示，但作者和 agent 必须知道答案。

```text
前置状态：上一章结束后，项目已经有什么能力？
当前痛点：继续使用上一章实现会卡在哪里？
本章产物：这一章结束后新增什么能力？
触达文件：主要新增或修改哪些文件？
可观察结果：运行什么 command，看到什么 output？
暂时不做：哪些 production 机制不进入这一章？
下一章入口：本章留下的哪个限制会引出下一章？
```

这个 contract 是写作约束，不是装饰。章节内容和当前 branch 实现不一致时，先修一致性，再润色句子。

## 章节节奏

默认节奏：

```text
接住上一章
  -> 说明当前卡点
  -> 看最小数据流或坏例子
  -> 定义本章机制
  -> 写代码
  -> 运行验证
  -> 留下下一章压力
```

不是每章都要机械套标题，但这些问题都要回答。

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
- 哪个痛点逼出下一章。

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

- 开头是否接住上一章。
- 是否先讲当前卡点，而不是项目口号。
- 是否有短代码、数据流或 command 说明痛点。
- 是否引用了当前 branch 不存在的 API 或文件。
- 命令是否能在当前 branch 跑。
- 是否说明本章暂时不做什么。
- 是否说明下一章的压力从哪里来。
- `docs/tutorial/*.md` 是否做过 `$humanizer-zh` review。
