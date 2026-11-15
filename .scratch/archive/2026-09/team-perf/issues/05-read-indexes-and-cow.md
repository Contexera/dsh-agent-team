# 05 — 读路径索引与 copy-on-write（含多轮 drain 合并的评估）

> 已归档：本票面状态是归档时的历史记录，未回填；见[工作项 README](../README.md)。

**What to build:** 一次读不再复制整个全局 marker projection；`claimsByTask`、`activeClaimsByMember`、Thread tail/sequence、marker bucket 走索引；同时评估「让一批读落在同一个回合里」，把重复的全量重放压成一次。
**Blocked by:** 04 优先（否则省下的都会被胖记录放大）；索引部分可先做
**Status:** in-progress — Tars 2026-09-13 23:2x 起（04 已落 `06569e6`）。**第一片 `956011a`**（读路径去克隆）+ **第二片 `e38c6be`**（校验路径 ref 索引）都已落地，并**由 Vera 独立验收通过**（2026-09-13 23:5x：per-kind 同会话前后档、曲线做直、变异臂、(b)/(c) 复现、真实账本 marker 普查，见文末「Vera 独立验收」与 [`../materials/phase0/findings.md`](../materials/phase0/findings.md) §3g）；**drain 合并仍待对齐用户可见口径**，不在已落 commit 里。靶子定位（读源码后，含具体函数与反模式）见 [`../materials/05-residual-hotspots.md`](../materials/05-residual-hotspots.md)。

- [x] 大账本上单次 read 的绝对耗时与分配下降（同输入前后对照）——**结构上已成立，绝对量待 Vera 的对照（我这边没有父提交基线）**（Vera 2026-09-13 23:5x：绝对耗时仍是亚毫秒噪声档——中位 0.1 ms、min 0.05/max 7.06，**分配本身没有独立测量**，所以这一格的判据落在结构变化 + 差分等价，见文末与 §3g）：`prepareReadFrom` 里那次「克隆整份 attention + 三个 marker 索引当假设投影」已删除，改为 `remainingUnreadAfter(projection, memberId, receipt)`：post-delta 状态 = receipt 自己派生出来的 attention 行 + 该 reader 在该 Thread 的 marker 键集（套用 receipt.inbox 的 removals/additions）。单次读的分配从 O(全部 marker) 降到 O(该 Thread 的 fact 数 + 该 reader 在该 Thread 的 marker 数)。同一函数的 `firstRead` 背景快照也从全局 `messages.filter` 改走 `factsByThread`。**等价性由构造保证**（用的就是 delta 的派生输入），判据落在包内语义臂 + 变异臂：见 [`../materials/phase0/findings.md`](../materials/phase0/findings.md) §3e。
- [x] **第二片 `e38c6be`：`validateInboxDelta` 的 ref 索引**（Vera per-kind 表里 `thread-replied` 没动的那一半）——三份全量复制（`[...projection.messages]`、`[...projection.orderedFacts.filter(activity)]`、`new Set([...threads.keys()])`）与每个 marker 的整份数组 `.find` 都已消失：`Projection.messages` 数组删除、换成 `messagesByRef: Map<ref, Message>`（与 `factsByThread` 同一次 append 维护 ⇒ live 与 scratch 投影天然一致），成员测试改 `has`，两处 direct marker 校验改索引命中并保留「投影优先、再加入本记录」的旧优先级。**活动 marker 那支经 M3 证明投影侧索引不可判（死状态），已删索引只留本记录自带的 `additionalActivities` 解析**（理由见下）。**Vera 预登记的 (b) replay-derived / (c) 篡改索引必红两条臂已跑**：M1 7 红、M2 3 红（详见下）。
- [ ] drain 轮数语义不变（仍 ⌈N/20⌉），但**评估合并**：实测每轮之间让出一个回合就各付一次 ≈0.7 s 重放（400 条未读 = 13.75 s），同一批读不跨回合时整段只付 1 次（118 ms + 1 次重放）
  - 评估已写进 [`../materials/05-residual-hotspots.md`](../materials/05-residual-hotspots.md)：改变读的 durable 语义与 Client retry 合同（02/04 刚定完），**需要 Vera + Human/Reeve 先拍**，不混进索引那次 commit。
- [ ] 若采用合并，用户可见口径必须重测：给出 20 / 100 / 400 条未读下的前后墙钟
- [x] 不改变读的 durable 语义（除非 02 判定为无进展读）——第一片是纯局部重写：不改 schema、不改 receipt、不改 watermark/delta 语义，`npm test` **574 passed / 1 skipped**（新增 1 条语义臂）、typecheck 绿、lint 0 warnings、build 绿。

## 第一片 `956011a` 的实现与自证（Tars，2026-09-13 23:3x）

**改了什么**：`prepareReadFrom` 删掉假设投影克隆（原来为算 `remainingUnreadCount` 把 `attention`/`directMarkers`/`activityMarkers` 三份 map 与 `attentionByThread`/`attentionThreadsByMember`/`directMarkersByMember`/`activityMarkersByMember` 四个派生索引整体克隆，`applyInboxDelta` 之后再数未读）；新增 `remainingUnreadAfter(projection, memberId, receipt)`：post-delta 状态用 receipt **自己派生出来的输入**（`receipt.attention` 那一行 + `receipt.inbox` 的 marker removals/additions），只走该 Thread 的 fact 列表与该 reader 在该 Thread 的 marker 桶。另抽 `isUnreadFact(...)` 作为「这条 fact 对这个读者是否未读」的**唯一权威**，画面派生与计数派生共用（否则两处判定会漂）。`firstRead` 的背景快照从全局 `messages.filter` 改走 `factsByThread`（每个 Thread fact 与其 message 一一对应，`appendMessageFact` 是唯一写入点）。顺手改掉 Vera 报的 `AgentTeamThreadReadSnapshot.task` 那行过期注释（「captured for a stable idempotent read response」→ 只说明它是 legacy 记录的被校验内容，不再服务任何响应）。

**等价性为什么由构造保证**：读的 delta 只会碰「该 reader 在该 Thread 的 attention 行」与「该 reader 在该 Thread 的 marker」，而 `isUnreadFact` 的每一次查表都限定在同一 (member, Thread) 对；`receipt.attention` 就是 `applyInboxDelta` 之后那一行的值（`nextAttention[0] ?? attention`），`receipt.inbox` 的 removals 就是 `applyInboxDelta` 会删的键。**没有第二套语义**：判定函数是同一个。

**新增包内语义臂**（`agent-team.spec.ts`，「counts remaining unread from the reader own marker state, not the whole ledger」）：两个 Thread × 两个 Member 的交错场景 —— reader 在两个 Thread 各有一个 mention marker，旁观者在第一个 Thread 有一个 marker，外加一条普通 Human 更新。断言：reader 读第一个 Thread 后 `remainingUnreadCount === 0` 且该 Thread 的 direct marker 只在画面里出现一次；**第二个 Thread 的读仍是 committed**（说明第一个 Thread 的读没有把别处的 marker 吃掉）；旁观者读第一个 Thread 仍是 committed 且自己的 marker 还在（说明 reader 的读没有吃掉别人的 marker）。这条臂同时锁住「跨 Thread 不泄漏」「跨 Member 不泄漏」「水位推进与 marker 消费在同一次读里都对」。

**变异自证（源码按 sha256 还原，`7bfbee5b…` 前后逐字节相同）**：

| 臂 | 变异 | 结果 |
| --- | --- | --- |
| M1 | 计数用 `receipt.attentionBefore`（pre-delta 水位）替代 `receipt.attention` | **4 条红**（水位没推进的那些断言全炸） |
| M2 | 不应用 `receipt.inbox.directMarkers.removed` | **1 条红**（marker 吞不掉，计数多 1） |
| M3 | marker 键集改从**全局** `projection.directMarkers` 取（而非该 reader 的桶） | **81 条全绿 = 等价变异体**：`directMarkerKey` 内嵌 memberId + threadRef，键集扩大不改变任一 (member, Thread) 的成员判定 ⇒ 该臂不可判，不是覆盖缺口。性能上仍然必须读桶（O(该 reader 在该 Thread 的 marker) vs O(全部 marker)） |

**门禁（最终态）**：build 绿、`npm test` **574 passed / 1 skipped（43 文件）**、typecheck 绿、lint 0 warnings 0 errors（134 文件 84 规则）。

## 第二片 `e38c6be` 的实现与自证（Tars，2026-09-13 23:4x）

**改了什么**：`validateInboxDelta` 原来在**每条** inbox 携带记录的校验里无条件 `[...projection.messages]`（O(messages)）、`[...projection.orderedFacts.filter(kind === 'activity')]`（O(all facts)）、`new Set([...projection.threads.keys()])`（O(threads)），然后对每个 marker 在整份数组上 `.find`（再一次 O(n)）——账本越大，每条 `team/message-sent` / `team/thread-replied` 的记录级校验越贵，这就是 per-kind 表里 `thread-replied` 0.0139 → 0.0482 ms 的那一半。现在：`Projection.messages` 数组**删除**（它唯一的读者就是这里那次复制），换成 `messagesByRef: Map<AgentTeamMessageRef, AgentTeamMessage>`，由 `appendMessageFact` 与 `factsByThread` 在**同一次 append** 里维护（唯一写入点 ⇒ live 投影与校验用的 scratch 投影天然一致，不可能漂）；`knownThreadRefs` 改成员判定（`projection.threads.has(...)` + `additionalThreadRefs.includes(...)`，后者 ≤1 项）；两处 direct marker 校验改索引命中，**保留旧的「投影优先、再加入本记录」优先级**（`team/message-sent` 的新 Message 校验时还没 apply，靠 `additionalMessages` fallback 命中）。

**活动 marker 为什么最终不建索引（偏离第一版计划，有证据）**：先按计划加了 `activitiesByRef` 并按「投影优先」查；**变异臂 M3「把 `appendActivityFact` 里的索引写入整行删掉」= 82 条全绿**。读源码：活动 marker 只在 `closeThreadInboxFrom` / `acceptThreadInbox` / `reopenThreadInboxFrom` / `promoteThreadInboxFrom` 四处产生，全都用**本操作自带的那个 activity** 的 `activityRef` + `sequence`；removal 分支根本不查 activity；实体 ref 全局唯一（`addRef` 重复即拒），投影不可能存在同 ref 的另一个 activity ⇒ 投影侧那份索引**没有可判读者**，是纯死状态，已连同写入删除，`orderedFacts.filter(activity)` 的全量复制照样消失。按第一片 M3 的口径记「不可判」，不是覆盖缺口。

**Vera 预登记的两条索引臂 + 两条补充臂（源码级变异；sha256 `cd16db59041b5b6adb0dae5c3bf3989a01d5b7d89120acd7bcb6ca2a2637b8af` 前后逐字节还原）**：

| 臂 | 变异 | 结果 |
| --- | --- | --- |
| M1（= (b) replay-derived） | 索引只在 `target === this.state` 时写（scratch 校验投影不维护） | **7 条红**：读消费 earlier marker、删 marker 的用例全炸 ⇒ 索引必须由 replay 那次 apply 维护 |
| M2（= (c) 篡改索引必红） | 索引写成「当前 ref → 上一条 Message」这种错分量 | **3 条红**：一致性检查照样抓住（含 2 Thread × 2 Member 那条语义臂） |
| M3a | 活动 marker 解析不到任何 activity | **7 条红**：活动 marker 校验仍有牙齿 |
| M3b | 删掉 `activity === undefined` 守卫 | **82 条全绿 = 不可判**：携带活动 marker 的记录都先做「记录 inbox vs 现推 expected」逐字比对，单条伪造不可达（改前亦然，非本片缺口） |
| M4 | 给消息解析加「全账本 Message 集」兜底 | **只有新增臂红**（81 绿）：证明新增的 forward-reference 臂确实区分「按 replay 状态解析」与「按账本全集解析」 |

**新增包内臂**（`agent-team.spec.ts`）：`rejects a direct marker that resolves only against a later record during replay` —— 把某条 reply 的 marker 改写成**后一条 record** 里的真 Message（同 Thread、sequence 也对齐），扫全账本 Message 集会接受、按 replay 状态必须拒；断言 `invalid direct marker addition`。

**门禁（最终态）**：build 绿、`npm test` **575 passed / 1 skipped（43 文件）**、typecheck 绿、lint **0 warnings 0 errors**（134 文件 84 规则）、check:docs 绿。**没量的**：per-kind 前后绝对量（`thread-replied` 是否终于下降、`thread-read` 是否回涨）——归 Vera 的父提交基线尺子。

## Vera 独立验收（两片 `956011a` + `e38c6be`）—— 结论：**过**，2026-09-13 23:5x

尺子：隔离 clone 分支 `verify-05b`、冻结件 `frozen.sqlite`（11,695 条），三 commit **同会话交错跑**。完整证据与命令见 [`../materials/phase0/findings.md`](../materials/phase0/findings.md) §3g。要点：

- **门禁自跑复现**：`npm test` **575 passed / 1 skipped（43 文件）**、`npm run typecheck` RC=0、`lint` 0/0（134 文件 84 规则）；范围只 2 路径，无 schema / domain version 变化。
- **(b)/(c) 复现成立**（我自己的变异写法、跑全 workspace 套件）：(b) live-only 索引 **17 红**；(c) 错分量 **5 红**。补充三条：(e) 拆掉本记录 fallback **25 红**（fallback 承重）；(f) 全账本兜底 **只 1 红 = 新增那条 forward-reference 臂**；(g) 活动 marker 解析恒空 **12 红**。
- **真实账本普查（插桩）**：1,212 次 direct marker 新增全部由记录自带 Message 命中、**投影命中 0**；1,208 次删除**全部由 `messagesByRef` 命中**（索引的承重角色正是 removal）；100 次 activity marker 新增**全部由记录自带 activity 命中，投影里 0 次可判** ⇒ 活动索引是死状态这一判断在真实数据上成立。
- **per-kind 前后档（ms/次，06569e6 → 956011a → e38c6be）**：`thread-replied` 0.0518 → 0.0503 → **0.0056（−89%）**；`thread-read` 0.0843 → 0.0605 → **0.0274**；`message-sent` 0.0799 → 0.0733 → 0.0094；`claim-created/done`、`task-changed`、`attention-changed` 同向下降。整趟 validate **861.2 → 679.9 → 262.6 ms**。
- **曲线做直**：ms/record 在 2,923 → 11,695 记录（4×）上 `06569e6` 0.0395→0.0708、`956011a` 0.0275→0.0543、`e38c6be` 0.0211→**0.0206（平，每翻倍指数 −0.03）** ⇒ 04 遗留的记录级超线性消失。147k 外推 10,819 → **3,308 ms**。
- **第一片遗留空格已补**：冻结件上计数全 0，原「新 == 旧」只验 0==0；新增合成臂给出非零且 >20 的计数（45 未读→列 20→剩 25；lifecycle 支 47→剩 27），四种错答案分离，并在父提交 `06569e6` 上跑出同样数字（转写保真）。第一片的**绝对**读耗时仍是亚毫秒噪声档（中位 0.1 ms），分配本身没有独立测量——判据落在结构与差分等价。
- **未验/不主张**：drain 合并未落（等口径与 20/100/400 墙钟）；`test:browser` 未跑（无 bundle / UI 面）。
- **漂移警告**：同一探针同一 commit 跨会话差 +65%（520.6 → 861.2 ms）⇒ 绝对量只在同会话交错跑里可比。
