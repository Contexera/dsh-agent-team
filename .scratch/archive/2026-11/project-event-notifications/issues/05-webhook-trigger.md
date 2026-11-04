# 05 — webhook 触发

**What to build:** 在 Human 配置好公网地址之后，订阅可以启用 webhook。外部服务向订阅地址推送时，Host 会把请求头和请求体交给脚本处理，处理后的事件和定时触发产生的事件一样，进入 Main stream。Agent 拿到地址后，可以自己到 GitHub 注册 webhook。规则见 `spec.md` §4.5。
**Blocked by:** 02, 03, 04
**Status:** complete

- [x] 增加公网地址配置项；没有配置时，启用 webhook 会被拒绝，并说明原因。
- [x] 202 只在 durable commit 成功后返回；在 admission、output-saved、入队、发布各提交点注入崩溃，验证重启后不重发、不漏标记、终态（删除/归档）后的迟到结果不复活队列。
- [x] 入口运行在单独的 WebServer 上；token 随机生成，只保存哈希；完整地址只在创建或重置时返回一次。
- [x] 各种情况的 HTTP 状态码都与 `spec.md` §4.5 的表格一致；投递在返回 202 前写入持久队列，每个订阅上限 10；测试覆盖返回 202 后重启 Host，投递仍被处理。
- [x] 脚本从 stdin 读到 `{headers, body}`，header 名称统一小写，只转发 `spec.md` §4.5 白名单中的 header，单个值超过 1 KiB 时拒绝（不截断，截断会改变验签输入），测试覆盖 `x-api-key` 等名单外 header 不进入 stdin；环境变量 `DSH_TEAM_TRIGGER=webhook`。
- [x] 一个订阅可以同时启用定时和 webhook，两条通道产生的事件按 `(订阅, id)` 去重；webhook-only 订阅一次产生 21–500 条新事件时，经待发布队列全部发布；待发布队列空间不足时，已校验的事件随投递保存，空间足够后只重试入队，测试断言脚本没有被再次运行；单次超过 500 条的运行直接进入失败投递记录（`spec.md` §4.4）。
- [x] 每个投递在入队时分配稳定的 Host admission ID，经 `DSH_TEAM_DELIVERY_ID` 传给脚本；测试覆盖首次运行、失败重试、手动重放三次拿到的 ID 相同（`spec.md` §4.3“至少执行一次”）。区分 Host admission ID、provider delivery ID（如 `x-github-delivery`）与事件 ID；第一版脚本只做查询。
- [x] 失败投递是独立集合（稳定 deliveryRef、最后错误、到期时间），工具提供 `replay`（deliveryRef + 版本选择），Host/Remote/页面同一契约，重复重放按 requestId 幂等；运行记录淘汰后失败投递仍可查看。
- [x] 脚本运行失败的投递按 1、5、30 分钟退避重试 3 次，用尽后转为失败投递记录（最多 10 条、7 天，仅 Human 和 owner 可见），owner 可手动重放；测试覆盖“失败后重试成功”和“重试用尽后手动重放成功”（`spec.md` §4.3）；一个投递重试用尽只计 1 次连续失败，单次超过 500 条新事件直接转为失败投递也计 1 次；订阅暂停期间排队和重试中的投递不运行，恢复后继续处理，暂停期间手动重放失败投递被拒绝（`spec.md` §4.4、§4.6）。
- [x] 支持 `reset_webhook`，重置后旧地址立即失效（新到达请求 404），已接受的投递保留并继续处理。
- [x] 订阅标签页能展示 webhook 触发方式；启用 webhook 或重置地址时，弹窗显示完整地址。
