# 需求决策快照 — Thread 聊天气泡 + 「有人@我」

本文件记录**已确认**的决策；未决项单列在最后一节，确认后再并入正文。

## 1. 已确认决策

### D1 — 范围：把现有 Thread 时间线改造成气泡对话流

- 改造对象是 [`packages/client-agent-team/src/client/TeamThreadPage.tsx`](../../../packages/client-agent-team/src/client/TeamThreadPage.tsx) 渲染的时间线，消息行由 [`TeamMessage.tsx`](../../../packages/client-agent-team/src/client/TeamMessage.tsx) 产出。
- 不新增独立页面、不做视图切换。Channel 页 `TeamChannelPage` 的顶层 feed **不在**本次范围内。
- 因此改动集中在：`TeamMessage.tsx`、`TeamThreadPage.tsx`（分组与传参）、`conversation.module.css`、`locales.ts`，以及对应测试。

### D2 — 「有人@我」的判定：结构化 mention 事实

- 判据：该条消息 fact 的 `mentions` 数组包含 Human 的 durable id `member:human`（`AGENT_TEAM_HUMAN_MEMBER_ID`）。
- 这是 Host 的投递事实（`AgentTeamThreadFact.mentions`，来自发送操作的结构化 recipients），不是客户端正则扫描，因此与「谁会真的收到通知」严格一致。
- 不新增 Remote 方法、不新增 Host 投影：数据已经在客户端手上（`TeamThreadPage` 已把 `fact.mentions` 传给 `TeamMessage` 做 inline 高亮）。

### D3 — 原型形态：单文件 HTML

`prototype/bubbles.html`，浏览器直接打开，含明暗主题切换、390×844 设备切换、徽标两种形态对照、紧凑模式开关。

## 2. 视觉规则（原型中实现，待确认）

| # | 规则 | 理由 |
| --- | --- | --- |
| V1 | 人类（读自己）气泡靠右、业务色浅底；Agent 成员靠左、中性底 | 聊天气泡让「谁在说」一眼可辨；按发言者身份而非按内容类型分侧 |
| V2 | 同一发送者连续消息合成一个视觉组：头像与昵称只出现一次，组内气泡收角 | 现状已有 `run`/`grouped` 概念，气泡化后沿用 |
| V3 | 「有人@我」= 气泡描边 + **气泡内部右上角的徽标**（块级首行、右对齐；正文在徽标下方开始） | 醒目但不改变左右归属；读者不会因为一条 Agent 消息 @ 了自己就误以为那是自己说的。标记不占用昵称行，也不与 `grouped` 分组规则冲突 |
| V4 | 超过 600 字默认裁切 + 渐隐 + 「展开」文字链接 | 沿用现有 `MESSAGE_COLLAPSE_CHARS` 规则，不引入新阈值 |
| V5 | Activity 行、日期分隔、未读分界不套气泡 | 它们是时间线事实而非某人的发言；套气泡会假装有个发送者 |

## 3. 未决项（已在实现时按下述默认裁定）

### O1 — 人类气泡是否也画头像

**裁定：保留双头像。** 头像在两侧都留在文档流中，气泡因此始终落在同一条轴上，改动面最小。右栏去掉头像会同时改变现有 DOM 契约与栅格对齐规则。

### O2 — 「有人@我」徽标是否与未读关联

**裁定：按历史事实。** 只要消息的 `mentions` 含 `member:human` 就标记，读过之后标记仍在——「这条消息提到了我」是历史事实，不是未读提醒。实现不需要读 `AgentTeamThreadReadFact.unread`。

### O3 — 是否在「跳到底部」提示上叠加「N 条提到你」

**裁定：本次不做。** 需要把未读批次里的 direct 事实聚合到 jump hint，属于另一个改动面；当前 `newUpdatesJump` 文案保持不变。

## 4. 影响面（实现前勘察结论）

- 挂载点：`TeamThreadPage.renderFact()` 构造 `TeamMessage`；`renderFactBlocks()` 负责 run 分组与 `grouped` 标记，已具备 V2 所需信息。
- 样式权威：`packages/client-agent-team/src/client/conversation.module.css` 的 `.messageRow` / `.messageIdentity` / `.messageName` / `.messageBody` / `.messageText` / `.messageClamp`。
- 文案：`locales.ts` 的 `zh` / `en` 两个块 + `TeamKey` 类型（新增键必须两边同时加）。
- 测试：`packages/client-agent-team/tests/team-message.client.spec.tsx`、`team-mode-conversation.client.spec.tsx` 及其快照 `tests/__snapshots__/`。
- 不涉及：RPC / Typert 生成物、Host ledger、preset。
