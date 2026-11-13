# 11 — 核实通知省略是否造成实际漏送

**What to build:** 用实际 Agent 接收的通知验证 Main stream 更新和 Task reminder 被正文上限省略时是否还能找到；先区分正文、明确的查阅入口和完全没有提示，再确定是否需要修复。
**Blocked by:** 06（已完成）
**Status:** complete

- [x] Main stream 的旧直接更新被正文容量省略，Agent 仍收到 Project 地址和 `team_inbox` 入口。Inbox 保留全部 7 条，显式读取返回被省略的正文并清除未读；后来一条新消息仍唤醒 Agent。
- [x] Task reminder 被 20 条直接更新挤出正文时，通知仍提供 Thread 地址，Inbox 保留提醒。显式读取 Thread 才确认该提醒。
- [x] 未发现需要修改投递行为：提示和可读事实都在，现有唤醒规则保留。Main 回归补上从省略到读取、再到新事实唤醒的过程，Task reminder 复用已有真实 Harness 回归。
