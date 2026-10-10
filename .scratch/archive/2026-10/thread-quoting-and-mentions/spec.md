# 引用与 mention 的语义（已确认的决策快照）

本文件是 Human 在 2026-10-10 逐条确认过的裁决，讨论已收敛。**它是决策记录，不是 API 权威**——当前行为以 `packages/` 源码与测试为准。

## 1. 引用长在哪：三层，各一件事

引用的本质是**一条消息指向另一条消息**，所以它是 Ledger 的事实，不是 UI 状态。

| 层 | 职责 | 关键性质 |
| --- | --- | --- |
| 存储（`spec.ts` 的 durable schema） | 只存**父的身份**：`replyToMessageRef` 一个可选字段 | durable 记录每次打开都严格解析；**写路径存了而 schema 没命名的字段会让整个域无法重开**，所以加 durable 字段必须同笔加进 schema |
| Host（`index.ts`／`ledger.ts`） | 写时校验 + 读时解析 + 投影 | 写时 `requireReplyParent`：ref 必须存在且**必须同 Thread**（跨 Thread 会渲染成读者看不到的对话，未知 ref 会悬空，两者都在写时拒绝）。读时一次性解析整个窗口。投影**新建对象，绝不原地改**（facts 是 durable read 的载荷，原地写会抛或让持久数据长出 schema 不认的字段） |
| 工具（`team_thread`／`team_message`） | 让 agent 能写、能读回 | 见下 |

**`replyTo` 刻意放在存储的 ThreadFact 之外**：它是读时投影，不是 durable fact ⇒ 存储 schema 未动，老账本原样读回、无需迁移。

**只存 ref 换来的性质**：摘要由 Host 从 Ledger 自己的记录解析 ⇒ **引用永远不可能与它指向的消息不一致**；父消息在读者已加载的历史窗口之外也能解析。

## 2. Agent 怎么用：mention 与引用的判据

**核心区别一句话：mention 决定「谁必须看到」，引用决定「这句在回答什么」。** 前者是**收件人**，后者是**结构**；它们只在「投递」这一件事上重合。

| | mention（呼叫） | 引用（应答） |
| --- | --- | --- |
| 怎么写 | 正文里写 `@Handle` | `team_message.reply` 的 `replyToMessageRef` |
| 指向 | 人（可多人、`@all`） | 一条**已存在的**消息（同 Thread） |
| 送达 | 被点名者 | **父消息的作者一人**（自动，不必再打 handle） |
| 特殊 | **可以叫 Human**；被叫者不必在对话里说过话 | **跳 Human**（他直接读 Thread，没有可投递的 session）；跳过自己 |
| 场景 | 要某个人的输入、要他接手、通知他还没参与的结果 | 回答同侪的具体问题；长 Thread 里标明这句针对哪一句 |

**边界情况**（此前最容易含糊的地方）：

- **接续对话（最常见）⇒ 两个都不用。** 跟帖说下去既不用引用也不用 `@`——Thread 的参与者本来就会看到。
- **叫一个还没参与这个 Thread 的人 ⇒ 只有 mention**，且**可能叫不到**：工具会报 `undeliveredMentions`（该成员 never took part in this Thread）。此时正确做法是 `dm` 或请 Human 邀请——**只有 Human 能把从未参与该 Thread 的 Member 拉进来**。
- **引用不会扩大收件人范围**：只送达原文作者一人，且**恰好**覆盖「我在回答他」这种情况 ⇒ 回答某人**不需要再 `@` 他一遍**。这正是引用能减少 mention 噪音的原因。

**「会不会导致满屏引用」的防线（写进 tool description）**：

> 跟帖续话不要填 `replyToMessageRef`。只有当你这句是针对**某一条具体发言**作答时才填。引用是为了消除「这句在说哪句」的歧义，不是为了标注「我在这个 Thread 里说话」。

**人数判据（Human 给）**：参与人数越多（大致 **≥3**），Thread 越容易出现「这句在回答哪一句」的歧义，此时引用收益最大；少数人（尤其两人来回）时，直接接续或必要处 `@` 通常就够。

## 3. 读者看到什么（其他 member 侧）

渲染是**内联从句**，不是独立引文块：

```
12 14:32 [@Sage] (replies to @Reeve — "那只像素 beagle 配色错了") 我改了配色，你再看下
```

- 摘要**由 Host 解析**（excerpt = 首行 trim，cap 120），发送方不提供 ⇒ 永不与原文矛盾。
- 父在窗口外也能解析（整批一次性解析，不依赖读者加载了哪些历史）。
- **解析不到时退回裸 ref**：`(replies to message:0f0a…)`，不失败也不编造；归档 Channel 即此情况，此时 ref 是唯一还能说的真话，并提示可用 `team_thread message` 取原文。
- 结构化输出里**两个字段刻意分开**：`replyToMessageRef`（回传给 `reply` 的 ref）与 `replyTo: {sender, excerpt}`（读者看到的东西）——合一会各错一半。
- 深读：`team_thread` 的 `message` action 按 ref **逐字**读回一条（唯一 verbatim 的 action，因为读者是要点名回答它）。
- inbox 通知同样带：`Replies to: @作者 — "摘要" [message:<uuid>]`。

## 4. UI 裁决

| 项 | 裁决 | 理由 |
| --- | --- | --- |
| 「会送达 {name}」 | **删掉**，并进现有「将通知：{ids}」行（`composerNotify`） | 引用本质就是一次 mention，不该单独宣告第二遍。**前提**：`TeamComposer` 的 `replyTo` 现无 memberId ⇒ 要把 `AgentTeamResolvedMessageRef.sender` 穿过来 |
| `@human` chip 颜色 | **`--dsw-alias-state-success-primary`** | 不用 error／warn 那档（会读成报错／警告）。本仓可用 state token 仅 `business-primary`／`error-primary`／`success-primary`／`warn-label`／`warn-tertiary`。做法：加 `[data-mention-human]` + 一条 CSS 分支 |
| 头像像素取色 | **不做** | ①有上传头像时显示的是照片本身，无底色可取 ②本仓零 canvas 代码，要新起管线 ③换头像会导致同一句历史消息换色，违背稳定标识 ④28px 主色对比度不可控 |
| chip 渲染 | **保留现状** | 正文里的 `@Handle` 本来就会被扫描并送达，chip 是这件事的呈现 |
| 引用行样式 | 前六轮已定：**2px 静音竖线 + 12px 安静文字**，无填充／面板／蓝条／上方标签 | 复用 shipped Markdown 块引用形态（`--dsw-alias-label-caption`，opacity .5） |
| 引用入口 | 留在 **hover 卡**里（要点一下），不是常驻按钮，输入框默认态也不提示 | 不给「顺手一点就引用」的诱导，默认路径仍是直接打字发送 |

## 5. 已知缺口（本轮要补）

- **`TeamComposer` 的 `replyTo` 缺 memberId**：不补就无法把被引作者并进「将通知」行（`composerNotify`），也就删不掉 `quoteDeliversTo`。

**已核销的一处误判（我自己报错、已更正）**：我曾说「`team_thread read` 那一批的 fact 视图没有 `replyToMessageRef`／`replyTo`，PR 只改了 `history` 分支和 anchor」——**这是错的**。实测 PR 的 `read` 分支（`tool-agent-team/src/index.ts:434`）与 `history` 分支（`:407`）、anchor（`:482`）三处**都带**这两个字段；`team_inbox` 返回的是 Thread 级条目（`unreadCount`／`directCount`），不构造单条 fact，它的 `Replies to:` 明细走 Host 的 notice 渲染（`repliesToLine`），也不需要该字段。**结论：工具侧无缺口，无需改动。**

## 6. 不做的事

- 把 mention 换成引用（结构上不可替代：叫不进未参与者、够不到 Human、无 `@all`）。
- 让 mention 变成「需要 Human 决策」（agent 之间的互相呼叫是协作基本动作，逐个审批会把每个「@某人 你看一下」变成 Human 的待办队列）。
- 解析头像像素取色。
- 删除消息、编辑消息（append-only 账本，UI 上没有对应写面）。
