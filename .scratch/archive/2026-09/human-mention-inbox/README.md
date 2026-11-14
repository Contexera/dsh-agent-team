# Human「提到我」Inbox + mention prompt

## Status

**已完成并归档（2026-09-13）。** 交付 `0326ca6`（PR #20：Host direct-only 切片、四面 Inbox、mention prompt 收窄）与 `2ee8224`（跨 Workspace 全局降序、队列行卡片、今天/昨天时间语义、页头计数行）。
durable conclusions 已移入 `docs/frontend-design/thread-and-composer.md` 的 `### Mention Inbox (提到我)`（含 `.zh.md` 镜像）与 `CHANGELOG.md` `[Unreleased]`；本目录只保留设计过程与验收痕迹。

last-checked: 2026-09-13（当日门禁实跑 + Vera 独立复验）。

## 归档基线

归档时代码与 docs 的内容树为 `9b93d36c733f20ba46999fad147e8d55cd52adcf`（= Vera 复验时锚定的树）；本次归档只新增 `.scratch/**`，代码、docs、scripts 一行未动。
仓库未推送：master ahead 6，push 为 fast-forward（等 Human 一句话）。

## 交付与验收结果

- 门禁（2026-09-13 实跑）：`npm test` 549 passed | 1 skipped；`npm run test:browser` 1 passed（真 Web 全旅程 26.6s）；`typecheck`、`lint`、`check:docs`、`check:core-skills`、`audit-ui-parity` 全绿。
- 独立复验（Vera，隔离 clone）：门禁六连 + 承重探针 10/10（含 `.row` 8→7px、`.rowTask` 6→5px 两条新 pin 的负例，audit exit 1 且精确点名）+ `TZ=Asia/Shanghai` / `TZ=UTC` 各 14 例时间语义 + docs 对代码逐条核对，结论通过。
- 一处根因留档：「行无正文、只剩 `dsh-agent-team / #`」不是代码缺陷——宿主进程启动时点早于 PR #20 合并，Host 模块在进程启动时进内存；重启 profile 即恢复。

## 需求快照

- [`spec.md`](spec.md) —— 已确认决策正本（Human 2026-09-13 拍板）。
- [`discussion.md`](discussion.md) —— 讨论痕迹与 Human 原话。
- [`materials/prompt-draft.md`](materials/prompt-draft.md) —— persona 草案。
- Human 定死的行信息顺序：`workspace → channel → task → 顶层消息（截取）→ 时间`；「顶层 Thread 的精简显示」= Host `previewText`（120 字帽），不是另一种卡片。

## Tickets（均已交付并验证）

- [01 Host direct-only 投影](issues/01-direct-inbox-projection.md)
- [02 Client「提到我」入口与页面](issues/02-inbox-surface.md)
- [03 mention prompt 与文档收口](issues/03-mention-prompt.md)
