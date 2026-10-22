# 2026-10-21 收尾实施与验收

## 结果

本轮修复和自动化验收完成；按用户要求停止扩大范围。修改仅在工作树，未提交、未推送、未归档。

- [x] preset 直接挂 `@deepseek-ai/dsh-compaction-basic`，使用上游默认模板；删除 Team 摘要子类、子路径 export 与重复实现。
- [x] 保留 `0.256 / 0.08 / 65536` 触发参数；实际窗口与输出预留遵循 DSH policy。
- [x] pending 普通输入保守续旧代；提交窗口使用 maintenance 与 ledger `inputFromSeq`；退休日志恢复输入。
- [x] 提交失败续旧代；提交后激活失败可恢复；冷启动检查 durable Inbox；启动 fallback 使用最新绑定。
- [x] 删除无消费者投影、`rolloverSeeds`、旧写入口及 hidden clear Remote，保留旧日志解码和必要恢复。
- [x] handoff writer 移到测试 helper；投影缓存版本升至 3 并有断言。
- [x] 同步双语文档、README、工具数、CHANGELOG；清理浏览器旧 fixture。
- [x] 主 agent 检查实际修改及独立 review；删掉退役 gate 重复入队，排除重新生成的 agent-instructions。

## 最终验证

- [x] `npm test`：1056 passed、1 skipped（`/tmp/auto-compaction-delivery-test.log`）。
- [x] `npm run typecheck`（`/tmp/auto-compaction-delivery-typecheck.log`）。
- [x] `npm run lint`（`/tmp/auto-compaction-delivery-lint.log`）。
- [x] `npm run test:browser`：5 passed（`/tmp/auto-compaction-acceptance-browser2.log`）；查看 desktop 与 390×844 截图，旧 judge 控件不存在。
- [x] `npm run build` 与 `npm run check:artifact`（`/tmp/auto-compaction-acceptance-{build2,artifact2}.log`）。
- [x] docs / boundaries / comments / facades 等预检查随最终 `npm test` 通过；`git diff --check HEAD` 通过。
- [x] late followup + inject、retirement-gap claim、提交失败、激活失败恢复、两次 suspend/resume 去重、冷启动 durable pending 输入回归通过。
- [x] 临时 probe 已删除；生成 facade 经脚本再生；无 staged 文件、browser artifact 或凭据新增。

## 证据边界

真实模型摘要质量、长期连续性与成本收益未测，不声称已验证。

取消的 inbox splice 不记录原因：显式删除或替换队列消息与 dispose 清空无法区分，因此换代时编辑的消息仍可能重放；正式双语文档已说明。普通 Session cancel 本身保留待处理输入。

不增加新的 durable replay marker：新代原始 user/message 日志与 durable Inbox 已按 Message id 去重，两次恢复回归确认不重复插入。
