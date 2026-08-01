# Methodology

## 1. Research question before mechanism

每个主题先写出迫使机制存在的具体痛点，再追踪实现。当前总痛点是：Forge 已实现到 `c17c`，但还缺少一套能用可定位证据解释 runtime ownership、invariants、failure semantics 与设计取舍的材料。

研究不以功能数量为单位，而以六类 runtime responsibility 为单位：

```text
Control       持续执行、暂停、恢复和结束
Action        模型输出到真实副作用的确定性边界
Context       下一轮模型可见信息的投影
Continuity    history、runtime、workspace 和恢复的关系
Coordination  多个执行单元的分工、通信、验收和交付
Governance    动作、扩展和执行过程的最终授权
```

## 2. Evidence labels

| 标签 | 含义 | 可支持的结论 |
| --- | --- | --- |
| `[CODE]` | 当前 snapshot 中的实现 | 数据结构、分支、调用链和显式检查 |
| `[TEST]` | 当前 snapshot 中的 test | public contract、invariant 与 failure path |
| `[RUN]` | 本地 deterministic run | 该环境、该命令下的 observable behavior |
| `[DOC]` | 项目自身文档 | 公开意图、使用方式或声明；不能覆盖相反的 code/test |
| `[HISTORY]` | commit、show 或 blame | 机制演进及当时显式写下的设计理由 |
| `[INF]` | 从以上证据推导的判断 | 必须写出推断边界，不能伪装成实现事实 |

本地源码引用格式：

```text
[CODE][Claude@430502e:path/to/file.ts:L12-L48]
[TEST][Pi@977ec833:path/to/file.test.ts:L20-L76]
[CODE][Forge@75714f2:src/runtime/example.ts:L8-L35]
```

行号绑定 [SOURCES](SOURCES.md) 中的 commit。研究时使用 `nl -ba` 重新核对范围；文章不写本机绝对路径。引用只覆盖支撑论点的最小范围。

## 3. Evidence order and triangulation

证据优先级为：

```text
current code and tests
→ deterministic local behavior
→ current project documentation
→ historical design material
→ explicit inference
```

每个主题先定位实现入口和数据结构，再读正常路径与 failure-path tests，最后总结 invariant。重要比较结论尽可能由两种证据支持。只有单一来源时降低 confidence；文档与代码冲突时同时记录，不挑选更符合预期的一方。

Claude 本地快照的 provenance 较弱。generated、bundled 或 minified source 先通过 source map、uncompressed module、types、tests 和调用关系交叉定位；无法稳定定位时引用 file + symbol，并声明限制。不根据一个压缩变量名推导完整行为。

## 4. Ownership analysis

每个机制都回答七个问题：

1. 谁创建？
2. 谁修改？
3. 谁持久化？
4. 谁消费？
5. 谁能结束？
6. 谁处理失败？
7. 谁拥有最终决定权？

比较表优先呈现 ownership、state transition、failure semantics 和 trade-off，不做打分。

## 5. State and guarantee boundaries

文章不得混用以下对象：

- `Session History`：已经发生的对话和事件。
- `Runtime State`：当前 run 的决策 projection。
- `Model Context`：下一次 provider request 实际包含的信息。
- `Workspace State`：文件系统、Git、进程和外部副作用。

也不得把 `Mechanism`、`Policy` 与 `Product behavior` 相互代替。Pi core 没有内建权限系统，不代表 host 或 extension 无法增加权限；Claude UI 行为存在，也不自动证明它属于底层 loop primitive。

## 6. Confidence rubric

| Confidence | 判定 |
| --- | --- |
| High | code 与 test 或 deterministic run 共同支持，且引用范围直接命中论点 |
| Medium | 只有 code、test、doc 或有限 run 支持，或 Claude provenance 限制交叉验证 |
| Unknown | 当前本地材料无法证明；文章只保留明确的 evidence gap 或可执行实验协议 |

`Unknown` 不是待填 placeholder。它说明证据边界，并禁止把预期行为写成事实。

## 7. Deterministic experiments

实验优先复用现有 tests、fixtures 和 mocks。每条运行记录包含：

```text
Experiment ID
Research question
Repository and commit
Command
Preconditions
Expected observation
Actual observation
Artifacts
Limitations
Conclusion
```

不使用真实 API key，不发起付费请求，不改第三方 tracked source，不触碰真实用户文件。需要账户、外部服务或无法满足前置条件的实验标为 `Not executed`，只保留精确 protocol。

## 8. Safety and review

- Claude 与 Pi 仓库只读。
- Forge 只修改 `docs/design-studies/` 和根 README 的简短入口。
- 不实现 `c18`，不修改 runtime、CLI 或 tests。
- 不 reset、clean、stash、覆盖或删除用户已有修改。
- 不 push、release 或创建远程 PR。
- 最终执行 citation existence、relative link、Mermaid fence、placeholder、terminology、`git diff --check` 与 repository-safety review。
