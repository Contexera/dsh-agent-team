# 02 — Owner、Main stream 与按责任投递

**What to build:** Human 可以给一个 Project 指定和撤销 Agent owner，被指定的 Agent 立即收到通知。每个 Project 有独立于 Thread 的 Main stream：Project member 都能在里面发消息；只有 owner 能通过 composer 的“讨论/任务”开 Thread；讨论 Thread 与无来源的 Task 以卡片出现在 Main stream 中，旧 Thread 与旧 Task 同样以卡片出现，升级后的主对话与原 Channel 连续。通知按责任走：Main stream 消息立即通知其他 owners；owner 在 Thread 中收到的普通消息攒满 5 条才打断；点名和带回复链接的消息立即通知被指向者；不再有 participant 门槛、邀请确认与 `@all`。Agent 的 persona、每轮 owner 角色块与新的 `team-domain-model` skill 让 Agent 按这套规则行动。完成后 Human 试用一周。

**Blocked by:** 01

**Status:** pending

- [ ] 首次挂载时在任何其他写入之前追加 `team/rules-version-adopted`（版本 2）；版本 2 之前的记录按旧规则校验，之后按新规则；版本标记重复、倒退或晚于该版本写入时加载失败
- [ ] Project member 按 spec §2 派生（Human 恒可见；Agent = 旧显式 membership ∪ 当前参与 Workspace 且在该 Project 被 mention、发言、认领或 follow 过；排除 archived/inactive），取代旧的 Channel 可见性判断；旧数据下 Agent 可见集合不减少
- [ ] Human 在 Project 设置中增删 Agent owner；Human 恒为 owner 且不可移除；目标须参与该 Workspace；新 owner 收到 immediate 通知，Main stream 中留下 owner 变更记录
- [ ] `team_message.post` 与 Human composer 默认写 Main stream；owner 有 Main stream 未读时写入被要求先读；`replyToMessageRef` 限同一 scope
- [ ] `team_message.start` 与 composer “讨论/任务”只对 owner 开放；非-owner 得到 `project_owner_required` 并被指向 `post`
- [ ] Project member 可在任何 Thread 回复；回复不自动 follow；mention 只产生一次 direct 通知与 Project 可见性，不开始也不恢复 Attention；Human 邀请确认流程删除；新消息中 `@all` 是普通文本
- [ ] Main stream 卡片：讨论 Thread、无来源 Task、旧顶层 Thread、旧 Task 按创建顺序显示；新讨论 Thread 对其他 owners 算一条 Main stream 未读，Task 卡片与旧卡片不产生未读
- [ ] Inbox 每 Project 一行 Main stream（owner 的普通未读 + 点名）；Human 收件箱以蓝点 / 白点区分 direct 与 ordinary；`team_inbox` 渲染相同计数
- [ ] 投递等级按 spec §7 运行时计算：Main stream 普通消息与新讨论 Thread 对其他 owners immediate；owner/accountable 的普通 Thread 消息按“每 Member × 每 Thread”满 5 条摘要，不足的随下一次 immediate 带出；其余 follower immediate；一组测试固定住“不打断”的边界
- [ ] Inbox notice 带 delivery、cause、scope、scoped role、source ref 与读取入口；`team_view` 的 Project 行带 owners 与我的角色；`member-context` 增加 owner 角色块且内容不变时不重复注入
- [ ] persona 整体改写（行为规则 + 8 行以内角色速查，写明“回答 owner 要点名或带链接”）；新增 bundled core skill `team-domain-model`
- [ ] 旧 ledger replay 不受影响；新规则只作用于版本 2 标记之后的记录

## 验收方式

dev profile 上：Human 给 UI-UX-AX 指定一个 Agent owner；该 Agent 在 Main stream 发言，Human 与另一位 owner 收到；非-owner Agent 尝试开 Thread 被拒并改为 post；owner 开讨论并点名一个执行者，执行者不 follow 直接回复，owner 在第 5 条普通消息或被点名时才被打断。浏览器检查 composer、卡片与收件箱蓝白点在桌面与 390×844 下的显示和键盘可达性。
