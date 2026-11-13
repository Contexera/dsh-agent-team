# 06 — 恢复通知只覆盖自己呈现的事实

**What to build:** Agent 等待接收恢复指令时，新到的 Inbox 消息仍应待投递；恢复通知不能把未写进正文的内容视作已送达。
**Blocked by:** None — can start immediately
**Status:** complete

- [x] 恢复指令排队后新到的 Thread 事实不会被标为覆盖，也不会抢占恢复指令；之后重新计算 Inbox 可以投递它。
- [x] 受通知大小限制省略的 Thread 不计覆盖，空间释放后可投递；提醒仍在实际 claim 时消费。
- [x] 既有重试预算及 Agent 唤醒顺序保持。
