# 04 — 按用途限制读取范围与投影成本

**What to build:** 读取频道目录、一页消息、成员状态或 Inbox 总数时，只返回该用途需要的数据；协作历史增长不会使一个小查询附带整个任务目录或重复全扫 Claim。
**Blocked by:** 03 — 共享读取与过期响应保护
**Status:** complete

- [x] 列出 Human Client 与模型工具的实际读取用途，明确每项返回范围、分页、总数和扫描成本；不能只优化第一个 limit:1 示例。
- [x] 频道目录、Thread 内容、成员状态与 Inbox 摘要各有清楚的读取契约；完整列表确有需要时提供显式分页或明确的完整性说明，不静默截断模型可发现的工作。
- [x] 消除每个活跃 Task 再扫描全部 Claim 的二次增长；派生索引由账本重建，不成为第二份持久权威。
- [x] 相同查询范围内的未读、Task 编号、Claim owner、归档过滤、权限和 revision 语义保持一致，并能经独立重放验证。
- [x] 在 100 与 1,000 个活跃 Task 样本，以及大量历史但少量活跃任务、多 Workspace、长 Thread 样本上，记录请求数、返回字节与扫描次数。
- [x] 扫描成本按分量分开记账：目录过滤（每 Thread 一次）、事实走查（每事实一次；Thread 匹配数 ≤ limit 时为稳态全账走查，与命中位置无关）、返回体大小各自记录，不用合计或单一读数代表读取成本。
- [x] 为各读取用途明确可复查的成本边界；不把单次本机耗时当成 SLA，也不只证明返回条数受限。
- [x] 迁移所有受影响的 Client 和模型工具调用方，同步生成的 Remote 与公开文档，移除被替代的读取路径。
- [x] 验证消息分页、Inbox、引用导航和模型发现流程没有漏数据；运行相应工具、组件和浏览器检查。

## 完成记录（2026-10-09，提交 `e02f2862`，树 `55e8cb15b2fede6086988784fed4cadb7a426180`）

一笔落地（实现＋测试＋双语维护文档）：`feat: bound read projections by purpose and index claims per task`。

**改了什么**

1. **Claim 按 Task 分桶**：`Projection` 新增派生索引 `claimsByTask`，由 `recordClaim` 在读投影/重放的三个写点维护（claim 创建/完成/释放、task-changed、离场快照），首次写入决定位置、状态变化就地改写 ⇒ 与它替代的「整表过滤」逐条同序。`claimsForTaskFrom` 与写路径上的同集合过滤（重复 Direction 校验、accept/close 的 claim 集合、重放校验的 priorClaims）都改走桶。
2. **`view` 的 catalog 按用途定界**：新增请求字段 `includeCatalog`。不带它时，`tasks`／`threads`／`taskNumbers`／`activeTaskThreads`／`claims` 只描述**这次返回的那一页**加请求点名的 Thread，并改为按 ref 直查（不再逐 Thread 走目录）；带上才返回整个请求 scope 的 catalog。`team_view` 显式带它（address book 契约不变），Client 的所有读取都不带（它只读 `channels`／`members`／`items`／`cursor`／`hasMore`／`taskNumbers`，后者的取值在点名 Thread 的请求里仍是那一条）。
3. **Inbox 行按返回量物化**：排序与全队列合计仍遍历所有未读候选，preview 文本、署名者解析与 Claim owner 查询只为返回的行做。
4. **`threadObservations` 补 `hasMore`**：列表是有界的最新 `limit` 条，follower 集合仍是完整当前状态；此前没有任何完整性信号。

**判据 1／2**：读取用途、请求形状、返回范围、分页与完整信号逐条核对成表，写在 [read-cost-accounting.md](../materials/read-cost-accounting.md)（含 Vera 的调用方清单核对结果，以及「`members` 走成员注册表、不随协作历史增长」这条口径）。契约变更后唯一的静默截断（observations 无完整性信号）已消除。

**判据 3／4**：`claimsByTask` 是重放派生的读索引，不是第二份持久权威——它只在 `applyTo` 的写点维护，重放从操作表重建；`projection-indexes.spec.ts` 新增用例在 24 Task × 2 Claim 上比对「桶读」与操作结果推出的期望（含 done／accept／close／removeMember 离场快照），并比对独立重放的读数。同一用例还覆盖 radar 的 owner 口径（活 Claim 在，finished／released／closed 不在）。

**判据 5／6／7**：读数组件分开记账（目录过滤／事实走查／Claim 检查／返回字节），5 个样本 before→after 全表在 materials 文档。最相关三行（S2＝1000 活跃 Task）：`view:catalog(limit 1)` Claim 检查 1 001 000 → 2、字节 1 046 866 → 2 446、目录过滤 1000 → 1；`inbox:badge(limit 1)` 1 000 000 → 1；`view:channelPage(20)` 1 020 000 → 40、字节 1 063 543 → 39 009。事实走查（每 fact 一次谓词）不变，按判据 6 单独列出，不用合计代表读取成本。单机 ms 只作次级信号。

**装置两处必须与读数一起读的修正**：① Vera 的 `SITE_LABELS` 绑在 `beedcbc7` 行号上，本仓改动后逐行回读源码重映射（未命中会打印 `line:<n>`，本次读数 0 条）；② `claim.examined` 数的是**实现检查过的** Claim：基线实现整表过滤 ⇒ 数 `claims.size`，索引实现走桶 ⇒ 数桶长，两个数字是同一件事在两个时间点的读数。另追加一条基线没有的读数 `view:forAgent(addressBook, includeCatalog)`。

**剩余成本边界（有意保留，归票 06）**：address book（`includeCatalog: true`）按契约完整——`team_view` 描述即「every in_progress / in_review Task Thread in your Channels」——其返回体 ∝ 活跃 Task 数（S2 实测 1.0 MB／1000 活跃 Task），每个活跃行一次桶查（S2 = 1001 次）。规模下是否加显式分页或上限，与 `WeakMap` 根因一并归票 06 定论。

**闸门（树 `55e8cb15…`）**：typecheck ✓；`npm test` 1004 通过 / 1 跳过（1005）；lint 0 error、3 条既有 warning；`npm run build` ✓；`npm run test:browser` 6/6；`npm run check:docs` ✓（最长块未抬上限）。
