# c11 System Prompt / Skills / Memory

c10 之后，较长任务已经有了结构化 `TaskState`。模型可以用 `todo` 提交 plan、progress 和 acceptance，harness 会把它们写进 trace、`RuntimeState` 和下一轮 context projection。

还有一处上下文入口没整理好：system prompt 还是写死在 `runMinimalLoop` 里。模型为什么知道要优先用 `grep` / `read`？为什么知道多步骤任务要维护 `todo`？项目里的课程规则、写作习惯、可复用技能又从哪里来？

c11 把这段硬编码拆成一个最小的 prompt assembly pipeline。它从 repo 里读取 project memory 和 skill catalog，再按固定顺序组装成模型的 `instructions`。

## 问题

当前的 `runMinimalLoop` 里有一段固定 instructions：

```ts
const SYSTEM_INSTRUCTIONS = [
  "You are running inside a minimal coding-agent loop.",
  "You may call tools to inspect the local project.",
  "For multi-step tasks, use todo to track the current plan...",
].join("\n");
```

这在早期章节够用，因为当时只有一个 loop 和几条工具规则。到了 c11，它开始暴露三个问题。

第一，project knowledge 没有正规入口。Forge 的章节结构、layer 名称、教程写法现在散在 `README.md`、`AGENTS.md` 和 `docs/` 里。用户如果希望模型遵守这些规则，只能在 prompt 里重复提醒。

第二，skills 不能复用。比如“写教程章节”和“汇报 verification 结果”是两类稳定做法，但现在它们只能被写进一个越来越长的 system prompt。

第三，prompt 没有证据。trace 记录了 model request 的 input item 数量和 tool names，但看不出这轮 request 使用了哪些 prompt sections、有没有加载 project memory、有没有选中某个 skill。

c11 真正要处理的不是“system prompt 字符串写得不够漂亮”，而是 instruction、project memory 和 skills 没有可解释、可验证的入口。

## 解决方案

c11 新增 `PromptAssembly`。

它把模型 instructions 拆成几类 section：

```text
base_instructions
tool_rules
project_memory
skill_catalog
selected_skills
```

这些 section 按 scope 从宽到窄排列。先是 harness 自己的运行规则，再是项目长期记忆，然后是可用 skill catalog，最后才是本次任务显式选中的 skill body。

repo 里新增几份 tracked prompt assets：

```text
.forge/memory.md
.forge/skills/tutorial-writing/SKILL.md
.forge/skills/verification-reporting/SKILL.md
.forge/skills/chapter-handoff/SKILL.md
```

`.forge/memory.md` 是项目长期上下文。它不是 trace，也不是会自动学习的记忆数据库，只是一份 repo 内的稳定规则摘要。

`SKILL.md` 使用最小 frontmatter：

```md
---
description: Use when writing or revising Forge Harness tutorial chapters.
---

# Tutorial Writing

- Write reader-facing tutorial docs in Chinese.
- Keep identifiers, paths, commands, APIs, and precise technical terms in English.
```

c11 只解析 `description`。目录名就是 skill id，比如 `tutorial-writing`。`description` 用来组成 catalog；正文只有在用户用 leading slash 显式调用时才进入 prompt。

例如用户 task 是：

```text
/chapter-handoff /verification-reporting Explain what c10 leaves for c11.
```

harness 会识别开头连续的已知 skill：

```text
selectedSkillIds = ["chapter-handoff", "verification-reporting"]
model user task = "Explain what c10 leaves for c11."
```

这里有一个刻意限制：c11 只解析 task 开头的 slash skills。它不会在句子中间扫描 `/skill`，也不会处理 code span、escape 或 Markdown fenced code。那些属于更完整的 command parser，不是本章要加的机制。

每轮 model request 前，loop 还会 emit 一条 `prompt_assembled` event：

```ts
{
  type: "prompt_assembled",
  round,
  sectionNames,
  instructionCharCount,
  catalogSkillIds,
  selectedSkillIds,
}
```

这条 event 只记录摘要，不写完整 prompt。完整 memory 和 skill body 不应该被原样复制进 trace。

## 最小实现

c11 的实现顺序是：

```text
1. 添加 tracked .forge prompt assets
2. 新增 PromptAssembly loader 和 assembler
3. 在 runMinimalLoop 里使用 assembled instructions
4. 在 model_request 前 emit prompt_assembled
5. CLI 打印 compact prompt summary
```

### 1. `.forge` 同时有 runtime state 和 prompt assets

c06 已经把 session trace 放在 `.forge/sessions/`。这些是本地运行状态，继续被 `.gitignore` 忽略。

c11 让 `.forge/memory.md` 和 `.forge/skills/**/SKILL.md` 成为 tracked course artifacts。它们不是运行输出，而是 prompt input。

`.gitignore` 的边界因此变成：

```text
.forge/sessions/       # local runtime state
.forge/memory.md       # tracked prompt asset
.forge/skills/**       # tracked prompt assets
```

### 2. loader 读取 memory 和 skill catalog

loader 从当前 `cwd` 读取 `.forge/memory.md` 和 `.forge/skills/<id>/SKILL.md`。

缺少 memory 或 skills 目录时，它返回空 assets。这样，harness 在没有 project prompt files 的目录里也能继续运行。

但如果一个存在的 skill 文件格式坏了，loader 会 fail fast。比如 `SKILL.md` 没有包含 `description` frontmatter，这不是“没有配置”，而是“配置写坏了”。

### 3. assembler 生成最终 instructions

assembler 接收 repo assets 和原始 task：

```ts
const promptAssembly = assemblePrompt({
  assets: promptAssets,
  task: options.task,
});
```

它返回三样东西：

```ts
{
  instructions,
  task,
  summary,
}
```

`instructions` 交给 Responses API。`task` 是 strip 过 leading slash skills 的 user message。`summary` 用来写 trace 和 CLI transcript。

### 4. loop 不再拥有 system prompt 字符串

`runMinimalLoop` 原来把固定 `SYSTEM_INSTRUCTIONS` 传给模型。c11 后，loop 只使用 assembly 结果：

```ts
const response = await responseCreate({
  input,
  instructions: promptAssembly.instructions,
  tools: toolDefinitions,
  // ...
});
```

core loop 因此少知道一点 prompt 细节。它仍然推进 turn、执行 tools、emit lifecycle events；prompt section 的来源交给 `src/context/`。

### 5. prompt assembly 有可见证据

每轮 request 前，CLI 会打印一行：

```text
[round 1] prompt: sections=base_instructions,tool_rules,project_memory,skill_catalog,selected_skills catalogSkills=3 selectedSkills=chapter-handoff,verification-reporting chars=1442
```

这行只说明 prompt 由哪些 section 组成、catalog 有几个 skills、本轮选中了哪些 skills、总字符数是多少。它不会打印完整 memory 或 skill body。

trace 里也会有对应事件：

```json
{"type":"prompt_assembled","round":1,"sectionNames":["base_instructions","tool_rules","project_memory","skill_catalog","selected_skills"],"instructionCharCount":1442,"catalogSkillIds":["chapter-handoff","tutorial-writing","verification-reporting"],"selectedSkillIds":["chapter-handoff","verification-reporting"]}
```

`RuntimeState` 不投影这条 event。当前 state 继续回答“任务做到哪一步、最后一个 tool 是什么、verification 怎样了”。prompt assembly 是 model input 的证据，留在 trace 和 transcript 里就够了。

## 运行验证

开始前，先按 [README](../../README.md#setup) 完成依赖安装和 `.env` 配置。

先 build 一次，让 `npm run start` 使用最新的 `dist/`：

```bash
npm run build
```

然后运行一条不改文件的 smoke command：

```bash
npm run start -- "/chapter-handoff /verification-reporting Explain in one sentence what c10 leaves for c11. Do not edit files."
```

你应该先看到 session line：

```text
[session] id=${session_id} trace=.forge/sessions/${session_id}/trace.jsonl
```

接着在第一轮看到 prompt summary：

```text
[round 1] prompt: sections=base_instructions,tool_rules,project_memory,skill_catalog,selected_skills catalogSkills=3 selectedSkills=chapter-handoff,verification-reporting chars=...
```

这里要看三点：

- `catalogSkills=3` 说明 harness 发现了三个 tracked skills。
- `selectedSkills=chapter-handoff,verification-reporting` 说明只有开头 slash 点名的 skill body 进入 prompt。
- `selected_skills` 出现在 sections 里，说明本轮确实有 selected skill body。

如果不用 slash skill：

```bash
npm run start -- "Explain in one sentence what c10 leaves for c11. Do not edit files."
```

prompt summary 应该仍然有 memory 和 catalog，但 selected skills 为空：

```text
selectedSkills=none
```

如果开头是未知 slash：

```bash
npm run start -- "/not-a-skill Explain in one sentence what c10 leaves for c11. Do not edit files."
```

c11 不会把它当作 skill invocation。`selectedSkills=none`，原始 `/not-a-skill` 会保留在 user task 里。

最后可以打开 trace 检查 `prompt_assembled`：

```bash
grep '"prompt_assembled"' .forge/sessions/${session_id}/trace.jsonl
```

这条 trace event 是本章最稳定的验证点。模型最终回答的措辞会变，但 prompt assembly summary 应该稳定出现。

## 下一步缺口

c11 不做 auto skill router。Skill catalog 会进入 prompt，但 skill body 只有在用户用 leading slash 显式调用时才加载。以后如果要自动选择 skill，需要设计 selection policy、误选处理和可解释的 debug 证据。

c11 也不做 prompt hook。`prompt_assembled` 是证据 event，不是拦截点。c09 的 hooks 仍然是 observe-only，不能修改 prompt、tool input 或 tool output。

c11 不做 context compaction。现在 memory、catalog 和 selected skills 都会进入 instructions。skill 多了以后，prompt 会变长。下一章 c12 会处理 context budget 和 compaction。

最后，`.forge/memory.md` 不是会自动学习的长期数据库。它是 tracked repo file。自动写入、合并、冲突处理和审计都不在本章。
