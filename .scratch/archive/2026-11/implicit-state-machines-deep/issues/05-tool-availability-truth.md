# 05 — Agent 提示与工具执行守卫一致

**What to build:** Agent 看到的工具声明与执行许可发生差异时，提示明确列出哪些可见工具不能调用，包括替换基线工具的同名注册。
**Blocked by:** None — can start immediately
**Status:** complete

- [x] 同名替换会被执行守卫拒绝，也出现在 Agent 的工具可用性提示中。
- [x] 特殊工具名不破坏提示的标题和行结构；已授权工具和原基线不多报拒绝。
- [x] 回合冻结、撤销及无额外许可的回退规则保持；文档将 Member `capabilityState` 与 profile 许可区分开。
