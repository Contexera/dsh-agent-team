# DESIGN：Attention 与投递

> 本文记录 Human 已确认的模型方向，不描述当前已发布行为。现状证据见 `materials/2026-10-27-findings.md`。

## 问题

当前 Thread 普通消息的投递等级同时看 Attention 和 Project owner 身份：

- 非 owner follower 的普通消息立即通知。
- owner 即使 follow，也要累计 5 条普通消息才收到摘要。
- owner 不 follow 时没有普通未读。

因此 follow 没有一致、可解释的含义。两个直接后果：

1. owner 自己 claim Task 后，别人发的普通过程消息仍可能攒到阈值才到达。
2. Task 进入 `in_review` 后，accountable 能收到状态跃迁，却可能漏掉后续验收讨论。

## 已确认的目标模型

Attention 统一回答：**哪些普通事实值得自动找到我，并具备唤醒资格。**

身份回答权限与责任，并在特定时刻建立默认 Attention；身份不再直接决定普通事实的投递等级。

```text
身份 / 责任变化
  → 在明确时刻建立默认 Attention

Attention + direct marker + responsibility/reminder marker
  → 未读与唤醒判断
  → Host 有界交付
  → Agent 按需读取正文、背景和 Task/Claim 状态
```

这不是恢复已撤回的 Thread participant grant。参与与可见性仍由现有权限模型决定；未 follow 不妨碍主动读取、history 或按权限写入。

## 三类协作信号

| 信号 | 是否要求 Attention | 投递语义 |
|---|---|---|
| 普通进展：Thread 消息、Main stream 普通更新 | 是 | follow 即具备立即唤醒资格；不 follow 不产生普通未读 |
| 直接召唤：@、reply | 否 | 立即通知，不自动建立 Attention |
| 责任信号：分派、待验收、转交、私人 Task reminder | 否 | 立即通知，不能通过 unfollow 退掉 |

DM 保持独立的私人直投通道，不为了形式统一塞入 Thread Inbox。

Attention 统管普通事实的**自动发现与唤醒资格**，不管权限、责任归属、正文预算或全部历史内容。Host 仍负责通知合并、限界和正文选择。

## 默认 Attention

| 事件 | 默认行为 |
|---|---|
| Human Project owner 建立 Project | 默认 follow 该 Project Main stream |
| Agent 获得 Project owner 身份 | 默认 follow 该 Project Main stream |
| Member 创建 Thread | 作者 follow 该 Thread |
| Member 成为 Task accountable | follow 对应 Task Thread |
| Member 建立 Claim | follow 对应 Task Thread |
| reopen Task | 保留现有恢复 accountable Attention 的规则 |
| close Task | 保留现有结束 Attention 的规则 |
| 被 @、被 reply、在已有 Thread 普通发言 | 不自动 follow |

Project owner **不默认 follow 项目内全部 Thread，也不因后来新开 Thread 而自动 follow**。Main stream 是它默认的项目级注意力面；具体 Thread 由责任关系或显式选择决定。

Main stream 对非 owner 同样可 follow/unfollow。普通更新的未读与投递不再要求 owner 身份。

## 身份变化与既有 Attention

身份只负责在明确事件中建立默认 Attention。身份撤销不自动收回 Attention：此时持续关注可能已经成为 Member 自己的选择。

因此 owner 被撤销后：

- 失去 owner 权限及相应责任；
- open Task 按现有规则转回 Human；
- 已存在的 Main stream / Thread Attention 不因身份撤销而自动删除；
- 可以显式 unfollow 普通进展。

不得根据当前身份重新解释一批历史普通事实的投递等级。

## 移除 owner threshold

移除按 Project owner 身份累计 5 条普通消息的 threshold，不保留动态阈值或另一套身份特例。

`follow = 允许普通更新立即唤醒`，但立即不等于每条消息必须开启一个独立模型 turn。Host 可以继续：

- 合并尚未进入模型的通知；
- 在运行中的 Agent 的安全边界统一交付；
- 一次通知汇总多个来源；
- 保持有界的正文、Thread 数和字符预算；
- 对同一批未读去重。

随着 threshold 移除，`summarizedThrough` 及其进程内阈值簿记应一并删除；普通未读仍以 durable Attention / Main stream 水位和 marker 重新派生。

## unfollow 的边界

- unfollow 停止普通更新，不退出 Project，不撤销可读历史，不释放 Claim，不转移 accountable。
- @、reply、责任事件和 reminder 仍然到达。
- 有 active Claim 时继续禁止 unfollow；Claim done 或 released 后可以 unfollow。
- accountable 可以 unfollow 普通过程，但不能退掉自己的责任通知。
- 再次 follow 恢复其后的普通更新；更早内容通过主动读取和 history 获取。

## Main stream 纳入同一体系

最终设计在本工作项内包含 Main stream，不能只改 Thread 后长期保留另一套 owner-only 未读规则。

目标语义：

- Main stream 与 Thread 都由 Attention 决定普通更新的自动发现。
- 两者可分别 follow/unfollow，并有各自连续的读取进度。
- direct marker 与责任 marker 继续独立存在。
- Main stream 的普通未读不再由 `ownerSinceFrom` 身份区间派生。
- 现有 owner 的默认关注在迁移时建立，不能借迁移清空其尚未读取的普通工作；具体 durable 记录在实现票据中确定。

实现可以分 vertical slices 推进，但最终只保留一套普通 Attention 语义，不保留 owner-only Main stream 兼容分支。

## 迁移原则

采用一次性新语义，不增加按 rules version 保留的旧投递分支。

- 已存在且仍有效的 Thread Attention 直接获得新投递语义。
- 为现有 Project owner 建立默认 Main stream Attention，并保持已有未读工作的连续性。
- 删除 threshold、owner-only Main stream 普通未读派生及仅为旧结构补偿的唤醒 fan-out。
- direct marker、责任 marker、reminder 与读取确认的 durable 语义保持。
- 重放校验必须覆盖迁移后的持久表示，不能只验证新写路径。

## Agent 对 Attention 的理解与管理

代码改变投递行为之外，还要让 Agent 在 context 中理解并管理 Attention。

### 稳定规则：persona / system prompt

说明：

- follow 持续接收普通更新；unfollow 停止普通更新。
- unfollow 不影响 @、reply 和责任信号。
- 不再参与或无需持续跟踪时可以 unfollow；需要持续跟踪时可以再次 follow。
- unfollow 不是退出 Project、放弃 Task 或释放 Claim。
- 有 active Claim 时不能 unfollow。

稳定规则放 persona / core skill；当前状态由动态 context 和工具结果提供。

### 状态变化：工具结果

自动建立 Attention 时，结果应简短说明：

- 现在 follow 哪个 Main stream / Thread；
- 本次为什么建立（owner、accountable、Claim、作者等）；
- 普通更新会自动到达；
- 如何 unfollow，以及 unfollow 后哪些直接/责任信号仍到达。

显式 follow 成功时说明普通更新从现在开始到达，历史仍可读取。unfollow 成功时说明普通更新停止、直接和责任信号保留、可再次 follow。

有 active Claim 而拒绝 unfollow 时，说明完成或释放 Claim 后才能操作。

### 读取与通知：当前状态

Thread / Main stream 读取结果和必要的通知中，用一行说明 `following` 或 `not following` 及其普通更新后果，不重复整段教学。

如果当前事实无法可靠说明最初为何 follow，就只显示状态，不猜原因。

### 一次性直接通知

@ 或 reply 不自动 follow。需要提示时，应在接收者自己的读取/Attention 结果中说明「直接通知不等于持续关注；follow 可接收后续普通更新」，不要在每次向他人发消息时重复。

## 呈现职责与相邻工作项

本工作项规定必须表达的 Attention 语义和验收场景。统一的「状态 → 语义 → tool result / notification / error / prompt 渲染」机制由 [`../agent-tools-context-rendering/`](../agent-tools-context-rendering/) 审视与设计。

Attention 是该呈现机制的第一个完整用例，但投递模型不应等待一次全工具重写才开始落地。结构化字段保持机器消费的权威；自然语言提示是辅助，不能成为另一份状态来源或要求 Client 解析。

## 验收测试缝

1. 普通投递判定：同一 Member 是否 owner 不再改变结果；follow 即 immediate，不 follow 即无普通未读。
2. Main stream 对称：owner 与非 owner 都能显式 follow/unfollow，普通更新遵守同一规则。
3. 默认 Attention：owner 授权只建立 Main stream 默认关注，不批量订阅已有或未来 Thread。
4. 责任与直接信号：unfollow 后普通更新停止，@、reply、责任 Activity 和 reminder 仍到达。
5. Claim 边界：active Claim 禁止 unfollow，done/released 后允许。
6. 身份撤销：权限和责任按现有规则变化，既有 Attention 不被隐式删除。
7. Host 交付：多个即时事实仍有界合并；取消 threshold 不等于无界逐条通知。
8. Agent 指导：自动 follow、显式 follow、unfollow、拒绝 unfollow 和直接通知的结果说明与领域语义一致。
9. 持久化与重放：现有 owner 的 Main stream 默认关注与未读连续性得到保留，不保留旧 rules-version 投递分支。

## 实现时仍需落定，但不改变已确认模型

- Main stream Attention 的 durable 表示、现有账本的一次性转换和读取水位迁移。
- 默认 Attention 的写入结果需要携带哪些结构化变化，才能让工具结果准确说明原因。
- 各工具、通知和 persona 的最短文案及 token 预算，由相邻渲染工作项统一审视。
- 实现票据见 [`issues/`](issues/)：01 Thread 投递改判 Attention → 02 移除 threshold 簿记 → 03 Main stream 并入 → 04 默认 Attention 与身份变化 → 05 Agent 指导。
