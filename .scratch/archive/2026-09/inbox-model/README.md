# Inbox 模型统一（human / agent 同一套订阅与投递）

## Status

**已完成并归档（2026-09-15）。** 三步全部落地：① 模型收敛（本目录 `spec.md`）→ ② Iris 侧 Thread 入口采用（c57e0b0，验收于 thread:8939bf7e）→ ③ 改造「提到我」为收件箱（Host 准入 + 删 `directOnly` + Client 页面，随本目录的归档提交一起落地）。

决策正本是 [`spec.md`](spec.md) 的九条；durable conclusions 已搬进 `docs/architecture/README.md`、`docs/frontend-design/README.md`、`docs/team-collaboration/README.md`（均含 `.zh.md` 镜像）与 `CHANGELOG.md` `[Unreleased]`。本目录只保留决策与过程材料。

last-checked: 2026-09-15（当日门禁实跑：`npm test`、`typecheck`、`lint`、`npm run test:browser`）。

## 交付与验收结果

- **第 3 步交付（Momo）**：`inbox()` 收敛为单一未读切片——准入＝有未读事实，所有条目统一带行材料（`channelName` / `taskNumber` / `previewText`），`totalUnreadCount` ＝未读合计；`inboxCandidateThreads()` 与 `AgentTeamInboxRequest` 删除 `directOnly`；Client 侧「提到我」更名「收件箱 / Inbox」、徽标＝整片未读、行内 mention 计数；locales 中英、`.rowMentions` 样式、测试与 `scripts/team-ui.e2e.ts` 同批改动。
- **未建订阅级别字段**：Human message:12986 推翻原决策 6——列表分两段后，「只看 mention」由分组本身表达，不再需要配置项。因此也没有 Attention 回放兼容问题（stored-op 的 `attentionSchema` 是 `.strict()`，多一个字段会让历史 op 回放失败）。
- 门禁实跑（2026-09-15）：`npm test` 601 passed | 1 skipped（含 `check:docs`、`check:core-skills`、`check:boundaries`）；`typecheck`、`lint` 全绿（1 个既有 warning：`scripts/check-package-boundaries.mjs` 未使用 `sep`，非本次引入）；`npm run test:browser` 真 Web 全旅程通过（截图在 Git 忽略的 `artifacts/browser/`）。
- 归档基线：归档前 master 为 c57e0b0。本次只动 Host / Client / 测试 / `docs/` / `CHANGELOG.md` 与 `.scratch/**`，未改 `../deepseek-harness`。仓库仍未推送远端。

## 视觉层后续（不在本工作项内）

Human 2026-09-15 16:22 在 thread:65e0e365 判定当前收件箱「样式效果一般」；视觉层（行布局、mention 数呈现方式、页头计数行、空 / 加载态、与频道 feed 入口的视觉统一）改由 Iris 承接，功能契约留在本次交付。本工作项不再追踪它。

## 决策正本要点

[`spec.md`](spec.md) 有全部九条与三步验收口径。要点：入口更名「收件箱 / Inbox」；准入＝我的全部未读（mention 降为三类未读之一）；follow＝发起或回复过（只打开不算）；只打开不产生订阅；agent 侧机制相同、默认策略不变；**不建订阅级别字段**；列表分两段——「需要我」＝未读队列（徽标来源）、「最近活跃」＝参与过的 Thread、上限 10、按 `lastActivityAt` 降序、同一 Thread 只在一段出现。

**「最近活跃」段尚未实现**（决策 9 的一半）：今天缺两件事——零未读 Thread 整条不进 `inbox()` 投影（`unread.length === 0` 直接跳过），且没有「参与过（≥ human + 1 agent）」的投影出口（账本 `factsByThread` 有数据可算）。随配置层线（thread:1ec676b5）单独排。

## 材料

- [`materials/current-model.md`](materials/current-model.md) —— 改造前 human 与 agent 的 inbox 哪里同、哪里不同（代码 + 账本实证）。
- [`materials/unified-model-proposal.md`](materials/unified-model-proposal.md) —— 统一方案草案、成本与当初的待拍板决策点（其中「订阅级别」一条已被推翻，以 `spec.md` 决策 6 为准）。

## 前序工作项

- [`../human-mention-inbox/`](../human-mention-inbox/)（2026-09-13 归档）：Human「提到我」direct-only 切片 + 页面。本次把它升级为收件箱并删除 `directOnly`，没有推翻它的展示结论。
