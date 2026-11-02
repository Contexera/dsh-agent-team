# 02 — 定时订阅主流程

**What to build:** Human 或 Project 的 Agent owner 可以用 `team_subscription` 创建定时脚本订阅。创建时先试运行一次，通过后才生效。之后 Host 按设定的间隔，在 Project 所属的 Workspace 中运行脚本，把新的事件发到 Main stream，并通知该 Project 的全部 owner。订阅支持暂停、恢复、删除。规则见 `spec.md` §4.1–4.4、§4.7–4.9。
**Blocked by:** None — can start immediately
**Status:** ready

- [ ] 先验证 Host 调用不属于任何 Session 时，`ctx.shell` 的工作目录和沙箱可写根目录如何确定（见 `spec.md` §4.3 中的“待实施时验证”），并把结论写回 spec。
- [ ] 订阅的创建、暂停、恢复、删除、去重基线、事件发布都记入账本，账本重放校验能通过；非 owner 执行修改类操作时返回 `project_owner_required`。
- [ ] create 读取 Agent 工作目录中的脚本文件，存为快照（不超过 16 KiB），然后试运行；试运行失败就拒绝，并返回 stdout 和 stderr 的末尾内容；通过后把输出中的 id 记为去重基线，不发布为事件。
- [ ] 正式运行时：遵守 60 秒超时和 64 KiB 输出上限，全局最多同时运行 4 个，同一订阅不并发，注入约定的环境变量，记录 shell 类型并在不一致时报错，不能提权。
- [ ] 输出解析：任意一行不合法，整次运行算失败；按 id 去重；每次运行最多发布 20 条事件。
- [ ] 事件在 Main stream 中是一种新的记录类型，每个 owner 都会收到一个标记；标题和详情不解析 mention，并标注为不可信文本；Agent owner 会被唤醒。
- [ ] Host 启动时，各订阅首次运行加随机延迟；停机期间错过的运行只补一次；间隔不小于 5 分钟；每个 Project 最多 20 个订阅。
- [ ] Project 归档后，订阅停止运行。
- [ ] 订阅的创建、暂停、恢复、删除都会在 Main stream 记录一条，并写明操作者。
- [ ] 同步更新 tools、tools-and-preset、domain-model、attention-and-messaging、host-authority 文档（中英两版）。Team 工具数量改为九个。
