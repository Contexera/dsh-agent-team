# Team 性能：账本增长、提交校验、读路径

## Status

closed 2026-09-14 — 01–06 已落地并逐票独立验收通过；最终 tip **`564c7de`**（`fix: wake a surface for a change it missed while it had no poll`，落在 `a84aada` = `805273b` + 注释/文档压缩 amend 之上；把本目录从 `active/` 移入 `archive/2026-09/` 的那次 amend 只动 `.scratch/**`，不改代码树）。最终门禁：`npm run test:browser` 绿（1 passed / 38.4s）、`npm test` 585 passed / 1 skipped、build/typecheck/lint 全绿（CHANGELOG 与 `docs/architecture.md` 双语同步）。**07（Session fold 增量）未实施**，其 ticket 随本工作项归档，作为未完成历史保留（claim 另议）。以下为归档时的历史状态。

active — 整体调研已收敛；Phase 1 的 **01–06 已落地并逐票独立验收通过**，并 squash 成本地 master 单 commit **`805273b`**（`perf: cut ledger replay, read, and Thread render costs`；旧分片 sha 只在 reflog，**未推**）；只有 07 未开工（claim 已开、未落一行代码，另行 release）。**06 最终 tip 验收**：Vera 探针 7/7 绿（父提交同文件 2 红）、Tars 探针 2/2 绿、`npm test` 577 passed / 1 skipped、typecheck/lint 绿、`git diff e38c6be 805273b` 证明 Host 侧逐字节未动（详见 [`issues/06`](issues/06-client-render-isolation.md)、[`findings.md`](materials/phase0/findings.md) §3h）。**⚠️ 红 lane 已二分收敛到单提交 `76d0148`（03）**：`423c234` 绿、`8dabaa3`（A+01+02）绿、`76d0148`（+03）红、`e38c6be`/`805273b` 红；分割实验（只把客户端 `team-changes.ts` 回退到 `8dabaa3`）**仍红** ⇒ 元凶在 Host 侧；根因（Tars 插桩实测）= Thread 页卸载窗口里的那次 commit 被重挂载后的**静默探针**当成基线（`afterVersion:0` 拿到提交后的域值），此后永不被唤醒。修复实施中；**lane 绿之前不推**（CI 不跑这条 lane，见 CI 覆盖边界）。05 的 drain 合并仍未动（等口径）。本目录不是实现权威；当前行为以 `packages/` 和测试为准。整体判断和分阶段方案见 [`spec.md`](spec.md)。

last-checked: 2026-09-14。

## Current frontier

- **A 已合本地 master** `2b8b62b`（`perf: defer the invariant ledger replay off the commit call`）。human 重启 `dsh web --profile web-dev` 后体感验收。未推 GitHub。
- **整体审计已收敛**：当前主因是胖 `team/thread-read` 记录、全量 replay 重复计算、Agent Session fold 和 Client 整页重渲染的叠加，不是单一 Thread Remote。
- **Phase 0 量测完成**（Vera）：六项全部有真实装配数字 —— ①启动分解 + 校验规模曲线、②read 放大（含未读积压 × 11.7k 账本）、③浏览器感知（真 Web + 12k 账本）、④Session fold、⑤Client render（Thread 页）、⑥changes 版本。原始输出与踩坑见 [`materials/phase0/findings.md`](materials/phase0/findings.md)。
- **Phase 0 结论要点**：启动 88% 花在记录级全量校验、校验超线性（0.033 → 0.065 ms/record）；一次空读仍落盘并触发 ≈0.78 s 重放；400 条未读 drain 墙钟 ≈13.75 s、几乎全是逐轮重放；打字让整条时间线按消息数 1:1 重渲染；真浏览器里打开 Thread 要 763 ms，其中 659 ms 是重放（响应本身 11 ms 就回来了）。
- **01 已落地并验收**：`d94fa64`（启动复用构造期校验）。invariant-on 启动 `fullReplays` 2 → 1，boot 2,488/2,384/2,175 → 1,595/1,476/1,635 ms（父提交 `2b8b62b` 同小时对照）；五臂对抗探针全绿（复用是活的、提交过必回落全量、一次性、启动期 fail-closed 未丢、账本外改写只把检测推迟到下一次提交）。证据见 [`materials/phase0/findings.md`](materials/phase0/findings.md) §1b。票 02 实施中。
- **02 已落地并验收**：`8dabaa3`（无进展的读不落盘）。已读完的 thread 再读：operations/`changeVersion`/事件/延后重放全为 **0**（改前 +1/+1/1 次/834 ms）；有未读仍落盘；同 requestId 重试不写第二条；真重启后水位不丢。离线复算：冻结件 7,079 条读里 36.8% 是空 delta（8.1 MB = 账本 21.2%）。证据见 [`materials/phase0/findings.md`](materials/phase0/findings.md) §3b。03 实施中。
- **03 已落地并验收**：`76d0148`（projection / presence 版本分域）。一次**有进度**的私有读仍落盘，却不再推走任何游标：版本推进 +1 → **0**、10 个 stale 客户端立即应答 10/10 → **0/10**、超时返回的版本 27≠26 → **11694 == 11694**；Client 改为「有差异即重新锚定」，兜住跨域与跨重启游标。Vera 独立探针（`zz-p0-version.spec.ts`，同文件两档）逐条复验通过，含跨 scope / 跨域 fail-safe 与重启单调性（11699 → 11699）；启动成本未回退（`fullReplays` 仍 1），包内回归 566 passed / 1 skipped。游标域合同进 [`spec.md`](spec.md) §5.4，数字见 [`materials/phase0/findings.md`](materials/phase0/findings.md) §6b/§6c。下一步 04。
- **04 已落地并验收**：`06569e6`（瘦 `team/thread-read` 记录）。新写入只存 **6 键 receipt** `{ workspaceId, memberId, threadRef, taskRef?, readThroughSequence, inbox }`（`attention` / `remainingUnreadCount` 是投影派生字段，不再落盘）；旧胖记录保留为 `AgentTeamThreadReadSnapshot`，只读 normalize + 校验、**永不重写**，domain version 保持 1，一个 strict union 接受两形。重试 = **原 receipt + 当前投影现算的画面**。冻结件反事实（`materials/phase0/slim-ledger.py`，`--audit` 零违规）：账本 UTF-8 字节 46,166,788 → **16,610,852（−64.0%）**、读 mean 5,069 → **894 B**、`validate` 中位 796.9 → **466.7 ms**、每翻倍 **2.56× → 2.31×**、读记录自己的规则校验 **567.4 → 260.2 ms（−54%）**、boot 1,917.2 → **1,190.1 ms**（重放 843.0 → 512.0 ms）；冻结件上追加一条真读 = **恰好 6 键 / 1,155 B**、重放持平（④ 的证明）。**残余超线性两条曲线都在**（`thread-replied` 0.0139 → 0.0482 ms/record）⇒ 归 05。**Vera 独立验收通过**（同会话前后档：读记录自己的规则校验 0.0678 → **0.0340 ms/次**、整趟 855.3 → 520.6 ms、每翻倍指数 1.565 → 1.357、boot 组装 1,856.0 → **932.0 ms**；按 kind 拆收益只落在 `thread-read`；对抗臂 7/7，含九条篡改全红与 4i 删 `taskRef`；包内回归 573 passed / 1 skipped、typecheck 绿）。票面 ⑥ **04 达不到**（web 账本 0 条读记录；762.9 → 108.5 ms 是 02 的功劳）保持未勾。证据见 [`materials/phase0/findings.md`](materials/phase0/findings.md) §3c/§3d。
- **05 两片已落地并验收**（Tars 落地 2026-09-13 23:4x，Vera 独立验收 23:5x **通过**）。**第一片 `956011a`**（读路径去克隆）：`prepareReadFrom` 里为算 `remainingUnreadCount` 而整体克隆 `attention` / `directMarkers` / `activityMarkers` + 四个派生索引的那段假设投影已删除，改为 `remainingUnreadAfter(projection, memberId, receipt)`（post-delta 状态 = receipt 自己派生的 attention 行 + 该 reader 在该 Thread 的 marker 键集），单次读分配 O(全部 marker) → O(该 Thread fact 数)；`firstRead` 背景快照改走 `factsByThread`。**第二片 `e38c6be`**（校验路径 ref 索引）：`Projection.messages` 数组删除，换 `messagesByRef` 与 `factsByThread` 在同一次 append 维护；`validateInboxDelta` 的三份全量复制（`[...messages]` / `orderedFacts.filter(activity)` / `new Set([...threads.keys()])`）与每个 marker 的整份数组 `.find` 全部消失，成员测试改 `has`；活动 marker 那支经变异臂证明投影侧索引不可判（死状态）、已删——Vera 在真实 11.7k 账本上插桩普查确认：100 次活动 marker 新增**全部**由记录自带 activity 命中、投影里 0 次可判。**Vera 的 per-kind 同会话前后档（06569e6 → 956011a → e38c6be，ms/次）**：`thread-replied` 0.0518 → 0.0503 → **0.0056（−89%）**、`thread-read` 0.0843 → 0.0605 → **0.0274**、其它 inbox 类 kind 同向下降；整趟 validate **861.2 → 679.9 → 262.6 ms**、147k 外推 10,819 → **3,308 ms**；ms/record 在 4× 记录区间 **0.0211 → 0.0206 持平**（每翻倍指数 −0.03）⇒ 04 遗留的记录级超线性消失。变异臂（Vera 复现，(b) 17 红 / (c) 5 红 + 补充 (e) 25 红、(f) 全账本兜底只 1 红=新增边界臂、(g) 12 红）。门禁（Vera 自跑）：`npm test` **575 passed 1 skipped** / typecheck RC=0 / lint 0/0，范围只 2 路径无 schema 变化。**drain 合并仍不动**（改读的 durable 语义与 Client retry 合同，需 Vera + Human/Reeve 先拍，并按票面重测 20/100/400 用户可见墙钟）。证据：[`materials/phase0/findings.md`](materials/phase0/findings.md) §3e/§3f/§3g、[`issues/05-read-indexes-and-cow.md`](issues/05-read-indexes-and-cow.md) 末节、[`materials/done.md`](materials/done.md) 第七/八刀。
- **06 两片已落地并验收通过（Vera，最终 tip `805273b`）**（Tars 落地 2026-09-13 00:0x）。**切片 A**（原 `7cccf90`，已并入 `805273b`）：draft 订阅从两个页面下沉进 `TeamComposer`（props 换成 `{drafts, draftKey, onEdit?}`，页面只在 send 时读一次快照）、`TeamMessage` 包 `memo` 并把调用方每次新建的三个 prop（`openRef`/`lookupTaskRefs`/`mentionNames`）稳定化、页面 `onEdit` 用 bail-out setter 清一次性发送状态。**切片 B**（原 `8c7cf6a`，已并入同一 commit；`refreshSupplemental` 的 roster 扇出去重）：一次 Host 变更会唤醒本页匹配的 `workspace` 与 `presence` 两个 poll、两边送达**同一个 version**，按 version 去重后本页 roster 读 **2 轮 → 1 轮**；轮次进行中到来的更新 version 跑补齐轮，不丢。**同探针前后绝对量**（行渲染 = React 实际渲染的行数）：一次输入 10/30 → **0/0**、一次变更 20/60 → **0/0**、一次 committed 到达 → **1/1**、变更档 `readThread` 前后都是 0。隐藏依赖：只包 `memo` 不够——members 重取换新数组会让 `mentionHandlesMap` 换 identity，若 mention 名缓存以 Map identity 为 key 则每行 prop 全变、memo 全失效（实测仍 20/60）；改按名字内容比较后 props 零变化。证据：[`issues/06-client-render-isolation.md`](issues/06-client-render-isolation.md)、[`materials/done.md`](materials/done.md) 第九/十刀、[`materials/phase0/findings.md`](materials/phase0/findings.md) §5c。
- **Phase 1 票已拆**（见 [`issues/`](issues/)，按依赖序）：01 启动单次校验 → 02 无进展读不落盘 + receipt 合同 → 03 version / phantom refresh → 04 B2 瘦记录 → 05 读路径索引与 COW → 06 Client 渲染隔离 → 07 Session fold 增量。06/07 可与 Host 侧并行；**证据建议把 B1/B2（02–04）提前落地**，这条排序待 human 确认。
- **B1 已落地**（票 02 `8dabaa3`）：inbox delta 空且水位没动 → 不算提交；no-op receipt 与幂等语义已定（[`spec.md`](spec.md) §5.1）。
- **B2 已落地**（票 04 `06569e6`）：`team/thread-read` 已是瘦 read receipt + Inbox delta，旧胖记录只读 normalize（形状见 [`spec.md`](spec.md) §5.5）；**B3 快照截断暂缓**，只有 B2（含 05 的索引/COW）后仍达不到规模目标才评估。
- Vera 的尺子已在 `materials/vera-replay-ruler.md`（复跑命令、五条 case、观测值、探针源码）。冻结账本本体在 gitignored 的 `artifacts/team-perf/frozen-ledger-11695ops.sqlite.gz`；被清了按尺子第二节从活账本重建。

## Completion conditions

- A 的体感验收有结论（human）。
- 整体性能方向已经形成决策快照（[`spec.md`](spec.md)），Phase 0 量测完成后再拆成可实施 ticket。
- 可复跑尺子能证明「变快」不是噪声：同冻结账本、开/关校验差分；新增的浏览器和 drain 指标也有固定输入与原始输出。
- 每个实施阶段都保留 ledger 单一权威、记录级独立 invariant 和现有 Inbox/mention/导航语义。
- 稳定机制写进 `docs/architecture.md` 后，本项归档。

## Formal-doc exit

稳定结论进 `docs/architecture.md` / `architecture.zh.md`（ledger 权威、**invariant 时机**：挂载时同步全量 + 每次提交延后合并——包级 README 已写，maintained docs 还没有、读是否入账）。用户可见行为进 `CHANGELOG.md`。然后归档到 `.scratch/archive/YYYY-MM/team-perf/`。本轮不改 docs；human 调研收敛后再写。

## 入口

| 读什么 | 文件 |
| --- | --- |
| 整体性能决策快照 | [`spec.md`](spec.md) |
| 已做的两刀 + 数字 | [`materials/done.md`](materials/done.md) |
| 后续可能有帮助的（B 及更远） | [`materials/next.md`](materials/next.md) |
| 别再踩的约束 | [`materials/constraints.md`](materials/constraints.md) |
| Vera 的可复跑尺子 | [`materials/vera-replay-ruler.md`](materials/vera-replay-ruler.md) |
| 2026-08 那轮 UI loading（无规模数据，勿当待办） | [`.scratch/archive/2026-08/team-ui-loading-investigation/`](../../2026-08/team-ui-loading-investigation/) |

源头线程：thread:0de17583 / task:0bcb60b7 #9。Roadmap 第一刀：thread:e3f3d7f7 / task:6415d88a #38，issue #21 / PR #22。
