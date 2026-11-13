# 收口复核

逐项复核材料 00–07 的候选。实现、测试和现行维护文档优先；早期材料里「v5 未发布」等判断只留作当时的背景。下表区分已解决、无需改动和只有在新证据出现时才重开。

| 范围 | 裁决 | 证据 |
| --- | --- | --- |
| 附件上传、提交与回收；更新提示 | 01–02 处理并发、半写和旧提示。更新检查关闭仍只停新请求；已有结果按原契约处理。 | `attachments` 和 `human-update-check` 的故障注入及回归。 |
| Worker 停止、续跑、启动和卸载 | 03 统一终态确认。停止等待同一次 ledger 写入；超时不假报终态，晚到句柄按已有规则释放。保留 `unconfirmed` 的事实边界；不接管未知原生进程。 | `worker-stop`、`worker-steer`、`team-worker-actions`，另核对启动、卸载和续跑守卫。 |
| 订阅准入、耗尽、关闭和重放 | 04 收口守卫故障和关库。已发布的 v5 `running` 仍兼容读取；不把它重放成 `queued`。删除、暂停和重放继续走各自守卫。 | `subscription-runtime`、`subscription-host`、订阅存储和重放回归。 |
| 工具许可、模型工具提示和 owner 指引 | 05 消除可见工具与执行判断分叉。授权安装失败收紧到基线，基线失败则不启动模型请求；不把 profile grant 写进 Member 能力状态。owner 由当次 prompt 组装读取，Worker 运行仍由 Thread/工具查询。 | `member-tool-policy`、`member-tool-grants`、`project-owner-guidance`；Harness 的 `agent-lifecycle` 说明每步 prompt 组装。 |
| Session 换代、上下文、Task 和 Claim | 旧 transition/read receipt 的只读入口仍支撑已有 ledger；待写终态和读取派生不新增事实。已核对压缩取消、恢复和 Task 责任边界，无新故障需要开票。 | `legacy-session-transition`、`member-lifecycle-core`、`member-context-integration`、`member-model-route`、`task-accountability`。 |
| 未读、恢复通知、提醒与容量 | 06 修复恢复覆盖，11 证明正文省略后仍可查阅。消费重试仍有上限，事实留待读；不为可定位的省略新增唤醒。 | `member-reminder-delivery`、`notification-context`、`notification-reminder-context`。 |
| Client 读取、写入归属与重挂载 | 07–10 隔离晚到读取、发送、转 Task 和关注；12–13 让不变的发送随原草稿恢复并复用 Host 请求。导航、设置冲突、模型目录和查询过期未找到额外分叉。 | `team-project-panel-switch`、`thread-actions`、`team-send-retry`、真实 Web 的 `team-reply-reopen` 与 `team-main-reopen`；已运行 `TeamQueries`、导航、设置回归。 |
| 侧栏、快捷键、剪贴板与头像显示 | 14 单独收口本地写入顺序。跨窗口排序仍按最后到达 Host 的写入；不加冲突 UI。无可见行时快捷键无动作，顺序跟可见列表；剪贴板失败有反馈，头像不可用显示首字。 | `sidebar-order`、`team-shortcuts`、头像和剪贴板回归及浏览器验证。 |

仅在新增证据出现时重开：实测 Webhook 积压、跨 profile 可安全回收的头像及增长数据、现存 v5 `running` 行、需要处置的遗留 Worker 原生进程。它们是新事实的触发条件，不是这个 scratch 的未完成实施项。更新提示开关、提醒唤醒预算、Worker 默认权限、排序跨窗口规则均维持已发布或已验证的契约。

最终工作区验收：`npm test` 2,679 项通过、1 项跳过；`npm run typecheck`、lint、文档、界面规范和 `git diff --check HEAD` 通过。真实浏览器 28 项通过，含四条发送回执故障注入；检查了 1440×960 与 390×844 的界面、焦点、失败恢复及退出 Team 后的普通 DSH。临时截图和 profile 已清理，Harness checkout 无改动。
