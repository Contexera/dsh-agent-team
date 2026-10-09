# Thread 消息回复（引用回复）

## 状态

**已实现，待浏览器验收** — 4 张 ticket 全部完成，Host 与 Client 测试通过，已构建并安装到 desktop profile。

## 最后核对日期

2026-10-07

## 当前前沿

- 已完成：数据模型勘察（见下）。
- 已完成：原型 `.scratch/active/thread-message-reply/prototype/reply.html`。
- 已确认：O1 仅 Thread；O2 回复自动送达原作者；O3 只存 messageRef 由 Host 解析；O4 按原型（引用块带左侧竖线）。
- 待你确认：浏览器里的实际观感（桌面 / 390×844）。
- 阻塞：无。

## 关键勘察结论

`AgentTeamMessage`（`packages/agent-team/src/types/entities.ts`）**当前没有任何父消息字段**：

```
messageRef / channelRef / threadRef / taskRef? / sender / body /
attachments? / topLevel / sequence / occurredAt
```

所以「回复」不是纯前端功能，需要一条完整链路：消息实体加可选字段 → ledger 写入 → 投影与序列化 → durable read 暴露 → Client 渲染。可参考 `occurredAt` / `taskRef` 的做法：可选字段、replay 时归一化，保证旧 ledger 仍可读。

## 已完成的前置修复（与本次需求无关）

- 气泡宽度改为**按内容收缩、最多占满整列**（短消息不再铺成整条）。
- 气泡填充与圆角统一为 shipped 聊天气泡配方（`--dsw-specific-bubble` + `--dsw-radius-xl`）。
- 已构建并安装到 `desktop` profile。

## 完成条件

- 在 Thread 时间线上可以选中任意一条消息并回复。
- 回复消息自身携带对父消息的引用，读者可跳回原文。
- 明暗主题、390×844、键盘可达（不能只有 hover 才能操作）。
- `npm run test:browser` 通过。

## 正式文档出口

- `docs/team-collaboration/attention-and-messaging.md`（若回复改变提及/通知语义）
- `docs/team-collaboration/model-and-time.md`（消息引用的领域语义）
- `docs/frontend-design/components.md`（`TeamMessage` 的引用块契约）
- `docs/frontend-design/thread-and-composer.md`（composer 引用条）

## 目录

- [`spec.md`](spec.md) — 决策快照与未决项
- [`prototype/reply.html`](prototype/reply.html) — 交互原型，浏览器直接打开
