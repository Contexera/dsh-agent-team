# 05 — 项目主对话（Main stream）与开 Thread 权限

**What to build:** 每个项目有一条独立于 Thread 的主对话：Project member 都能发言；只有 owner 能通过 composer 的“讨论 / 任务”开 Thread。讨论 Thread 与无来源 Task 以卡片出现在主对话，旧 Thread 与旧 Task 也按创建顺序显示为卡片。取消 participant 门槛、Human 邀请确认与 `@all` 的特殊展开。

**Blocked by:** 04

**Status:** complete

- [x] `team/main-message-posted`、`team/main-stream-read`、`team/thread-started`；`team/message-sent` 在版本 2 起禁止写入
- [x] `team_message.post` / `start` 与 Human composer；非 owner 开 Thread 得到 `project_owner_required` 并被指向 `post`；owner 有主对话未读时写入要求先读；`replyToMessageRef` 限同一 scope（Host、tools 与 Human composer 均已完成）
- [x] Project member 可在任何 Thread 回复；回复不自动 follow；mention 只产生一次 direct 通知，不开始也不恢复 Attention
- [x] 卡片投影与主对话未读规则（spec §3.2、durable contract §3.3）（Host 投影与 Client 卡片渲染均已完成）
- [x] 桌面与 390×844 浏览器检查 composer 与卡片

实施中确定的技术取舍：主对话未读拒绝是独立结果 `main_unread_required`；非 owner 只被指向自己的 Main stream marker 拦写入；被指定或撤销 owner 的 Agent 计入 Project member（撤销后仍可见项目）；Agent 不指定读取位置时，未读超过一页按最旧一页逐页确认，不会跳过；Human 页面按已加载的最新条目确认。

验证：版本 2 仍未对真实 ledger 启用，浏览器检查通过 `DSH_AGENT_TEAM_PREVIEW_RULES=1` 的一次性 profile 进行（`npm run test:browser` 7/7，截图在 `artifacts/browser/main-stream/`）；`npm test` 全部通过。
