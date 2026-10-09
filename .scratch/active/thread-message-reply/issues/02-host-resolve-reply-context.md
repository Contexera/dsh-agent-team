# 02 — Host 在 Thread 读取时解析引用上下文

**What to build:** 读者的 Thread 读取结果里，一条回复消息自带**已解析好的**父消息上下文（原作者 + 一行摘要 + messageRef），所以 Client 不需要跨历史窗口自己找父消息。原文不在本次加载窗口内时，引用依然可显示。

**Blocked by:** 01

**Status:** complete

- [x] 消息类 Thread 事实可携带可选 `replyTo`（`messageRef` / `sender` / `excerpt`）
- [x] 只有真的回复才带；非回复消息的读取结果与今天逐字节一致
- [x] 摘要由 Host 生成，单行、超长截断，不在 Client 里重算
- [x] 父消息早于本次窗口时仍能解析（Host 持有完整 ledger）
- [x] 父消息不可解析时不伪造内容，退化为「不可跳转」的形态
