# 01 — Session fold 增量与 pressure notice 状态

> 自归档 [`team-perf` 的 07](../../team-perf/issues/07-session-fold-incremental.md) 取来（归档不复活），**归档那份保持历史原样**。四条验收判据的**含义未改**，只勾选并在末节补落地结果；另有一处口径修正：第 1 条的「133,596 事件」按 Vera 的 §3i 校正为真实读路径的 18,983（理由见末节）。

**What to build:** `context-management` 与 clock context 用 Session event cursor 取代每次事件的全量 `ownEvents()` fold；pressure notice「是否已送达」改成增量 Session 状态；progress-nudge reconcile 按受影响 Member 合并批次。
**Blocked by:** None — can start immediately
**Status:** complete（Tars 2026-09-14，`bf4c172`）——第 4 条里的 progress-nudge reconcile 未纳入，理由见末节

- [x] 真实会话上一次 fold 的绝对量下降；一个回合连折 10 次的开销降到与事件数基本无关
- [x] **验收输入必须是真实会话日志**（本轮主档 = 真实读路径的 18,983 事件，不是合成形状）
- [x] boundary、pressure 语义不变；rollover / compact / 恢复路径行为不变
- [x] 变动只影响 Session 侧投影，不触碰 ledger 权威与记录级校验

## 落地结果（`bf4c172`）

三处热点全部改走 `session-event-cursor.ts`：返回值的**值与全量重折逐字相同**，只有成本变。

| 档 | cold 全折 | 增量步进 |
| --- | --- | --- |
| n=1,898 | 0.577 ms | **0.0021 ms** |
| n=9,491 | 0.819 ms | **0.0025 ms** |
| n=18,983 | 1.765 ms | **0.0038 ms** |

n 涨 10×、cold 涨 3×，增量步进基本不动 ⇒ 曲线平（票面要的「与事件数基本无关」）。三指纹 cold 与增量互比且对上 Vera 预登记：context `9a9aa149e65ee394`、clock `cacb7ad86314fb75`、pressure `true`。

**身份守卫**：记住已消费末位事件的 `(seq, type)`；`logFrom` 变、日志变短、该位置事件被替换三种可观测破坏一律从头重折。具名残留：同 `seq` 同 `type` 换 payload 不可见（见 `session-event-cursor.ts` 模块注释，含「boundary digest 也关不掉它」的说明）。切片与它声称的区间不一致时抛 `RangeError`。

## 未纳入：progress-nudge reconcile

票面第 4 条原有的 `progress-nudge.ts` `recoverClaimSuggestions` 保持整表扫 `log.events` —— **这是有量测口径的结论，不是「交付一半」**：它只在 **generation 切换**时跑（`state.sessionId !== sessionId`，一代一次），而每 commit 调用的 `reconcileAll()` 只遍历**有 pending notice 的 member**、不碰日志；同档 pressure 全扫 18,983 事件 = 0.16–0.23 ms ⇒ 一代一次、可忽略，改它没有可量的收益。按仓库纪律（本仓「不为没量过的路径做优化」）保留现状，留待有新的量测再开工。

## 独立验收（Vera，2026-09-14，`bf4c172`）

- **三个语义指纹逐字相同**，且加载的是**生产本体**（模块导出的 `contextProjectionFold(sessionId)` 与 `PRESSURE_NOTICE_FOLD`）：context `9a9aa149e65ee394`、clock `cacb7ad86314fb75`、pressure `true`。
- **继承前缀（rollover 槽位）四档** k=1 / 5,000 / 18,980 / 18,983 与 pre-07 legacy oracle 逐键相同（主档 `inheritedEventCount = 0` 走不到这条路径，故单独加档）。
- **逐回合等价**：真实 148 个 turn 逐次增量折，turn 10/50/100/148 采样点上 `cursor.value` 逐字等于对该前缀的全量重折。
- **守卫四臂**：type 变 / 长度缩 / `logFrom` 变 / 追加，全部断言 `value` 逐字等于新日志的全量重折；「同 seq 同 type 换 payload」按具名残留只作记录、不判红。
- **曲线（加分项）**：交错 before→after→before，同一份 18,983 事件副本；before 全折 0.143 / 0.691 / 1.790 ms（12.5×），after 一回合只折尾巴 ⇒ n=18,983 档 1.790 → **0.015 ms**，代价跟尾巴走、不跟日志走。
- **门禁**：`npm test` 597 passed / 1 skipped（基线 `a84aada` 585/1，+12 全部有归属）、typecheck RC=0、lint 0/0；11 路径不碰 client/bundle，故不重跑 `test:browser`（04 的浏览器证据逐字有效）。

## 尺子口径（Vera 的 §3i，开工前已复核）

票面第 1 条的「133,596 事件」是 **v0 老档含流式 chunk 的原始记录数**；今天在跑的会话世代**不写 chunk**，真实读路径那一档是 **18,983 事件**。所以主档 = 真实读路径的 18,983，含 chunk 的原始流只作副档对照（fold 输入会大 ~7 倍）。

- 仪器：`sessionQuery.readSession(id)` 取 `{events, inheritedEventCount}`（`listEvents()` 只给索引轮廓、**没有 `data`**），事件喂给**纯 fold 函数**。
- 拷贝会话进临时 root 时目录名必须是真实 workspace slug（`--home-yu-projects-dsh-agent-team--`），且换目录前清空 root，否则 `listArtifacts` 报 corrupt；活 root 里混有 flat-file 老档案，直接指过去会被拒，必须用隔离副本。
- before 绝对量（18,983 事件）：context **2.39 ms**/折、十折 **26.4 ms**；clock 0.43 / 3.7；pressure 0.18 / 3.2。
- after 必须同时满足：① 三个语义指纹逐字相同；② 曲线形状变平（1,898 与 18,983 两档落进噪声内）；③ 主档走真实读路径。
