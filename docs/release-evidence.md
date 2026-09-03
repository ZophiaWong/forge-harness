# Release evidence 采集与发布

这套流程解决一个具体问题：源码、测试、旧的 curated snapshot 都存在，但当前 release commit 未必有一组刚运行、能一路追到 raw attempt 或 Session 的证据。Release claim 因而缺少时间、源码身份和原始材料之间的闭环。

Forge 把证据生命周期单独建模为：

```text
execute -> validate -> preserve raw bundle -> promote evidence
```

行为结果与封存结果是两件事。`PASS`、`FAIL`、`REGRESSED` 等 behavioral verdict 原样保留；`sealed` 或 `failed` 描述 collector 是否成功保存并复验 raw bundle。行为通过但封存失败的运行不能支持 release claim。

本文是维护者 runbook。普通的 `npm run demo:portfolio:live` 仍是一次性演示，`npm run eval -- run` 仍是本地评估；只有通过 `npm run evidence` 预注册、封存、promotion 和下载后复验的运行，才属于 release evidence。

## Fresh 的判定

一组 evidence 只有同时满足以下条件才算 fresh：

- subject 是 clean checkout，`HEAD` 精确等于指定的不可变 tag；manifest 同时记录 tag、commit 和 tree。
- collector 是 clean checkout，并记录独立的 collector commit 和 tree。回补旧版本时，`subjectCommit` 与 `collectorCommit` 可以不同。
- collector 在运行开始、开始封存和封存结束后重新检查源码身份与 clean state；发现漂移就保留 behavioral verdict，但令 capture 失败。
- Eval summary 的 commit 与 preregistered subject commit 相同；每个 attempt/assertion 的 `evidenceRef` 都存在、位于 run root 内，并进入 private inventory 和 archive。
- raw archive、inventory 和所有 public report 都有 SHA-256 与 byte size；archive 内容、逐文件哈希和 public report 可以重新验证。
- promotion selection 符合 intent 中的 first-run/no-resampling policy。

这些检查能证明采集前后的 Git 状态和已发布字节一致，不能证明 signer identity，也不能发现一次在检查间发生、随后被完全还原的瞬时源码修改。v1 只使用不可变 tag、Git identity 和 SHA-256，不包含签名、SLSA 或第三方 attestation。

## 统一命令

```text
npm run evidence -- prepare --subject <checkout> --ref <tag> --mode <observation|regression>
npm run evidence -- live --intent <intent.json>
npm run evidence -- eval --intent <intent.json> --role <observation|baseline|candidate> ...
npm run evidence -- promote --intent <intent.json>
npm run evidence -- verify --manifest <manifest.json> --archive <archive.tgz> ...
```

`prepare` 会把 endpoint 写成 SHA-256，只公开 provider/model identity，不保存 endpoint 原文或凭据。默认 identity 是 `my-gateway/gpt-5.4-mini`；维护者应显式保持下列变量与 intent 一致：

```bash
export EVIDENCE_PROVIDER_ID=my-gateway
export EVIDENCE_MODEL=gpt-5.4-mini
export OPENAI_MODEL=gpt-5.4-mini
export OPENAI_BASE_URL=https://your-compatible-endpoint.example/v1
export OPENAI_API_KEY=...
```

不要把真实值写进仓库或命令记录。使用默认 OpenAI endpoint 时，可不设置 `OPENAI_BASE_URL`。Live subject 仍读取 `OPENAI_MODEL`；Eval collector 使用 intent 中预注册的 model。

## 产物边界

每次运行写入 intent 目录下的 `runs/<evidence-run-id>/`：

```text
runs/<evidence-run-id>/
├── capture-result.json
├── public/
│   ├── manifest.json
│   └── report files
└── private/
    ├── inventory.json
    └── <evidence-run-id>.tgz
```

`capture-result.json` 分别记录 behavioral verdict、capture status、infrastructure validity、baseline eligibility 和 promotion eligibility。Public manifest 只包含来源身份、结果、限制、report hash 及 private archive 的名称、大小和 SHA-256；它不包含 prompt、model output、raw tool arguments、绝对路径或 checkout path。

Private archive 保留原始字节。Live 包括 Session、Trace、TaskGraph、fixture 输入、初始/最终测试记录和可移植 Git bundle；Eval 包括完整 subject run root、所有 attempt evidence 和 subject 原始 report。Raw 内容可能很敏感，只能进入维护者私有存储。Collector 会拒绝 symlink、path escape 和常见 credential 文件名，但这不是内容级 secret scanner。

在 build 或模型调用前，collector 还会以原子、不可覆盖的文件写入
`reservations/<kind>/<role>/<original|retry>.json`。因此即使进程在生成
`capture-result.json` 前崩溃，已经开始的 attempt 也不会从 first-run selection 中消失。
下一次运行必须用 `--retry-of` 指向该 orphan reservation；collector 会把原 attempt
登记为 `capture_interrupted`，保留其 staging，并占用该角色唯一的 retry 名额。
新 subject 会把 validator 实际消费的 command completion 暴露给 collector，作为 Live
初始测试的 raw output。旧版本（包括 `v1.0.0`）没有这个 seam，因此 backfill 会在
subject validator 完成后，对隔离的 fixture snapshot 采集一次明确标注为
non-authoritative 的 collector replay。无论 replay 失败还是与 validator 不一致，它
都只会令 capture 失败，不会改变或阻断 subject 的行为判定。

`promote` 原子生成：

```text
promotion/
├── public/
│   ├── release-manifest.json
│   ├── <evidence-run-id>-manifest.json
│   └── <evidence-run-id>-<report-name>
└── private/
    ├── <evidence-run-id>.tgz
    └── <evidence-run-id>-inventory.json
```

如果某次 capture 本身失败，Release manifest 会保留其 run ID、behavioral verdict、reason code 和 retry 关系，但不会把未封存 staging 伪装成 archive。后续成功 retry 的 manifest 仍通过 `retryOf` 指向该记录。

公开资产发布到对应 GitHub Release。Private archive 和 inventory 发布到维护者私有 companion repository `ZophiaWong/forge-harness-evidence`。GitHub Actions artifact 只用于短期排障，不是长期 raw evidence 存储。

## 回补冻结的 v1.0.0

不得移动 `v1.0.0` tag。使用两个 clean checkout：一个停在 `v1.0.0`，另一个停在含 collector 的已提交 commit。先在旧 checkout 安装依赖并构建；`node_modules/` 与 `dist/` 必须保持 Git ignored。

在 collector checkout 中预注册 observation intent：

```bash
npm run evidence -- prepare \
  --subject /absolute/path/to/v1.0.0-worktree \
  --ref v1.0.0 \
  --mode observation \
  --output .forge/evidence/v1.0.0-backfill/intent.json
```

然后按顺序运行第一组 Live 和唯一一组 13-attempt observational Eval：

```bash
npm run evidence -- live \
  --intent .forge/evidence/v1.0.0-backfill/intent.json

npm run evidence -- eval \
  --intent .forge/evidence/v1.0.0-backfill/intent.json \
  --role observation
```

Live collector 调用旧 tag 自己的 runner 和 validator，并在旧 runner 删除 disposable fixture 前复制证据。Eval collector 调用旧 tag 自己的 suite 和 grader。`v1.0.0` 会读取仓库内的 legacy baseline，因此它的 subject report 原样留在 private archive；对外公开的 observation report 由 collector 从同一份 subject summary 派生为 `NO_BASELINE`，不会把这次回补说成 regression baseline。

第一组 Live 无论 `PASS` 或 behavioral `FAIL` 都必须保留。完整 observational Eval 即使含普通失败或 hard violation 也如实报告；不得为了更好结果重采样。如果 hard violation 令旧 suite 提前停止，promotion 会因不满 13 attempts 而拒绝，此时 release acceptance 未满足，也不能偷偷重跑。

两组都符合 selection 条件后执行：

```bash
npm run evidence -- promote \
  --intent .forge/evidence/v1.0.0-backfill/intent.json
```

## v1.0.1 baseline 与 candidate

只有在机制、文档和 deterministic verification 完成，并得到明确授权后，才能创建不可变 `v1.0.1` tag。随后在 clean `v1.0.1` checkout 中准备 regression intent：

```bash
npm run evidence -- prepare \
  --subject . \
  --ref v1.0.1 \
  --mode regression \
  --output .forge/evidence/v1.0.1/intent.json
```

先采第一组 Live，再采第一组 baseline：

```bash
npm run evidence -- live \
  --intent .forge/evidence/v1.0.1/intent.json

npm run evidence -- eval \
  --intent .forge/evidence/v1.0.1/intent.json \
  --role baseline
```

只有 baseline 同时满足 full canonical 13 attempts、`valid=true`、无 infrastructure failure、无 hard violation、无 unavailable assertion/outcome 时，collector 才生成 `public/baseline.json`。记下 CLI 输出的 baseline evidence run ID，然后运行唯一一组独立 candidate：

```bash
npm run evidence -- eval \
  --intent .forge/evidence/v1.0.1/intent.json \
  --role candidate \
  --baseline .forge/evidence/v1.0.1/runs/<baseline-evidence-run-id>/public/baseline.json
```

Candidate 只能读取同一 intent 下、archive 和 public report 均已复验的外部 baseline。Repository-local implicit baseline 不参与该比较；identity 不兼容的 candidate 会被封存为 infrastructure-invalid、禁止 promotion，并返回 exit code `2`。

只有完整 13 attempts、canonical、已封存且 infrastructure-valid 的 baseline 因 hard
violation 不 eligible 时，才保留该 sample、停止 candidate，并 promotion 一份透明的
blocked release evidence。Infrastructure-invalid 或无 hard violation 的 `valid=false`
运行必须先遵循下方唯一一次 linked retry；retry 仍失败则停止发布。不满 13 attempts
则直接停止 release acceptance 与 promotion。普通 outcome failure 仍是 valid
observation：它必须原样保留在 eligible baseline 中，并继续运行唯一 candidate，不能
以结果不理想为由重采样。如果 candidate 为 `REGRESSED`，同样保留并发布，不得重跑
以获取绿色结果。

## 重试规则

只有 infrastructure-invalid 且 `promotionEligible=false` 的运行可以重试，并且必须显式关联原 run：

```bash
npm run evidence -- eval \
  --intent <intent.json> \
  --role <role> \
  --retry-of <original-evidence-run-id>
```

Live 使用相同的 `--retry-of`。每个角色最多只有一次 linked retry，且 retry
必须直接指向最初 preregistered run；retry 本身不能再次重试。允许的 retry
仍然 invalid 时，流程暂停。原 capture-result、raw archive 或保留下来的 staging
不能删除。普通行为失败、hard violation、`REGRESSED`、或仅仅“结果不够好”都不是重试理由。

## 发布、下载与复验

创建 tag、GitHub Release、私有仓库以及上传资产都是外部 mutation，必须分别获得明确授权。上传建议保持如下对应关系：

- public GitHub Release：`promotion/public/` 的完整内容；
- private companion Release：`promotion/private/` 的完整内容；
- Release notes：明确 `subjectCommit`、`collectorCommit`、behavioral verdict、capture status、限制及 private archive SHA-256，不粘贴 raw 内容。

上传完成后，从两个 Release 重新下载资产到新的目录。不要直接验证上传前的本地副本。对每个 archive 重复 `--archive`：

```bash
npm run evidence -- verify \
  --manifest /downloaded/public/release-manifest.json \
  --archive /downloaded/private/<live-run>.tgz \
  --archive /downloaded/private/<eval-run>.tgz
```

每个 `<run-id>-inventory.json` 必须与对应 archive 放在同一 downloaded private 目录。CLI 会用 Release manifest 中的 inventory SHA-256 校验它，并确认其字节与 archive 内的 `inventory.json` 完全相同。

Regression release 如果含 candidate 或 infrastructure retry，要把 manifest 列出的每个 archive 都传入。下载复验不仅重算 archive、inventory、逐文件和 report hash，也会重新检查该模式所需的 Live/Eval 角色、完整 13-attempt batch、baseline/candidate gate 和单次 retry 关系。只有命令报告全部 run verified 后，才可以另行请求 destructive-action 授权；本轮执行不清理 `.forge/evidence`、`.forge/evals`、`.forge/sessions`、collector staging、worktree、下载副本或临时 archive。

## 发布验收

`v1.0.0` 的 Release 至少需要一组 Live 和一组完整 observational 13-attempt Eval。`v1.0.1` 至少需要一组 Live 和一组 baseline sample；只有 baseline eligible 时才必须有一组独立 candidate。每份 public manifest 都必须精确绑定 tag、subject commit/tree/clean state、collector commit/tree/clean state、provider/model/endpoint hash，以及 archive SHA-256。

仓库中的实现、测试或旧 curated snapshot 本身不等于上述 release evidence。某个版本是否已经完成闭环，以该版本 GitHub Release 中可下载并能通过 `npm run evidence -- verify` 的 manifest/assets 为准。
