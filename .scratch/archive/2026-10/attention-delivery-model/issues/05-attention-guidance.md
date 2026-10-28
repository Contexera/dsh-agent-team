# 05 — Agent 对 follow/unfollow 的指导

**What to build:** 一个 Agent 在被自动关注、主动 follow/unfollow、被拒绝 unfollow、或收到一次性直接通知时，从工具结果里得到一致且简短的说明：现在关注什么、为什么、unfollow 后哪些信号仍然到达、如何恢复。稳定语义（follow/unfollow 不改变 Project 归属、Task 责任和 Claim 状态）进入 persona / core skill，不在每次结果里重复整段教学。

**Blocked by:** 04 — 默认 Attention 与身份变化（已完成）

**Status:** complete — 工具面、文案与稳定规则已落地；呈现机制的通用化归 `agent-tools-context-rendering`

- [x] persona / core skill 说明稳定规则：follow 持续接收普通更新；unfollow 停止普通更新；unfollow 不影响 @、回复、责任事件和 reminder；unfollow 不等于退出 Project、放弃 Task 或释放 Claim；有 active Claim 时不能 unfollow
- [x] 自动建立关注的结果说明对象与已知来源（owner / accountable / Claim / Thread 作者），并说明普通更新会自动到达、如何 unfollow
- [x] 显式 follow 成功说明从当前开始的普通更新会到达、更早内容可主动读取；unfollow 成功说明普通更新停止、直接与责任信号保留、可再次 follow
- [x] 有 active Claim 而拒绝 unfollow 时，说明需要先完成或释放 Claim
- [x] Thread / Main stream 读取结果用一行说明当前关注状态与后果，不重复教学；@ 与 reply 不自动建立持续关注这一事实在接收者自己的读取或关注查询中说明，而非在每次向他人发消息时重复
- [x] 呈现层的具体文案与预算遵循 `agent-tools-context-rendering` 的统一机制；本票只负责 Attention 用例的语义完整
- [x] 单测覆盖上述每个场景的说明文案，测试断言语义而非逐字匹配可调措辞

## 实施说明

- `team_attention` 新增 `projectRef` 寻址（Main stream 面），与 `threadRef`/`taskRef` 互斥；同传两者或三者皆空都被拒绝，并给出恢复指引。
- `team_attention` 的 render 现在带一句「后果」：
  - following → `Ordinary updates from there will interrupt you; mentions, replies and responsibility events already did.`
  - not following → `Ordinary updates will no longer interrupt you. Mentions, replies and responsibility events still will; follow again to resume.`
- `team_thread` 的 Main stream read 加一行 `Attention: following / not following`（not following 时给出 follow 的入口）；Thread read 在未关注时追加一句同类提示。两者都不重复整段教学。
- persona 与 `team-domain-model` core skill 的旧「owner 攒 5 条」规则已删除，改为「没有更慢的等级」；core skill 新增 owner 授权只 follow Main stream、unfollow 不放弃责任等稳定规则。
- core skill 有 7850 字符硬预算（dsh-developer 上限减 150 余量），因此细节留在工具结果与 render 中，skill 只放稳定规则——这正是 `agent-tools-context-rendering` 要统一的「常驻与按需」分界。
- 测试在 `team-tools-render.spec.ts` 中断言语义（含「unfollow 后 mention/reply/责任事件仍到达」），不断言整段逐字。

## 未做（明确不在本票）

- ~~自动建立关注时说明「为什么 follow」~~ **已完成（2026-10-28）**：Attention 行新增 `source` 字段，六种来源 `thread-author` / `claim` / `accountable` / `project-owner` / `mention` / `self`。reopen 归入 `accountable`（它是「恢复」而非「新建」，与被指定 accountable 同源）。`team_attention` 在已 follow 时渲染原因；Claim 与 Thread start 说明自己刚建立的 Attention。存储上可选，因此旧账本字节不变；缺省值由写入它的 operation 种类推导（grant → `project-owner`、claim → `claim`、thread-started → `thread-author`、transfer/reopen → `accountable`），因此**重放校验保持严格**——按规则版本猜默认值既不准（v1 段也能显式 follow 和 claim），又会迫使校验放宽容忍字段。
- 未把文案收进统一的语义视图层——等 `agent-tools-context-rendering` 定型后再迁移，避免现在造一个会被推翻的抽象。
