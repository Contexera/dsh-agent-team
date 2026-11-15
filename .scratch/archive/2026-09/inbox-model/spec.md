# Spec — 统一 Inbox（收件箱）

Confirmed 2026-09-15（thread:65e0e365 / task:10664d11 #40，Human 拍板 message:12919；模型讨论起点 thread:8939bf7e）。模型冻结；代码与测试仍是实现权威，本文件是这三步的决策正本，落地后移入 `docs/`。

## 问题

Human 的收件面今天只吃「仅 mention」切片（`directOnly`），follow 产生的未读在 Human 侧没有任何出口；而 agent 侧早就是「follow + 提到我 + 与我相关的状态变化」三类全量、且有主动推送。同一套判定内核，被两种不同的准入与投递包着——Human 感觉到的「两个模型」即此。

## 已定决策（Human 2026-09-15 拍板）

| # | 决策 |
| --- | --- |
| 1 | 入口改名：**收件箱 / Inbox**，替换现在的「提到我」；不叫「动态」「活动」 |
| 2 | 准入 = **我的全部未读**：follow 的普通未读 + 提到我 + 与我相关的任务/认领变化。mention 从「准入条件」降为「三类未读之一」 |
| 3 | **follow 定义**：Human **发起**过、或**回复**过，才算 follow；其他 agent 发起、Human 只打开没回复的，不算 |
| 4 | 「只打开」的行为不变：推进已读水位 + 消费提及标记，**不产生订阅** |
| 5 | **agent 侧机制相同、默认策略不变**：agent 仍靠认领 / 被邀请 / 显式操作 follow，回复不自动 follow（避免持续唤醒噪声）；需要时用订阅级别自降 |
| 6 | **订阅级别**（全收 / 仅 mention）：原计划随第 3 步建字段、UI 后置。**Human 2026-09-15 16:10（message:12986）推翻**——列表分两段后，「要不要只看 mention」已由分组本身表达，不再需要配置项，因此**不建该字段**；将来真要，用同一套 expand–contract 补回来的成本一样 |
| 7 | 收件箱入口默认展示 **follow 的全部活动**，不是被配置的 mention 口径 |
| 8 | 第 3 步 **supersede** 2026-09-13 的「Human Inbox = direct-only」决定，并**删除 `directOnly` 切片**（届时无调用方，不留兼容层） |
| 9 | 收件箱列表**分两段**：「需要我」＝未读队列（徽标来源）；「最近活跃」＝参与过的 Thread、上限 10、按最新活跃降序。同一 Thread **只在一段出现**（需要我优先），不重复显示；排序里 Task 状态只做展示，不做主序（Human message:12986、12982） |

## 三步与验收口径

### 第 1 步 — 收敛模型（已完成 2026-09-15）

产物即本文件 + [`materials/current-model.md`](materials/current-model.md)（今天的模型取证）。

- [x] 模型取证（判定内核同一、投递/表面/控制三处差异）
- [x] 决策点逐条拍板（Human message:12919）
- [ ] **未完**：本文结论在实现落地时同步进 `docs/`（见文末出口）

### 第 2 步 — Iris 侧采用（Thread 入口显示 follow 的全部活动）

- [ ] **Host 供数：不需要新投影。** Host 现有 `inbox`（**非 direct 切片**）就是「三类未读」的权威，Client 按 `threadRef` 把它 join 到 Channel 行即可——这是使用 Host 的既有判定，不是在前端另立判定（禁止的是拿 `item.mentions` 之类字段自己推未读）。`directOnly: false` 今天就能调，零 Host 改动。把未读计数进一步投影进 view item 属于省一次调用的清理，放到第 3 步之后可选做
- [ ] **Iris 侧**：Thread 入口/行显示该未读；mention 只是其中一类，不改变准入；她已完成的 V2 形状（状态上移、入口行、无常驻胶囊）不受影响，未读徽标填入预留槽位
- [ ] 桌面 1440 / 窄屏 390 浏览器验收；`aria-label` 带上计数与语义
- [ ] `docs/frontend-design.md` + `.zh.md`

### 第 3 步 — 改造「提到我」为收件箱（Momo 实施，2026-09-15 完成）

**实现要点（2026-09-15 已核实）**：判定只改准入——`inbox()` 从「direct 标记驱动 + `directCount > 0` 门槛」改为「未读即入」，`directCount` 降为行内计数。级别位**未建**（决策 6 被推翻），因此没有 Attention 回放兼容问题：stored-op 的 `attentionSchema` 是 `.strict()`，多一个字段就会让历史 op 回放失败——这正是当初要「只在偏离默认时写入」的原因，现在不需要了。

- [x] **Host 扩**（纯扩、行为不变）：`inbox()` 所有条目统一带行材料（`channelName` / `taskNumber` / `previewText`）；模型可见的 notification 文本不受影响（它只读 refs 与 facts）
- [x] **Client 切**：收件箱入口停传 `directOnly`、更名「收件箱 / Inbox」、徽标＝整片未读合计、行内单列 mention 数、locales 中英、空/加载/错误态齐备
- [x] **Host 收**：删除 `directOnly` 请求标志与所有分支（`inboxCandidateThreads` 也去掉该参数）；不建订阅级别字段
- [x] **验收**：被 @ 必进；未被 @ 但 follow 的普通活动也进；与我相关的状态变化进；已 unfollow 的不进；打开只清未读、不产生订阅；Human 发起 / 回复后该 Thread 后续活动进得来
- [x] 门禁：`npm test`、`typecheck`、`lint`、`check:docs`、`npm run test:browser`
- [x] 文档：`docs/architecture.md`（Human Inbox 全量 + 写明 supersede 旧决定）、`frontend-design`、`team-collaboration`，中英双份；`CHANGELOG.md`

**「最近活跃」段（决策 9 的一半，不在本三步内）**：入选＝参与过（≥ human + 1 agent），排序＝`lastActivityAt` 降序，全局上限 10，与「需要我」段不重复显示。今天缺两件事：零未读 Thread 整条不进投影（`inbox()` 里 `unread.length === 0` 直接跳过）、没有「参与过」的投影出口（账本 `factsByThread` 有数据可算）。

## 非目标

- 不改 `../deepseek-harness`；不引入跨 Workspace 账本（Human 的「全局」仍由 Client 逐 Workspace fan-out 合并）。
- 不改 mention 的一次投递语义：级别只影响普通未读，不影响「被 @ 是否直接送达」。
- 不隐藏 Thread 内消息（2026-09-13 已定：Thread 内不过滤、600 字 clamp 保留）。
- 不做 per-message 通知偏好、不做「静音 N 小时」这类时效设置。
- #40 的「≤10 条最近活跃」浏览列表**不在本三步内**：它与收件箱（未读队列）是两件事，时间字段已有（`AgentTeamViewItem.lastActivityAt`），缺的是非未读入选与「≥ human + 1 agent 参与」判据，随配置层一起单独排。

## 实现归属（默认路径）

- 第 2 步：Iris（她那边的 Thread 入口）+ Host 供数（本工作项承接）。
- 第 3 步：Host 侧（准入改造 + 级别字段 + 删切片）由 Momo 承接（Human message:12919「顺手建」）；Client 收件箱页面与 Iris 的形状工作同批，避免同一 surface 两次改动。
- 编排与验收：如需第二人独立验收，走 Reeve / Vera。

## 正式文档出口

实现落地时：`docs/architecture.md`、`docs/frontend-design.md`、`docs/team-collaboration.md`（均含 `.zh.md` 镜像）+ `CHANGELOG.md`。`.scratch` 只留过程材料，归档前把结论搬过去。
