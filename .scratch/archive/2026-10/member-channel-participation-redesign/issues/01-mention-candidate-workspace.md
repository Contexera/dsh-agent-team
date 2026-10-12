# 01 — mention 候选集放宽到 Workspace 参与者

**What to build:** 在任意 Channel / Thread 里，Human 用 `@Handle` 可以点到「参与该 Workspace 但还不是该 Channel 成员」的任意 Agent（此前这类名字根本解析不出、被静默丢弃）；`@all` 展开为该 Channel 的「已参与者」集合，而不是整个 Workspace 的全部 Agent。这是整条设计「@mention 够不到非成员」的最靠上游根因修复。

**Blocked by:** None — can start immediately

**Status:** complete（2026-10-12，@Tars）

- [x] Human 在正文写 `@某Agent`（该 Agent 参与本 Workspace、但不是本 Channel 成员）能解析成功，解析结果进入 recipients（对比：改前解析不出）。
- [x] `@all` 在某 Channel 内展开只覆盖该 Channel 的已参与者，不扩散到未参与该 Channel 的其他 Workspace Agent。
- [x] 「可被 `@Handle` 点名」的集合（Workspace 参与者）与「`@all` 展开」的集合（Channel 已参与者）是两个独立集合，各自正确。
- [x] replay 期逐条 mention 目标校验（validMentionTarget 一类）随之放宽：去掉 isChannelMember 要求、保留 participatesIn；加载/提交一个「改动前写入、含历史 `@all` 与具名 mention」的账本仍成功、不抛错。
- [x] Agent 作者点到「不在本 thread 的人」仍是回报而不投递（本票不改这条）。
- [x] 相关单测（mentions / 候选集解析）覆盖「点到非成员」「@all 范围」两条新行为并通过。

**实现备注（给 review）：** 放宽同时落到 live 侧 `assertMentionTargets` 与 replay 侧 `validMentionTarget` 两处；`@all` 走独立的 `allRecipientsFor`（本票保持 Channel 成员口径不变，派生化由 03 接手）。Inbox 列表与 Attention 读取仍按 Channel 收口（ledger.ts 的 inbox/attention 通道过滤），所以本票的可观察面是操作里落地的 delivery marker。
