# 05 — webhook 触发

**What to build:** 在 Human 配置好公网地址之后，订阅可以启用 webhook。外部服务向订阅地址推送时，Host 会把请求头和请求体交给脚本处理，处理后的事件和定时触发产生的事件一样，进入 Main stream。Agent 拿到地址后，可以自己到 GitHub 注册 webhook。规则见 `spec.md` §4.5。
**Blocked by:** 02
**Status:** pending

- [ ] 增加公网地址配置项；没有配置时，启用 webhook 会被拒绝，并说明原因。
- [ ] 入口运行在单独的 WebServer 上；token 随机生成，只保存哈希；完整地址只在创建或重置时返回一次。
- [ ] 各种情况的 HTTP 状态码都与 `spec.md` §4.5 的表格一致；投递在返回 202 前写入持久队列，每个订阅上限 10；测试覆盖返回 202 后重启 Host，投递仍被处理。
- [ ] 脚本从 stdin 读到 `{headers, body}`，header 名称统一小写，只转发 `spec.md` §4.5 白名单中的 header，单个值超过 1 KiB 时截断，测试覆盖 `x-api-key` 等名单外 header 不进入 stdin；环境变量 `DSH_TEAM_TRIGGER=webhook`。
- [ ] 一个订阅可以同时启用定时和 webhook，两条通道产生的事件按 `(订阅, id)` 去重；webhook-only 订阅一次产生超过 20 条事件时，经待发布队列全部发布。
- [ ] 支持 `reset_webhook`，重置后旧地址立即失效。
- [ ] 订阅标签页能展示 webhook 触发方式；启用 webhook 或重置地址时，弹窗显示完整地址。
