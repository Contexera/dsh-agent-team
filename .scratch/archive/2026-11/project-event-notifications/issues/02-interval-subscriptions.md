# 02 — 定时订阅主流程

**What to build:** Human 或 Project 的 Agent owner 可以用 `team_subscription` 创建定时脚本订阅。创建时先试运行一次，通过后才生效。之后 Host 按设定的间隔，以 Project 所属的 Workspace 为工作目录运行脚本（能否写入 Workspace 以第一条验收项的结论为准），把新的事件发到 Main stream，并通知该 Project 的全部 owner。订阅支持暂停、恢复、删除。规则见 `spec.md` §4.1–4.4、§4.7–4.9。
**Blocked by:** None — can start immediately
**Status:** complete

实现链 `392ff47` → `0da5aa8` → `7c9f248` 已由 Reeve 独立复审并验收；未合并、未 push。Linux + Landlock + bash enforcement 已实测，macOS / Windows / pwsh 真机 enforcement 仍是发布前验证项，不以本次 Linux 证据替代。

- [x] 已验证并写回 spec：Host 为无 Session 调用显式传入 Workspace 根目录与完整 sandbox policy（`ShellExecRequest.sandboxPolicy`，自 0.2.1-rc.2 起）；Linux + Landlock + bash 的可写范围、cwd、shell 类型识别与 enforcement 已实测。macOS / Windows / pwsh 真机验证保留为上述发布前独立门槛，不在此冒称完成。
- [x] 订阅的创建、暂停、恢复、删除、去重基线、事件接受、事件发布都记入账本，账本重放校验能通过；非 owner 执行修改类操作时返回 `project_owner_required`。
- [x] create 读取 Agent 工作目录中的脚本文件，存为快照（不超过 16 KiB），然后试运行；试运行失败就拒绝，并返回 stdout 和 stderr 的末尾内容；credential 引用列表在创建时校验已配置、env 名合法；通过后按显式选择初始化去重基线（默认把输出 id 记为基线、不发布为事件；创建者也可选忽略当前历史）——基线初始化是与验证分离的独立动作；显式重新基线只追加要忽略的 id，不清除既有记录，已接受未发布的事件继续发布。
- [x] 正式运行时：遵守 60 秒超时和显式 65,536 字节 stdout 上限（检查 truncated 标志，不沿用 Harness 默认 64,000），全局最多同时运行 4 个，运行位占满时到期运行进入等待队列、同一订阅只保留一个并合并后续到期（`spec.md` §4.3），同一订阅不并发，注入约定的环境变量，记录 shell 类型并在不一致时报错，使用 Host 构造的明确沙箱策略（不提权，见 §4.3“权限”）。
- [x] 输出解析：按原始字节校验 UTF-8（拒绝 BOM，处理 CRLF 与缺失末尾换行），任意一行不合法整次运行算失败；按 `(订阅, id)` 去重，测试覆盖两个订阅输出相同 id 时各自都会发布。
- [x] 每次运行固定 subscriptionRevision 与 scriptHash；r1 运行跨过 r2 更新时，输出按 r1 基线处理并标注，不污染 r2 统计。
- [x] 新事件经过去重后作为接受写入账本，按每订阅每分钟 20 条发布；已接受未发布每订阅最多 500 条，超限的整批不接受并计 1 次连续失败，已达上限时后续定时运行记为跳过、不计入连续失败；Host 重启后未发布事件继续发布（`spec.md` §4.4），并有测试覆盖。
- [x] 脚本环境：由 Host 进程环境派生，名称含 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的 ambient 变量被清除，有测试覆盖；需要密钥的脚本经 Host 显式注入（订阅声明的 credential reference → env，最多 8 项，env 名不得使用 `DSH_TEAM_` 前缀），创建/更新时校验引用已配置、运行时未配置则本次运行明确失败，显式注入不受清除影响，也有测试覆盖（`spec.md` §4.3 环境变量）。
- [x] 测试覆盖：4 个运行位占满时，到期运行等待而不是丢弃，同一订阅的多次到期合并为一次。
- [x] 事件在 Main stream 中是一种新的记录类型，每个 owner 都会收到一个标记；标题和详情不解析 mention，并标注为不可信文本；Agent owner 会被唤醒。
- [x] Host 启动时，各订阅首次运行加随机延迟；停机期间错过的运行只补一次；间隔不小于 5 分钟；每个 Project 最多 20 个订阅。
- [x] Project 归档后，订阅停止运行。
- [x] 订阅的创建、暂停、恢复、删除都会在 Main stream 记录一条，并写明操作者。
- [x] 同步更新 tools、tools-and-preset、domain-model、attention-and-messaging、host-authority 文档（中英两版）。注册 `team_subscription`；工具总数按本次合并实际生效的集合更新，不硬编码数字。
