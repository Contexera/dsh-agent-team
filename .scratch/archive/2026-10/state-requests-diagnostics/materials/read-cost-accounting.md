# 读取用途、读取契约与成本账（票 04）

基线装置与读数：Vera 的 `vera-read-cost-baseline.{mjs,json}`，跑在树 `669a9fc9`（提交 `beedcbc7`）。
变更后读数：`aster-read-cost-after.{mjs,json,log}`，同一装置、同一 5 个样本，跑在票 04 的提交 `e02f2862`／树 `55e8cb15b2fede6086988784fed4cadb7a426180`。
四个文件都在 `.scratch/local/state-requests-diagnostics/2026-10-09/`（gitignored，不进仓）。

装置口径（两条必须与基线一起读的修正）：

1. **行号重映射**：Vera 的 `SITE_LABELS` 绑在 `beedcbc7` 的行号上；本仓改动后调用点整体下移，`aster-read-cost-after.mjs` 的表按新树逐行回读源码重映射（未命中的行号会打印成 `line:<n>`，本文件所述读数里为 0 条）。
2. **`claim.examined` 口径随实现**：该读数数的是**实现真正检查过的 Claim**。基线实现每次调用都过滤整张 `claims` 表 ⇒ 数 `claims.size`；索引实现只走该 Task 的桶 ⇒ 数桶长。两个数字是同一件事在两个时间点的读数，不是同一段代码的两次运行。
3. 追加读数（基线没有）：`view:forAgent(addressBook, includeCatalog)`，即变更后 `team_view` 真实发出的请求形状，用来单列 catalog 读取的**剩余**分量。

样本：S1 100 Task／1 Workspace 全活跃、S2 1000 Task 全活跃、S3 1000 Task 仅 20 活跃、S4 100 Task／4 Workspace、S5 100 Task + 60 回复长 Thread。

## 一、读取用途与契约（判据 1、2）

已按源码逐条核对 Vera 的调用方清单（本文件即核对结果）。「完整信号」一列就是该用途**不静默截断**的方式。

| 面 | 用途 | 请求形状 | 返回范围 | 完整信号 |
| --- | --- | --- | --- | --- |
| 侧栏频道面板 | 频道目录 | `view{workspaceId, limit:1}` + `members{workspaceId}` | 频道、成员关系、该 Workspace 的参与项、页内 fact 及其 Thread/Task | `hasMore` + `cursor` |
| 侧栏未读角标 | Inbox 合计 | `inbox{workspaceId, limit:1}` | ≤1 行未读 + 全队列合计 | `totalUnreadCount`／`totalDirectCount` 覆盖整条未读队列 |
| Thread 页首屏 | Thread 画面 | `readThread` + `view{…, threadRef, includeActivities:false, limit:1}` + `members` + `threadHistory{limit:100}` + `threadObservations{}` | 该 Thread 的 facts、anchor、Claims、Attention、该 Task 的序号 | `remainingUnreadCount`、`earlierFactCount`、`cursor`+`hasMore`、`hasMore`（observations） |
| Thread 页翻历史 | 更早 facts | `threadHistory{beforeSequence, limit:20}` | ≤20 条 | `cursor` + `hasMore` |
| 频道页首屏／翻页 | 一页 top-level | `view{channelRef, direction:'before', topLevelOnly:true, includeActivities:false, limit:20}`（翻页带 `cursor`）+ `members` + `inbox{limit:100}` | ≤20 条 fact + 这一页自己的 Thread/Task/catalog 字段 | `cursor` + `hasMore`；`inbox` 给全队列合计 |
| 收件箱页 | 未读队列 | `inbox{limit:100}` | ≤100 行 + 「最近活跃」切片 + 全队列合计 | 全队列合计（模型侧渲染成「N unread beyond this bounded list」） |
| 引用导航 | ref → Thread/Task | `resolveTaskRefs`／`resolveThreadRefs`（批量 + 单条） | 命中的引用 | 每条返回 resolved 或未命中，无截断 |
| 模型侧 `team_view` | address book | `view{workspaceId, topLevelOnly:true, includeActivities:false, direction:'before', includeCatalog:true}` | 频道、成员、Workspace、一页 Thread anchors + **整个 scope** 的 Task/Thread/Claim catalog 与活跃 radar | Task/Thread 页由 `cursor`+`hasMore` 分页；radar 契约上完整（描述即「every in_progress / in_review Task Thread in your Channels」） |
| 模型侧其余 4 件工具 | 读 Thread／Inbox／Claims／Attention | `readThreadForAgent`／`inboxForAgent`（带 workspaceId）或 `memberInbox`／`threadHistoryForAgent`／`listClaimsForAgent`／`attentionStatusForAgent`／`host.members`／`host.resolveTaskRefs` | 与对应 Human 读取同一投影，换成员身份与过滤 | 与上表同源 |
| 非查询面 | 成员状态等 | `members{workspaceId}`、`humanProfile`、`environment`、`contextJudge` | Host **成员注册表**／设置面，不读账本投影 | 成本 ∝ 注册项，不随协作历史增长 |

`view` 的 catalog 字段（`tasks`／`threads`／`taskNumbers`／`activeTaskThreads`／`claims`）默认只描述**这次返回的那一页**加请求点名的 Thread；要整个请求 scope 的 catalog 必须显式 `includeCatalog: true`（只有 `team_view` 这么发）。Client 的全部读取都不发这个字段。

## 二、成本分量与读数（判据 5、6、7）

分量定义（判据 6 要求分开记账，不用合计代表读取成本）：

- **目录过滤**：为把 Thread 归到 scope 而解析其 Channel 的次数（每 Thread 一次）。
- **事实走查**：`matches` 谓词被调用的次数（每 fact 一次）；Thread 命中数 ≤ limit 时这是稳态全账走查，与命中位置无关。
- **Claim 检查**：实现检查过的 Claim 条数（见口径修正 2）。
- **返回字节**：`JSON.stringify(结果).length`，`await` 之后量。

关键读数（before → after，取自上面两个 JSON；`view:channelPage` 即频道页那一条）：

| 样本·读取 | 目录过滤 | 事实走查 | Claim 检查 | 返回字节 |
| --- | --- | --- | --- | --- |
| S2 `view:catalog(limit 1)` | 1000 → 1 | 2 → 2 | 1 001 000 → **2** | 1 046 866 → **2 446** |
| S2 `view:channelPage(20)` | 1000 → 20 | 1021 → 1021 | 1 020 000 → **40** | 1 063 543 → **39 009** |
| S2 `view:threadDirected(1)` | 1000 → 1 | 2000 → 2000 | 2000 → **2** | 2470 → 2470 |
| S2 `inbox:badge(limit 1)` | 0 → 0 | 0 → 0 | 1 000 000 → **1** | 989 → 989 |
| S2 `inbox:page(limit 100)` | 0 → 0 | 0 → 0 | 1 000 000 → **100** | 88 809 → 88 809 |
| S2 `readThread` / `listClaims` / `threadHistory` | 0 → 0 | 0 → 0 | 1000 → **1** | 不变 |
| S2 `threadObservations(limit 1)` | 0 → 0 | 0 → 0 | 0 → 0 | 233 → 249（新增 `hasMore`） |
| S2 `view:forAgent(catalog, limit 1)` | 1000 → 1 | 2 → 2 | 1 001 000 → **2** | 1 046 911 → **2 491** |
| S2 `view:forAgent(addressBook, includeCatalog)`（基线没有） | 1000 | 2 | 1001 | 1 046 911 |

S1／S4／S5 同形：`view:catalog(limit 1)` 的 Claim 检查 10 100 → 2、字节 105 363 → 2 444（S4 27 384 → 2 446）；`inbox:badge` 10 000 → 1；`threadDirected` 200 → 2。S3（1000 Task 仅 20 活跃）Claim 检查 420 → 2、字节 430 764 → 2 446，证明收益来自「按用途取数」而不是样本恰好很小。

## 三、各用途的成本边界（判据 7）

- **一页读取**（`view` 不带 `includeCatalog`）：目录过滤去重后 = 该页 Thread 数（≤ limit，含点名 Thread）；事实走查 = 走到超出 limit 的第一个匹配为止；返回体 ∝ 页大小，与协作历史无关。
- **Inbox**：排序与合计遍历该读者的未读候选 Thread（未读列表本身按 Thread 有界）；**行物化 = 返回行数**（≤ limit）：preview 文本、署名者解析、Claim owner 查询只为返回的行做；返回体 ∝ limit，合计仍是整条队列。
- **按 Task 的读取**（`listClaims`／`readThread` 画面／`threadHistory`／Inbox 行／radar 行）：每 Task 一次桶查，检查数 = 该 Task 的 Claim 数，与该 Task 无关的 Claim 完全不碰。
- **address book**（`includeCatalog: true`，仅 `team_view`）：目录过滤 = scope 内 Thread 数（去重后每 Thread 一次）；每个活跃 Task 行一次桶查；**返回体 ∝ 活跃 Task 数**——这条读取契约上完整、不是分页列表，S2 实测 1.0 MB／1000 活跃 Task。这是本条读取的成本边界；规模下的取舍结论归票 06。
- **单机 ms 只作次级信号**，不是 SLA；上表全部结论都能由目录过滤／事实走查／Claim 检查／返回字节四个分量复算。
