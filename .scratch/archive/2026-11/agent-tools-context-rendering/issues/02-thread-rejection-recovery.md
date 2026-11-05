# 02 — Thread 写入被拒后，根据完整变化重新提交

**What to build:** 普通长度 Thread 消息导致写入被拒时，拒绝结果完整提供变化和真实可用的恢复路径；Agent 可修改行动再提交，不必重复读取同一正文。实现 F4 的 Thread Message 路径，同时移除旧的正文模糊匹配。
**Blocked by:** None — can start immediately
**Status:** complete

验证：Host/tools 1081 passed、1 原有 skipped；补充部分拒绝→read→提交后相关 24 tests 通过。真实模型 F4 留在 07，付费调用仍未获授权。

- [x] 通过真实工具执行→Session 工具结果→下一次 Host 写入路径测试，不用永远返回 true 的可见性 fake 代替整个验收。
- [x] 从当前 surface 派生 Team 来源、具体事实身份及实际完整文本；通知和工具结果都可提供 Thread Message；不建立独立已读事实库。
- [x] 裁剪后保留的 metadata 不单独证明完整，摘要、预览、模型复述、相同短正文或另一 Thread 的同文均不误命中。
- [x] unread_required 与 stale_revision 的结果和恢复句一致：完整补齐则允许重新考虑，缺少必要事实则给读取入口；不承诺重试一定提交，不把不匹配凭据说成单纯并发变化。
- [x] 拒绝本身不写 Thread 已读、不消费 marker；后续写入仍校验新到事实、revision、权限和 Task 状态。
- [x] 只覆盖可完整提供的消息路径；大批或超长拒绝明确说明未提供全部并要求读取，续读由后续票完成，绝不因本票省调用而放行不完整内容。
- [x] 更新所有受本票影响的工具文档、boundary 文档、package README、persona/core skill 恢复规则及测试；其它未完成路径如 Main/Activity 仍按实际行为陈述。
- [x] 跑 Thread 真实 ledger/Session 组合与 tool render 测试；完整→重考虑→成功、部分→读取、新事实→再次拒绝均有可核对输出。模型 F4 在最终组合评测中验证。
