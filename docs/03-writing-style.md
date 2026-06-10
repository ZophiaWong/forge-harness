# 写作风格

Forge 的教程写给正在动手的人。

不要把章节写成宣传文案、架构宣言或 API reference。先说当前遇到的问题，再写解决这个问题需要的代码。

## 基本语气

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

写法要像一个工程师在带另一个工程师拆 runtime。

## 每章结构

默认节奏：

```text
问题是什么
  -> 天真的代码会怎样变坏
  -> 新机制解决什么
  -> 这一章实现什么
  -> 暂时不实现什么
  -> 怎么运行和验证
  -> 下一章为什么需要继续
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

## 保留 English technical terms

这些词保留 English：

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

少写这些句子：

- 大段价值宣言。
- 重复的"不是 X，而是 Y"。
- 没有例子的"逐步构建"。
- "关键作用"、"复杂格局"、"持续演进"这类空话。
- 每段都用同一种句式开头。

优先写具体对象和具体动作：

- 哪个文件会改。
- 哪条数据流变了。
- 哪个 command 能跑。
- 哪个痛点逼出下一章。

## `$humanizer-zh`

每次新增、重写或扩展 `docs/tutorial/*.md`，最后跑一遍 `$humanizer-zh`。

处理顺序：

```text
写章节
  -> 查技术事实、路径和命令
  -> 用 $humanizer-zh 去掉 AI 味
  -> 再查 code block、identifier、command 没有被误改
```

`$humanizer-zh` 只负责改句子，不负责改技术设计。

## Review checklist

提交教程文档前检查：

- 开头是不是先讲当章问题，而不是项目口号。
- 有没有短代码或数据流说明痛点。
- 有没有引用当前 branch 不存在的 API 或文件。
- 命令能不能在当前 branch 跑。
- 章节有没有说清楚暂时不做什么。
- 是否说明下一章的压力从哪里来。
- `docs/tutorial/*.md` 是否已经做过 `$humanizer-zh` review。
