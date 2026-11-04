# PR #77 架构评审（外部，codex CLI 0.166.0 + gpt-6-astra，reasoning=high）

- 评审对象：PR #77「docs: add member reminders and project subscriptions design」（draft，head 2f80359，11 文件 1032 行纯文档）。
- 原文保存时间：2026-11-03。下方为评审原文，文字内容未改动；归档仅统一 LF 换行并移除行尾空白。
- 复核记录：2026-11-03 由 pi 对本评审的全部源码引用逐条复核。三个 P0 与绝大多数行号引用成立；已确认的夸大/行号偏移见 README 讨论记录与 spec.md 对应章节的修订。复核方式：Team HEAD 81c27a1 与评审基线 2f80359 之间仅一个无关 fix 提交；Harness 侧 b830ec950（rc.5）与 687f282e（rc.2）在被引用的 shell/sandbox/subprocess/schedule/jobs/webhook 包上源码零差异。
- 评审自述的局限（属实）：全程只读未跑测试；/tmp/holon-src、/tmp/dsh-super 快照在本机不存在，相关外部实现未核实。

---

# PR #77 架构评审（codex · gpt-6-astra）

- PR：Contexera/dsh-agent-team #77「docs: add member reminders and project subscriptions design」，draft，head `2f80359`，只新增 `.scratch/active/project-event-notifications/` 下 11 个文件（1032 行，纯文档）。
- 评审基线：Team `2f80359` / Harness `b830ec950`（0.2.1-rc.5）；全程只读，未运行测试与构建。
- 生成：codex CLI 0.166.0 + magpie 路由 `home/auto/gpt-6-astra`，reasoning=high。

> 证据里的 `spec.md:NN`、`issues/...:NN` 相对 `.scratch/active/project-event-notifications/`；`packages/`、`docs/` 相对 Team 仓库根；`../deepseek-harness/` 指相邻 Harness 仓库。

# PR #77 架构方案评审

**总评：方向成立，但目前还不是可以直接交付实施的设计；建议修改后合并，不建议按现状合并并宣布“设计已收敛”。** 主要阻塞点是：执行权限的等价性断言不成立、持久队列与账本之间缺少崩溃一致性契约，以及试运行/去重基线对 webhook 和更新场景存在错误语义。

## 评审范围与证据约定

- Team：已核对当前 HEAD 为 `2f80359`。
- Harness：本机实际 HEAD 为 **`b830ec950`，0.2.1-rc.5 发布合并提交**，不是调查材料记录的 `687f282e`。另用 `git show 687f282e:...` 回查了关键 shell/sandbox 接口，下面指出的可指定执行策略等能力在 rc.2 已存在，不是升级后才出现。
- 全程只读，未修改文件。未运行会生成文件的测试、构建或浏览器；测试证据指**阅读了测试断言**，不表示本次执行通过。
- 下文的 `spec.md:行号`、`issues/...:行号`、`materials/...:行号`，均相对于 `.scratch/active/project-event-notifications/`。
- Holon、dsh-superagent 材料记录的 `/tmp/holon-src`、`/tmp/dsh-super` 快照不在本机，**未能核实其上游实现**，不以它们证明本方案正确。

---

## 一、P0：合并前应解决的设计错误

### P0-1：“不提权”不等于“权限不超过 Member bash”，现有能力限制可以被绕过

**原文**

> “脚本的权限不超过 Member bash 工具在不提权时的权限。”
> “Agent owner 本来就能用 bash 执行任意命令，所以订阅不会给它新的凭据或权限。”

见 `spec.md:98`、`spec.md:101`。

**核实结果：这个推论不成立，有两个独立反例。**

1. **Member 可以没有 bash 权限。**
   当前 `capabilities.tools.allow` 可以收窄 Member 的工具集合，Team 工具则被强制保留。若新增的 `team_subscription` 按设计固定保留，而仅凭 owner 身份允许执行脚本，受限 owner 就重新获得了命令执行入口。
   证据：`packages/agent-team/src/member-runtime.ts:98`，尤其 `configured` 与 `AGENT_TEAM_TOOL_NAMES` 的合并；固定工具表位于 `packages/agent-team/src/member-runtime.ts:32`。

2. **Session 策略与 Host 默认策略不必相同。**
   Member bash 使用 Session 的 sandbox mode/cwd；无 Session 调用使用部署默认。比如 Session 已设为 `read-only`，部署默认仍是 `workspace-write`。Host 没有发起“提权”，但执行权限仍比该 Member 大。
   证据：`../deepseek-harness/packages/shell/tool-bash/src/index.ts:214`；`../deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts:164`；测试明确覆盖 Session 独立模式：`../deepseek-harness/packages/sandbox/sandbox-policy/tests/policy.spec.ts:78`。

此外，**cwd 不等于可写根**。不显式传策略时，脚本可能对 DSH 启动目录有写权限，而不是仅仅“Workspace 不能写”。

**建议改法**

- 明确将“允许 Project 无人值守执行脚本”定义为一个新的授权决定，而不是借“owner 已经能 bash”推导。
- 明确受限 Member 是否有资格创建、更新、试运行订阅；不能让强制保留的 Team 工具隐式绕过 `tools.allow`。
- 由 Host 从可信 Workspace 记录构造明确的每次执行策略，规定 mode 与根目录；不要继承偶然的进程 cwd。
- 若最终产品决定“所有 owner 均可建立部署级自动化”，可以这样设计，但必须明确承认新增权限，并让 Human 的权限配置与 UI 反映这个事实。

### P0-2：四类“私有存储”被混为一谈，当前契约不能兑现“不丢事件”

**原文**

> “一次运行产生的新事件全部进入……持久待发布队列（Team 私有存储，不写账本）。”
> “这样即使脚本在运行中推进了游标或消费了 API 分页，事件也不会丢。”

见 `spec.md:121`。另见投递持久化和删除条件：`spec.md:105`、`spec.md:108`。

**问题不在于“私有存储”这个名字，而在于里面存的是什么。**

| 私有数据 | 是否可以视为非权威附属数据 |
|---|---|
| stdout/stderr、耗时等诊断记录 | 可以；删除不应改变领域结果 |
| 尚未处理的原始 webhook 请求 | 可以作为独立的入站传输日志，但必须明确它承担的接收承诺 |
| 已校验、尚未发布的事件和等待入队批次 | **不是普通缓存**；删除会永久改变应当发布哪些事件 |
| 连续失败计数、重试状态、最后成功时间 | 会影响暂停、调度及脚本查询范围；不能仅靠最近 50 条日志随意重建 |

当前权威契约是一次 mutation 提交一个 durable operation，Inbox 与投影从中派生，并在重放时重新验证。证据：`docs/architecture/host-authority.md:12`；当前 durable domain 只有 `operations` 表：`packages/agent-team/src/spec.ts:767`。

**至少缺少三个关键交接协议：**

- **脚本已推进外部游标，stdout 尚未持久化就崩溃：**本地持久队列救不了这个窗口。下一次脚本可能再也查不到该事件。原文的无条件“不丢”承诺是错误的。
- **投递输出已放入待发布队列，但删除原投递前崩溃：**重启如何识别“已执行且已交接”，避免再次执行或重复入队？
- **事件已写账本，删除待发布项前崩溃：**重启必须以账本为准确认已发布；只规定“入队前去重”不足以定义发布阶段的幂等。

**建议改法**

先写一张权威/恢复矩阵，再选具体存储实现：

- 明确哪些是**可重建投影**、哪些是**原始接收日志**、哪些是**已经接受的 Team 事实**。
- 给投递、运行、输出批次和发布操作稳定身份，定义状态转换及每一步的 durable commit 点。
- 事件发布与当时所有收件人的 Inbox delta 应在同一个账本操作中提交；私有队列只能据此确认/回收。
- 对已经接受的事件，选择“账本记录 accepted fact、队列可重建”，或者明确设计一个原子事务覆盖的交接协议。不能让“私有存储”隐含成为未经说明的第二事实权威。
- 将“不丢”限定在**Host 已持久接受输出之后**。脚本自行推进游标、消费外部消息的行为，需要单独的 checkpoint/确认协议；第一版更适合禁止依赖这种行为。

**结论：运行日志不进账本是好的取舍；把所有执行状态都归为运行日志则不是。**

### P0-3：试运行同时承担“验证”和“吞掉历史事件”，对 webhook 与更新均不成立

**原文**

> “创建和更新订阅时先试运行一次，通过后才生效。”
> “输出中的全部 id……作为去重基线，但不发布为事件。”
> “update 同样先试运行，再重新写入去重基线。”

见 `spec.md:25`、`spec.md:89`、`spec.md:90`、`spec.md:91`。`resume` 同样强制试运行：`spec.md:153`。

**两个直接问题：**

1. **webhook-only 的试运行输入没有定义。**
   正式运行需要 `{headers, body}`，但创建表单和工具参数没有测试请求体、签名 fixture 或独立验证方法。一个正确地要求真实 payload/签名的脚本无法按现有契约完成创建或恢复。
   让脚本在 `DSH_TEAM_TRIGGER=test` 时直接成功，只能验证 test 分支，不能保证“创建成功就能运行”。证据：`spec.md:87`、`spec.md:101`、`spec.md:130`、`spec.md:229`。

2. **普通更新会静默吞掉尚未发布的新事件。**
   例如两次轮询之间出现事件 X，owner 只修改订阅名称或间隔；更新试运行输出 X，Host 把 X 写入基线而不发布，以后正式运行又因基线将其去重。X 从未通知 owner。
   这直接由 `spec.md:91` 与 `spec.md:120` 的组合产生，不需要特殊崩溃条件。

**建议改法**

- 分开三个动作：**验证脚本、初始化历史水位、变更配置**。
- 创建可以显式选择“忽略当前历史”；更新默认保留去重状态，不自动吞掉新输出。
- 明确新基线是替换还是合并、与既有 pending events 如何交互、id 规则改变是否需要显式重新初始化。
- webhook 验证支持测试 envelope，或将“验证可执行性”和“验证真实 webhook 处理”区分；不能承诺一次空载试运行证明所有触发方式正确。
- UI 的测试结果必须绑定脚本 hash、配置和 revision；编辑后失效，保存不能信任客户端一个“已通过”布尔值。

---


# PR #77 评审补篇：P1 清单

## 范围与引用

- Team 检出：`/data/repos/review-pr77`，HEAD `2f80359`；Harness 检出：`/data/repos/deepseek-harness`，HEAD `b830ec950`。材料调查版本为 `687f282e`。
- `packages/`、`docs/`、`.scratch/` 路径相对于 Team 仓库；`../deepseek-harness/` 指相邻 Harness 仓库。结论来自源码和测试断言阅读，不表示本次运行了测试。
- 本篇不重复上一轮的三个 P0：执行权限等价性错误、私有队列与账本的持久化交接、试运行与基线重置语义。

## P1-1：不同 profile 不隔离账本，降级风险处理写错了

**原文：**“旧版本读取账本时遇到未知操作会直接报错……开发和日常使用应分别使用不同的 profile。”（`.scratch/active/project-event-notifications/spec.md:242`）

**证据：**Host 使用 `dshHomePath('storages', 'agent_team.sqlite')`，没有 profile 路径分量（`packages/agent-team/src/index.ts:447`）。维护文档明确写明开发与稳定 profile 共享全局 ledger，首次打开新版前须备份并升级所有共享该存储的 profile（`docs/development/environments-and-install.zh.md:83`；`docs/release-runbook.zh.md:93`）。未知操作既可能被闭合 schema 拒绝，也可能触发 dispatch 的穷尽检查（`packages/agent-team/src/spec.ts:384`；`packages/agent-team/src/ledger.ts:549`）。

**影响：**按文档只换 `web-dev` profile 测试新操作，会使同一 DSH home 下旧版稳定 profile 无法再打开账本。这不是“profile 之间互不影响”的开发方式。

**建议：**把不兼容预览环境明确写成独立 `DSH_HOME`；列出首次写入新操作前的备份、所有共享存储实例的版本检查、升级顺序和回滚限制。准确表述为“旧版本拒绝读取”，不保证异常一定来自 `assertUnhandledKind`。

## P1-2：Member reminder 的送达时机和消费点不是现有 Task reminder 的行为

**原文：**“送达方式与现有的 Task 提醒……一致”；“提醒随通知进入 Member 的一轮对话后即视为已读”；“Member 正在运行一轮对话……在本轮结束后送达”。（`.scratch/active/project-event-notifications/spec.md:48`、`.scratch/active/project-event-notifications/spec.md:49`、`.scratch/active/project-event-notifications/spec.md:62`）

**证据：**普通 Team Inbox 通知默认 `agent.steer(hint)`，进入最近的 step 边界；为保持已有 next-turn 输入顺序时才用 `followup`（`packages/agent-team/src/index.ts:2976`）。现有 Task reminder 在显式读取 Task Thread 时消费，测试断言产生 `team/thread-read` 并移除 reminder marker（`packages/agent-team/tests/task-reminders.spec.ts:156`）。维护契约明确“只有显式读取提交 read-state changes”（`docs/architecture/host-authority.md:10`）。

**影响：**简单复用会在当前轮的下一 step 提醒，而不是下一轮；照搬现有消费又会让不属于 Thread 的 Member reminder 无法按预期自动确认。更早把“排队成功”当作已读，则有崩溃后漏送风险。

**建议：**保留 Inbox 聚合/唤醒基础设施，但为 Member reminder 明确独立的 occurrence 和 consumption 操作；说明认领消息、持久化 Session、记录消费之间的顺序及重复容忍。选择下一 step 或下一 turn，并承认这是新策略，而不是声称两者相同。不能消费被通知长度上限省略的提醒。

## P1-3：revision 没有覆盖执行中的配置与生命周期竞争

**原文：**“revision 每次更新加 1”；“暂停时正在运行的脚本会运行完，结果照常处理”；“订阅删除或 Project 归档时……队列都清空”。（`.scratch/active/project-event-notifications/spec.md:76`、`.scratch/active/project-event-notifications/spec.md:122`）

**证据：**状态图只画出 `update → revision + 1`（`.scratch/active/project-event-notifications/spec.md:166`），没有说明 pause/resume/reset/delete 是否推进版本，也没有 run 绑定哪个版本的字段。现有 Thread 写入在 ledger 串行提交内部检查身份和状态，并使用 revision gate（`packages/agent-team/src/ledger.ts:1384`；`packages/agent-team/src/ledger.ts:5473`）。

**影响：**r1 运行跨过 r2 更新后，其输出可能使用错误基线、给 r2 计失败，或显示成 r2 的运行；删除清队列后迟到结果可能重新创建待发布项；试运行期间被撤销权限的 owner 仍可能提交配置。多 owner pause/resume 与自动暂停也没有确定的线性化规则。

**建议：**每个 run 固定 `subscriptionRevision`、`scriptHash` 和触发身份；最终提交重新检查 revision、Project/Subscription 状态、操作者资格。明确 queued delivery 重试用入队版本还是当前版本。所有管理操作列出 expectedRevision、版本推进和重复请求行为。删除/归档必须形成禁止迟到写入的终态屏障。

## P1-4：签名密钥来源未设计，gh 凭据“只走文件”不属实

**原文：**“名称含 KEY、PASSWORD、SECRET、TOKEN 的变量会被清除”；“gh 的登录信息保存在用户配置文件中，不在环境变量里”；“脚本……可以从环境变量读取密钥，自行计算 HMAC”。（`.scratch/active/project-event-notifications/spec.md:100`、`.scratch/active/project-event-notifications/spec.md:130`）

**证据：**Harness 的正则是 `/KEY|PASSWORD|SECRET|TOKEN/i`，但只清除 ambient parent env；显式传入的 env 在清除之后合并（`../deepseek-harness/packages/subprocess/subprocess/src/index.ts:47`；`../deepseek-harness/packages/shell/shell/src/types.ts:87`）。Subscription 模型没有 credential reference 或 env 绑定字段（`.scratch/active/project-event-notifications/spec.md:70`）。本机只读命令 `gh help environment` 明确列出 `GH_TOKEN`/`GITHUB_TOKEN` 且其优先于已保存凭据；`gh auth login --help` 说明默认使用系统 credential store，失败时才回退明文文件。

**影响：**通过常见 `WEBHOOK_SECRET` 或 `GH_TOKEN` 部署的脚本拿不到凭据；“本机 gh 登录状态可以直接使用”不能覆盖 keychain、权限、过期凭据和环境变量登录。当前 HMAC 示例没有可实施的密钥来源。

**建议：**明确受控的 credential reference → Host 显式注入映射，或明确支持的凭据文件方案；禁止建议通过改名绕开 scrub。注明凭据不进入脚本快照、日志和账本；在目标执行器中验证 gh 实际可用性。未能核实当前部署的 gh 登录可用性：本次没有读取用户凭据或发起认证请求。

## P1-5：stdout capture cap 不等于严格输出协议，UTF-8 和日志保留也不能直接继承

**原文：**“stdout 上限 64 KiB，超出即判定……失败”；“输出必须是 UTF-8”；“stdout 和 stderr 各自末尾 8 KiB……保留最近 50 条”。（`.scratch/active/project-event-notifications/spec.md:102`、`.scratch/active/project-event-notifications/spec.md:119`、`.scratch/active/project-event-notifications/spec.md:150`）

**证据：**bash-local 默认 capture 为 `64_000` 字节，可用 `stdoutMaxBytes` 覆盖；collector 保留尾部并报告 `truncated`，不会仅因截断自动变为 Team 运行失败（`../deepseek-harness/packages/shell/bash-local/src/index.ts:104`；`../deepseek-harness/packages/subprocess/subprocess/src/types.ts:21`）。其最终文本通过 `Buffer.toString('utf8')` 解码，非法字节被替换而不是严格拒绝（`../deepseek-harness/packages/subprocess/subprocess-local/src/output.ts:305`）。bash-local 同时配置 spill，溢出的完整输出可能留在临时文件，生命周期不等于 Team 的 50 条记录（`../deepseek-harness/packages/shell/bash-local/src/index.ts:157`；`../deepseek-harness/packages/subprocess/subprocess-local/src/output.ts:31`）。

**影响：**若只检查 exitCode 并解析返回文本，截断后恰好合法的 JSON 尾部可能被误当完整输出；非法 UTF-8 可能被静默接受；删掉 Team 日志不代表删掉 subprocess spill 中的敏感输出。

**建议：**显式设置 65,536 字节并检查 `truncated`；定义是退出后失败还是越界立即终止。若坚持严格原始 UTF-8 校验，需要 Team-owned 原始字节校验/封装方案，不能在已经有损解码的字符串上恢复原始合法性。规定 stderr、spill、超限输出的保留/清理范围，并把相关限制写进执行器验收。60 秒超时使用 `timeoutMs` + kill 语义，4 个运行位和业务失败判定仍由 Team 管理。

## P1-6：成功、最后成功时间、失败计数和等待队列的关系未闭合

**原文：**“另外注入……DSH_TEAM_LAST_SUCCESS_AT”；“全局 4 个运行位……先进先出的等待队列”；“任何一次定时或 webhook 运行成功都会把计数清零”。（`.scratch/active/project-event-notifications/spec.md:101`、`.scratch/active/project-event-notifications/spec.md:104`、`.scratch/active/project-event-notifications/spec.md:152`）

**证据：**投递必须等全部新事件入队才删除，脚本成功但队列满时只重试入队（`.scratch/active/project-event-notifications/spec.md:105`、`.scratch/active/project-event-notifications/spec.md:108`）。运行记录却只有“发布事件数”，没有明确 scripted/validated/accepted/published 的阶段（`.scratch/active/project-event-notifications/spec.md:150`）。失败计数、last-success 的 durable 归属也未在模型中定义（`.scratch/active/project-event-notifications/spec.md:70`）。

**影响：**不同实现会在脚本 exit 0、输出持久化、全部入队或全部发布时分别清零计数、推进 last-success；脚本按这个时间拉取时会得到不同数据范围。webhook 重试与 interval 的成功交错时，“连续失败”可能与用户理解不同。FIFO 只说明定时任务，未定义 webhook 与测试的公平性。

**建议：**定义结构化 outcome 和成功线性化点；last-success 说明是运行开始时间、完成时间还是已提交源水位，测试不得改变它。failure streak 独立持久化，不能依赖可截断的运行日志重建。定义所有运行入口共用的 per-subscription 互斥、global admission、公平顺序和取消策略；等待发布不能长期占用 shell 运行位。

## P1-7：Host delivery ID 只能覆盖内部重试，不能覆盖提供方重投

**原文：**“每个投递在入队时由 Host 分配一个稳定的投递 ID……脚本……必须以投递 ID 做幂等判断，避免重复执行造成重复修改。”（`.scratch/active/project-event-notifications/spec.md:107`）

**证据：**文档只承诺同一已入队投递的 retry/replay 保持该 ID，没有定义 HTTP 重复请求的 admission 去重。GitHub 自己的投递身份在 `x-github-delivery`，现有 Harness adapter 明确读取它（`../deepseek-harness/packages/experimental/webhook-github/src/handler.ts:93`）。

**影响：**Host 已持久入队、但 202 响应丢失时，提供方重投会被视为另一个新入队请求并分配新 ID。即使脚本完全遵守 Host delivery ID 幂等要求，外部副作用仍可能执行两次。最终事件按 id 去重不等于副作用去重。

**建议：**分别命名 Host admission ID、provider delivery ID、domain event ID，限定各自保证。第一版最好保持查询型脚本，不为副作用提供超出契约的保证；若支持副作用，要求可信 provider identity 或业务幂等键，而不是仅 Host admission ID。重置地址及跨版本 replay 是否沿用键也须说明。

## P1-8：承诺手动重放失败投递，但工具和数据查询契约没有入口

**原文：**“owner 可以在运行记录中查看并手动重放”；工具操作只有 `create / update / test / pause / resume / delete / reset_webhook / list / logs`。（`.scratch/active/project-event-notifications/spec.md:106`、`.scratch/active/project-event-notifications/spec.md:192`）

**证据：**ticket 05 要求 owner 手动重放且暂停期间工具与页面拒绝重放，但没有指定 action、deliveryRef、查询接口、requestId/revision 或错误结构（`.scratch/active/project-event-notifications/issues/05-webhook-trigger.md:13`）。失败投递保留 10 条/7 天，而 run logs 只保留 50 条，二者不是同一个集合（`.scratch/active/project-event-notifications/spec.md:106`、`.scratch/active/project-event-notifications/spec.md:150`）。

**影响：**一个投递可能仍可重放，但对应 run 行已被挤出，页面/Agent 无从找到；两个 owner 重放同一失败投递也没有去重规则。实现者不得不临时添加未评审的动作和状态。

**建议：**定义独立失败投递列表和详情，含稳定 deliveryRef、原版本、最后错误、到期时间；补 `replay` 的 Host/Remote/tool 契约及并发幂等规则。允许展示不依赖最近 50 条日志的投递状态；明确重放成功指输出接受还是事件全部发布。

## P1-9：ticket 依赖图不成立，若按当前 frontier 实施会倒序依赖

**原文：**“03 等 02；04 等 03；05 等 02；06 等 01、02、05”；“01–06……每一项都能单独端到端验证”。（`.scratch/active/project-event-notifications/README.md:16`、`.scratch/active/project-event-notifications/README.md:37`）

**证据：**05 的失败计数依赖 03，05 的标签页和地址弹窗依赖 04，但 `Blocked by` 只有 02（`.scratch/active/project-event-notifications/issues/05-webhook-trigger.md:4`、`.scratch/active/project-event-notifications/issues/05-webhook-trigger.md:13`、`.scratch/active/project-event-notifications/issues/05-webhook-trigger.md:15`）。02 已承诺恢复和 Human 创建，但恢复验证在 03，创建表单和事件卡片在 04（`.scratch/active/project-event-notifications/issues/02-interval-subscriptions.md:3`；`.scratch/active/project-event-notifications/issues/03-run-history-and-failures.md:9`；`.scratch/active/project-event-notifications/issues/04-subscriptions-tab.md:3`、`.scratch/active/project-event-notifications/issues/04-subscriptions-tab.md:11`）。

**影响：**05 不是目前宣称的独立可开工分支；02 完成后并不能完整展示其用户承诺。03 的核心故障保护不是可无限后置的装饰功能。

**建议：**最小调整为 05 依赖 03 和 04；或把 05 的 UI 部分拆出，并明确其 Host 子片可独立验证。更推荐把最小 UI、resume 验证和基础 outcome 记录纳入 02 的可交付纵切片，再让 03/04扩展。详见 `04-design-quality.md` 的逐项验收矩阵。

## P1-10：“每个 DSH home 一个 Host”未核实为现有部署保证

**原文：**“不支持，沿用‘每个 DSH home 一个 Host’的现有前提。”（`.scratch/active/project-event-notifications/spec.md:244`）

**证据：**维护文档说的是“one collaboration domain per DSH home”，不等于进程互斥（`docs/architecture/host-authority.md:5`）。当前 ledger 的排序来自进程内 `state.ordered.length + 1` 和 Promise 串行队列（`packages/agent-team/src/ledger.ts:6419`、`packages/agent-team/src/ledger.ts:6655`）。未能核实已有覆盖整个 Team Host 生命周期的跨进程独占锁：本次检索的 Team Host/ledger 与维护文档没有证明这个保证。

**影响：**不能把“不支持并发”写成“已经确保不会并发”。两个 profile 共享 home 时，问题可能不仅是定时脚本重复执行，还包括两个进程各自维护的 ledger 投影和序号竞争。

**建议：**把它写成明确部署约束，给出检测/拒绝第二实例的 Team-owned 机制，或者至少给出可执行的启动前检查和醒目告警。不要把 SQLite WAL 自动当作业务级单写者所有权。若暂不实现锁，明确注明“未强制执行”，并禁止在共享 home 同时启动两个 Team Host。

# PR #77 评审补篇：P2 清单

证据基线：Team `/data/repos/review-pr77@2f80359`；Harness `/data/repos/deepseek-harness@b830ec950`。以下源码和文档路径相对于 Team 仓库，`../deepseek-harness/` 指相邻 Harness 仓库。P2 是可改进项，不代替 P0/P1 的合并前处理。

## P2-1：问题定义低估了现有主动唤醒能力

**原文：**“目前 Agent 只会被 Human 或其他 Member 的消息唤醒，所以 owner 无法独立推进。”（`.scratch/active/project-event-notifications/spec.md:7`）

**证据：**已有 Host 主动生成 `review-backlog`、`stalled` 的计划器和 ledger 写入入口（`packages/agent-team/src/task-reminders.ts:58`；`packages/agent-team/src/ledger.ts:740`），通知会进入 Member 的 Inbox 唤醒路径（`packages/agent-team/src/index.ts:3128`、`packages/agent-team/src/index.ts:2976`）。另外，Harness job 完成通知可在配置允许时唤醒 idle owner（`../deepseek-harness/packages/jobs/tool-jobs/src/index.ts:296`）。不能把 job 的可配置唤醒模式写成所有部署的默认行为，但它足以否定“除了人和 Member 消息再无途径”的绝对说法。

**影响：**过强的问题陈述让“必须一次性交付通用 webhook 平台”显得比实际更必要，也掩盖了已有 Task-specific 提醒值得复用的部分。

**建议：**改为“已有局限于 Task 状态及既有执行的唤醒来源，缺少绑定 Member 的通用时间承诺，以及绑定 Project 的外部事实订阅”。验收以这两个新增缺口衡量，不以笼统的“此前不主动”衡量。

## P2-2：术语基本可用，但 Reminder、Trigger、Delivery 有重叠风险

**原文：**新增 `Reminder`，订阅由 `triggers` 驱动，另有“投递”“运行”“事件”。（`.scratch/active/project-event-notifications/spec.md:38`、`.scratch/active/project-event-notifications/spec.md:74`、`.scratch/active/project-event-notifications/spec.md:105`、`.scratch/active/project-event-notifications/spec.md:150`）

**证据：**现有 `ReminderKind` 已专指 `review-backlog | stalled`（`packages/agent-team/src/task-reminders.ts:7`）。Main stream 已有不同于 Message 的 Activity 和 Thread card（`packages/agent-team/src/types/requests-results.ts:474`），其中 MainActivity 目前仅表示 owner 变更（`packages/agent-team/src/types/entities.ts:393`）。

**影响：**直接复用 `Reminder`/`Delivery` 泛名容易把 Task 派生提醒、Member 时间提醒、HTTP 请求与 Inbox 送达混在同一状态机；“event”也可能被误解为账本 operation 或 Message 的别名。

**建议：**加一页小词汇表，不增加更多独立注册中心：MemberReminder、TaskReminder、TriggerConfig、TriggerOccurrence、WebhookDelivery、SubscriptionRun、ProjectEvent。说明一对多关系：一个 delivery 可以有多个 run attempt，一个成功输出可以有多个 event，一个 event 可以有多个 owner marker。命名应服务于身份和生命周期的分离，不要求所有词都变成单独持久表。

## P2-3：脚本统一抽象有收益，但当前范围把验证目标扩大成执行平台

**原文：**“订阅 = 触发方式 + 一段脚本”；“不需要为每个外部服务写专用代码”；验收目标是“Agent owner 自己建立一个 GitHub CI 订阅，并因此被唤醒去处理问题”。（`.scratch/active/project-event-notifications/spec.md:24`；`.scratch/active/project-event-notifications/README.md:38`）

**证据：**为实现该目标，设计同时引入全局调度、per-subscription 互斥、HTTP durable admission、重试、失败投递、持久待发布队列、延迟批次和独立日志保留（`.scratch/active/project-event-notifications/spec.md:102`、`.scratch/active/project-event-notifications/spec.md:105`、`.scratch/active/project-event-notifications/spec.md:121`、`.scratch/active/project-event-notifications/spec.md:150`）。这些是实际需要维护的行为，不因隐藏在两个工具下就消失。

**影响：**代码侧减少 provider-specific adapter，不代表 provider-specific 工作消失：payload 解释、签名、分页、水位、鉴权过期、限流和稳定 ID 被转移给脚本作者。无人值守失败的排查成本仍由 Team 承担。

**建议：**保留统一的 ProjectEvent 输出 Interface，但把第一轮可交付缩成 Member reminder + 定时只读订阅；完成可靠发布后再接 webhook。另一可行简化是 webhook 仅标记“需要重新查询”，由同一查询脚本获取权威状态，可合并 HTTP 噪声；但它不适用于只能从推送中取得的瞬时事件，必须明确适用范围。这是架构取舍建议，不是已验证所有 provider 都能适用的事实。

## P2-4：时间和工具数量的文档表达需要与既有契约对齐

**原文：**“cron 按 UTC+8 计算，与 Team 呈现给 Agent 的时间一致”；01 把工具数改成八个，02 改成九个，且两者都可立即开始。（`.scratch/active/project-event-notifications/spec.md:51`；`.scratch/active/project-event-notifications/issues/01-member-reminders.md:14`；`.scratch/active/project-event-notifications/issues/02-interval-subscriptions.md:4`、`.scratch/active/project-event-notifications/issues/02-interval-subscriptions.md:19`）

**证据：**Agent 时间确实固定 UTC+8，但 Web Client 使用浏览器本地时间（`packages/agent-team/src/time-format.ts:2`）。工具注册集中在一个插件，当前实际注册七个（`packages/tool-agent-team/src/index.ts:1530`）；preset 挂载的是这个插件，不是每工具一行（`cordis.patch.yml:183`）。

**影响：**海外浏览器用户可能把界面上的本地时间当作 cron 时区；01、02 并行时，文档中的八/九个可能被最后提交覆盖，与实际挂载数量不一致。

**建议：**cron 表单和预览显式标 UTC+8，显示下一次触发的 UTC instant/浏览器本地时间。工具总数按实际完成集合更新；新工具还要同步强制保留列表、schema、Host 授权、文档和测试，不能把“改 preset”当作完整变更步骤。

## P2-5：工作项状态与可实施程度不匹配

**原文：**“设计已收敛”；“spec.md……不是实现依据”；同时 02 开始前还须核实沙箱根。（`.scratch/active/project-event-notifications/README.md:7`、`.scratch/active/project-event-notifications/README.md:17`；`.scratch/active/project-event-notifications/spec.md:3`）

**证据：**Host 的显式 per-call sandboxPolicy 接口在材料记录的 rc.2 就已存在；只读核查命令为 `git -C /data/repos/deepseek-harness show 687f282e:packages/shell/shell/src/types.ts`，其中 `ShellExecRequest.sandboxPolicy` 位于该版本第 103 行。与此同时，当前设计没有确定 webhook 试运行输入和存储交接协议（`.scratch/active/project-event-notifications/spec.md:89`、`.scratch/active/project-event-notifications/spec.md:108`）。

**影响：**“已收敛”会让实施者把尚需设计决策的事项当作实现细节；“不是实现依据”又可能使目标行为的权威归属不清。

**建议：**明确区分“新增行为的目标设计”和“已有能力的事实调查”：前者由本 spec 规定，后者必须服从源码。把待决策事项列成合并门槛，并给每条调查记录核实的 commit，而不是把错误能力假设推迟到 ticket 实施时再发现。

# PR #77：交叉验证结果

## 核实基线与判定口径

- Team：`/data/repos/review-pr77`，`2f80359`；Harness：`/data/repos/deepseek-harness`，`b830ec950`，对应 0.2.1-rc.5 发布合并提交。
- 调查材料写的是 `687f282e`/rc.2（`.scratch/active/project-event-notifications/materials/harness-webhook.md:3`），因此不能直接把材料版本称为当前检出。关键 shell/sandbox 接口另以 `git show 687f282e:路径` 回查；下文指出的 per-call 策略能力在 rc.2 已存在。
- 表内 `spec.md`、`materials/...` 相对于 `.scratch/active/project-event-notifications/`；其余 `packages/`、`docs/` 相对于 Team 根，`../deepseek-harness/` 指相邻仓库。所有行号是起始定位，不是源码范围。
- “核实为真”表示源码/测试断言支持指定事实，不表示新设计已实现或跨平台验收通过；“过时或错误”包含过度概括；对未实际部署验证的事项明确保留。

## A. 时间、Session 与现有唤醒

| 断言与文档位置 | 结论 | 源码/测试证据 | 对设计的实际影响 |
|---|---|---|---|
| `dsh-schedule` 的提醒绑定原 Session（`spec.md:23`；`materials/harness-webhook.md:55`） | 核实为真 | `../deepseek-harness/packages/schedule/schedule/src/index.ts:228` 的 create 接收 SessionId；`:308` 校验记录的 sessionId；`../deepseek-harness/packages/schedule/schedule/src/runtime.ts:101` 解析原 Session 并 followup | 不能把该服务直接当 Member ID 调度器；直接使用会把长期承诺绑到旧 Session。 |
| “Session 停止时提醒停止”（同上） | 核实为真，但必须限定 stop 的含义 | `../deepseek-harness/packages/schedule/schedule/src/index.ts:199` 监听 `workspace/session-stop`；`:430` 删除该 Session 的 active tasks；`../deepseek-harness/packages/schedule/schedule/tests/plugin.spec.ts:70` 覆盖创建尚在写入时的 stop | 不是每次 turn 结束、idle 或任意 handle 释放都会使提醒消失。不要用含混的“停止”代替具体生命周期事件。 |
| schedule 持久化、重启后可恢复冷 Session、合并错过的循环提醒（`materials/harness-webhook.md:47`） | 核实为真 | `../deepseek-harness/packages/schedule/schedule/tests/domain-restart.spec.ts:38`；`../deepseek-harness/packages/schedule/schedule/src/runtime.ts:90`、`:101`、`:109`、`:124` | 不选 schedule 的理由应是身份/生命周期与 Team 不匹配，而不是它不支持持久化或冷恢复。纯 recurrence 算法的复用可另评估。 |
| Team 会换 Member 的 Session（`spec.md:23`、`:63`） | 核实为真 | `packages/agent-team/src/ledger.ts:1026` 实际实现 recycle，记录 previous/new Session 并更新 member；`packages/agent-team/src/team-context-management.ts:73` 发起 generation swap | 绑定 memberId 的理由成立。 |
| renewed、rolled-over、recycled 都能由 operation 类型证明是现行常规流程（`materials/harness-webhook.md:56`） | 过时或错误，证据推得过远 | 三种类型存在于 `packages/agent-team/src/types/operations.ts:99`；但 `packages/agent-team/src/team-context-management.ts:112` 把 rollover intent 描述并实现为旧路径恢复，当前正常写入路径有 recycle（`packages/agent-team/src/ledger.ts:1042`） | 材料应区分历史可重放类型与当前会生成的行为；只需当前 recycle 即足够支持不用 Session 绑定。 |
| 现有 Task reminders 是 Host 产生的私有提醒（`spec.md:48`；`materials/harness-webhook.md:51`） | 核实为真 | `packages/agent-team/src/task-reminders.ts:58`；`packages/agent-team/src/ledger.ts:740`；`packages/agent-team/src/index.ts:3128` | 可复用候选计划、账本提交、Inbox 唤醒的分层，但新提醒不能被强塞进 Task/threadRef 模型。 |
| review-backlog、stalled 的收件人与触发条件可直接照搬 | 过时或错误，若理解为同一套业务规则 | `packages/agent-team/src/task-reminders.ts:43` 的 review 收件人选择；`:63` 的 in_review 条件；`:73` 的 stalled 条件；`packages/agent-team/src/ledger.ts:734` 只把 enabled Agent 视为 available | Member reminder 要在 suspended 时仍计时入 Inbox，区别于当前 Task reminder 的 eligible 检查；只复用输送机制。 |
| Task reminder 随通知进入一轮即消费（`spec.md:49` 所声称的复用关系） | 过时或错误 | `packages/agent-team/tests/task-reminders.spec.ts:156` 明确通过 `team/thread-read` 消费 marker | 新 Member reminder 需单独定义消费操作和崩溃顺序；通知排队不是已读。 |
| 正在运行时，现有通知统一等本轮结束（`spec.md:62`） | 过时或错误 | `packages/agent-team/src/index.ts:2976` 默认 `steer`，仅 sequenced 模式 `followup` | 必须决定下一 step 还是下一 turn；不能把两者当成既有行为。 |
| cron 固定 UTC+8 与 Agent 时间显示一致（`spec.md:51`） | 核实为真，仅针对显示前提 | `packages/agent-team/src/time-format.ts:7` 固定 +8；`packages/agent-team/src/member-time-context.ts:109` 明确说明 UTC+8 与 sequence/revision 排序 | 这不证明 Team 已有 cron 调度实现。新的 cron parser、最小间隔和错过触发算法仍待实现；Web 浏览器本地时区需显式标注。 |

## B. 无 Session 执行、沙箱和环境

| 断言与文档位置 | 结论 | 源码/测试证据 | 对设计的实际影响 |
|---|---|---|---|
| Host 可以脱离 Session 调用 `ctx.shell`（`spec.md:96`） | 核实为真，指公共接口可行 | `../deepseek-harness/packages/shell/shell/src/index.ts:64` 提供 `resolve(request)`、`execute(spec)`；`../deepseek-harness/packages/shell/shell/src/types.ts:61` 不要求 Session | 调用形态是 resolve → execute → handle.result，不需要伪造 Agent Session。尚未对本 Team 部署实际启动脚本，不能把接口可行性写成验收完成。 |
| 这种调用不需要额外服务装配 | 过时或错误，若作此推论 | bash-local 依赖 subprocess（`../deepseek-harness/packages/shell/bash-local/src/index.ts:98`）；sandbox executor 还依赖 sandbox、sandboxPolicy（`../deepseek-harness/packages/shell/bash-sandbox/src/index.ts:45`）；policy 依赖 sessionProjections（`../deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts:119`）。当前 Team Host inject 尚无 shell（`packages/agent-team/src/index.ts:315`） | 需要明确可见的 Host 服务和 Team 插件依赖、停用清理；不应通过创建额外 Session 规避装配问题。 |
| Host 无 Session 时 cwd 自动等于 Project Workspace | 过时或错误 | `../deepseek-harness/packages/shell/bash-local/src/index.ts:132` 为 request.workdir → config.cwd → process.cwd | Team 必须从可信 Workspace 记录显式传 workdir；仅有 projectRef 不会自动影响 executor。 |
| 沙箱根必然回退进程启动目录（`spec.md:99`） | 过时或错误：仅为未配置、未显式传 policy 时的默认路径 | `../deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts:131` 支持 config.workspaceRoot；`:164` 的无 Session resolve 使用该 fallback；`../deepseek-harness/packages/sandbox/sandbox-policy/tests/policy.spec.ts:70` 覆盖 `/fallback` | 必须把“默认”与“不可覆盖”区分；改变 workdir 本身不会改变沙箱根。 |
| 无 Session 调用无法指定 Workspace 根，需等 ticket 02 才知道（`spec.md:99`） | 过时或错误，公共接口层面已能确认可指定 | `../deepseek-harness/packages/shell/shell/src/types.ts:103` 接受完整 sandboxPolicy；`../deepseek-harness/packages/shell/bash-sandbox/src/index.ts:85` 保留显式 policy；`../deepseek-harness/packages/sandbox/sandbox/src/index.ts:44` 定义 workspaceRoot。rc.2 的同名 types 文件第 103 行也已有该字段 | Team 可在可信 Host 侧传 mode/root；仍需跨平台测试实际 enforcement，但不必把接口是否存在当待决设计。 |
| 不提权就与 Member bash 权限相同（`spec.md:98`、`:101`） | 过时或错误 | Member bash 按 Session resolve（`../deepseek-harness/packages/shell/tool-bash/src/index.ts:214`）；agentless 按部署默认；Member 还可被 tools.allow 限制（`packages/agent-team/src/member-runtime.ts:98`） | 必须明确 Project 自动化权限，防止强制挂载的工具绕过 Member 能力限制。见此前 P0-1。 |
| 当前 sandbox 不提供网络隔离（`spec.md:101`） | 核实为真，限所检查的内置实现 | bwrap 使用文件 bind/PID namespace 而没有 network namespace（`../deepseek-harness/packages/sandbox/sandbox-local/src/profiles.ts:16`）；Seatbelt allow-default/deny-write（同文件 `:52`）；Windows ACL 明确不限制 reads/network（`../deepseek-harness/packages/sandbox/sandbox-windows-acl/src/index.ts:27`） | 不能把脚本称为安全只读查询沙箱；任意部署的自定义/远程 provider 仍可能有不同网络限制。 |
| 沙箱不可用 fail closed，不悄悄回落 local（`materials/harness-webhook.md:61`） | 核实为真，限 sandbox executor | `../deepseek-harness/packages/shell/bash-sandbox/src/index.ts:120`、`:128` 抛 SandboxUnavailableError | 部署主动选择非沙箱 executor 或 danger-full-access 是另一回事；“无提权”不自动带来隔离。 |
| 按名称清除 KEY/PASSWORD/SECRET/TOKEN（`spec.md:100`） | 核实为真，但范围仅 ambient env | `../deepseek-harness/packages/subprocess/subprocess/src/index.ts:47`、`:66`；显式覆盖测试 `../deepseek-harness/packages/subprocess/subprocess-local/tests/spawn.spec.ts:468` | 是 subprocess 包的大小写不敏感名称启发式，不是凭据识别器，也不是所有显式变量都禁止。 |
| gh 凭据不在环境变量，文件登录状态总能使用（`spec.md:100`） | 过时或错误 | 只读命令 `gh help environment`：GH_TOKEN/GITHUB_TOKEN 优先于已存凭据；`gh auth login --help`：系统 credential store 优先，明文文件是 fallback | 需设计 credential reference/显式注入，并验证目标执行器中的实际认证；未读取用户凭据，未能核实当前部署登录可用性。 |
| `DSH_TEAM_*` 注入没有 Harness 先例/需要特殊突破 | 过时或错误，若作此推论；能力已有 | `../deepseek-harness/packages/subprocess/subprocess/src/types.ts:13` 的 DshEnvironmentKey；`../deepseek-harness/packages/shell/shell/src/types.ts:101`；`../deepseek-harness/packages/shell/shell-env/src/index.ts:156` 已注入 HOME/SHELL/SESSION_ID/PROFILE 等事实 | 用明确的 per-run dshEnv 注入即可；ambient DSH_* 会被清除，不要只修改 Host process.env。LAST_SUCCESS_AT 语义由 Team 自己定义。 |
| `ctx.shell` 自带 64 KiB 超限即失败（`spec.md:102`） | 过时或错误 | `../deepseek-harness/packages/shell/bash-local/src/index.ts:104` 默认 64,000 bytes，不是 65,536；`../deepseek-harness/packages/subprocess/subprocess/src/types.ts:21` 是尾部截断+truncated | Team 要显式设置字节数并把截断判为业务失败；不能解析截断尾部后当作完整事件集。 |
| 60 秒和 4 并发均由 Harness现成保证（`spec.md:102`） | 过时或错误：超时可复用，并发是 Team 新职责 | `../deepseek-harness/packages/shell/bash-local/src/index.ts:122` 默认/夹限 timeout；`../deepseek-harness/packages/shell/shell/src/types.ts:53` 的 kill/none；ShellExecutor 公共面没有“Team 全局四个”的调度器（`../deepseek-harness/packages/shell/shell/src/index.ts:64`） | 请求 timeoutMs=60000、使用 kill；effective timeout、abort、基础设施异常分别处理；Team 自己实现互斥和 admission。 |
| shell 返回文本足以严格验证原始 UTF-8（`spec.md:119`） | 过时或错误 | `../deepseek-harness/packages/subprocess/subprocess-local/src/output.ts:308` 使用 toString('utf8')；非法字节会被替换 | 若要求严格 bytes 合法性，须在有损转换前验证；现成返回字符串不能证明原始字节合法。 |
| 公共 shell 接口直接报告 bash/pwsh 类型（`spec.md:96` 的实施前提） | 未能核实：所读公共接口未暴露标准 shell-kind 字段 | `../deepseek-harness/packages/shell/shell/src/index.ts:64` 只有 sandboxMode、resolve、execute；`../deepseek-harness/packages/shell/shell/src/types.ts:139` 结果也无 shell kind | 存储/检查 shell 类型需明确 Team 配置或公开的执行器身份来源，不能猜 OS 必然等于执行器类型。 |

## C. Webhook、WebServer 与 jobs

| 断言与文档位置 | 结论 | 源码/测试证据 | 对设计的实际影响 |
|---|---|---|---|
| Harness 已有 webhook runtime 和 GitHub adapter（`materials/harness-webhook.md:7`） | 核实为真；材料版本不是本机当前版本 | `../deepseek-harness/packages/experimental/webhook/src/index.ts:58`；`../deepseek-harness/packages/experimental/webhook-github/src/index.ts:14`；两包当前 package.json `:4` 为 rc.5 | 不能说 Harness 没有 webhook；这些包仍位于 experimental，版本与采用风险需注明。 |
| rule 可返回 Session request 或 null（材料 `:18`、`:26`） | 核实为真 | `../deepseek-harness/packages/experimental/webhook/src/index.ts:139` 仅 request 非 null 才 createWebhookSession | 返回 null 并调用 Team Host 在接口上可行，不必创建独立根 Session；但这不提供 durable HTTP acknowledgment。 |
| runtime 没有持久队列/重试/去重（材料 `:19`） | 核实为真 | `../deepseek-harness/packages/experimental/webhook/src/index.ts:126` fire-and-forget，`:150` 仅记录失败；`../deepseek-harness/docs/subsystems/webhook.md:23` 明确无这些保证 | 这是本设计不直接复用其接收语义的充分理由：Team要求202之前durable admission。 |
| GitHub adapter 验签后解析，202 不等 rule 完成（材料 `:12`、`:21`） | 核实为真 | `../deepseek-harness/packages/experimental/webhook-github/src/handler.ts:91`、`:101`、`:106`、`:115`、`:120` | 若把 Team durable 入队放在 rule.run 内，仍不能证明返回202之前已入队。 |
| “签名校验、HTTP 路由、请求体限制已由 Harness负责”（材料 `:27`） | 过时或错误，若应用到本 spec 的通用 token 入口 | 上述保证属于 GitHub adapter；通用 WebRoute 只提供原始 req/res（`../deepseek-harness/packages/host/webserver/src/index.ts:47`） | 新 Team token handler 必须自己实现 body 限制、状态码、存储失败、路由生命周期；不能继承未实际使用的 adapter 的保证。 |
| 可用独立 WebServer 避免公开浏览器 API（`spec.md:128`） | 核实为真 | `../deepseek-harness/docs/subsystems/webhook.md:37` 明确建议；`../deepseek-harness/apps/cli/tests/fixtures/github-webhook/cordis.yml:18` 使用 isolate.webServer 和独立监听配置 | Team-owned 入口插件可注入隔离的 webServer 与同一个 agentTeam Host，用 effect 注册 `/team/hooks` prefix route；不要再创建第二个 Team authority。 |
| WebServer 有公开路由注册点 | 核实为真 | `../deepseek-harness/packages/host/webserver/src/index.ts:43` exact/prefix；`:366` register 返回 disposer | 不需要修改 Harness。公网 URL 配置之外仍需监听 host/port、反向代理路由和关闭/排空契约。 |
| jobs 完成通知归属 Session，释放后不能继续送达（材料 `:48`） | 核实为真，针对 owned jobs | `../deepseek-harness/packages/jobs/tool-jobs/src/index.ts:277` 跳过 teardown/不存在 owner；`../deepseek-harness/packages/jobs/jobs-local/src/index.ts:655` 取消、等待并丢弃 owned jobs | 不能替代长期 Project 订阅的 durable ownership。 |
| jobs “只覆盖 Agent 自己启动的本地进程”（材料 `:48`） | 过时或错误 | `../deepseek-harness/packages/jobs/jobs/src/types.ts:179` 是通用 JobSpec，owner 可选，run 是 producer callback，非仅本地进程 | 不选 jobs 的理由应是其生命周期/持久化和本需求不同；可评估复用运行观测，但不能让它成为订阅事实存储。 |

## D. Ledger、Main stream、Inbox、权限与工具

| 断言与文档位置 | 结论 | 源码/测试证据 | 对设计的实际影响 |
|---|---|---|---|
| 未知操作无降级路径（`spec.md:242`） | 核实为真；异常出处的描述过窄 | `packages/agent-team/src/spec.ts:384` 闭合 discriminatedUnion；`packages/agent-team/src/ledger.ts:549` assertUnhandledKind | 需要升级/预览隔离；不是把 unknown 当作可忽略审计记录。 |
| Main stream 可扩展为非 Message 的事件记录（`spec.md:158`） | 核实为真，指可扩展现有闭合模型；不是现成开放注册 API | `packages/agent-team/src/types/requests-results.ts:474` 已有 message/activity/thread-card；`packages/agent-team/src/types/entities.ts:393` MainActivity 当前仅两种 owner 变更 | 可在 Team 内增添 typed source，但要更新 schema、验证/重放、marker、渲染和生成 Remote；不能只增加一张 UI 卡片。 |
| owner marker 不依赖关注；读 Main 消费 marker（`spec.md:160`） | 核实为真，基础机制已有 | `packages/agent-team/src/ledger.ts:5118` 无关注也读取 marker；`:5152` 明确 readThrough 消费；`packages/agent-team/tests/main-stream.spec.ts:376` 覆盖取消关注仍收到 mention | 为 ProjectEvent 扩展 marker 可行，发布操作应原子记录全部收件人；不能把“发送通知成功”替代 read。 |
| 每个当前 owner（含 Human）都可直接用现有 helper 得到（`spec.md:160`） | 过时或错误，若直接调用 projectOwnerIds | `packages/agent-team/src/ledger.ts:2653` 明确该列表只列 Agent owners；`:5077` Human 隐式拥有全部 Project；`:5247` 现有 owner Activity 只给被变更者一个 marker | 必须显式加入 Human，并定义 current 指发布提交时而非执行开始时；现有 helper 不是全 owner 扇出实现。 |
| Inbox 通知“替换而不叠加”（`spec.md:161`） | 核实为真，仅限仍在队列里的聚合 notice | `packages/agent-team/src/index.ts:2959` 查 pending nextStep/nextTurn；`:2967` 移除旧 notice 再构建；`packages/agent-team/src/inbox-delivery.ts:81` 去掉未变化重派生 | 已进入历史上下文的消息不被删除；未来不同更新仍可产生新通知。不能据此承诺无限事件只唤醒一次。 |
| 非 owner 关注 Main 可收到普通更新（`spec.md:160`） | 核实为真 | `packages/agent-team/tests/main-stream.spec.ts:342`；`packages/agent-team/tests/post-commit-delivery.spec.ts:414` | ProjectEvent 应进入同一个 unread source 推导，不能仅做 owner 私有消息而漏掉 followers。 |
| `project_owner_required` 有先例（`spec.md:183`） | 核实为真 | `packages/agent-team/src/ledger.ts:5071`；`packages/agent-team/src/recovery-hints.ts:51` | 可以沿用错误命名/恢复提示规则，但新错误面还包括 stale revision、paused、payload invalid、queue full 等。 |
| `team_message start` 按 Project 校验 owner，不切换工具集（`spec.md:30`） | 核实为真 | `packages/agent-team/src/ledger.ts:1396` 检查 Project membership/ownership；`packages/tool-agent-team/src/index.ts:1530` 固定注册 | 订阅管理按 Project 授权的结构合理；但 owner 授权不能自动替代命令执行权限检查。 |
| 当前 Team 工具是七个（`spec.md:29`） | 核实为真 | `packages/tool-agent-team/src/index.ts:1530` 七个 register；`packages/agent-team/src/member-runtime.ts:32` 同一七个保留名 | 九个是实施后的目标，不是当前能力。 |
| team-member 是本 bundle 唯一 Team 挂载点（`spec.md:30`；材料 `:47`） | 核实为真，限当前 bundle 配置 | `cordis.patch.yml:5` 隔离 agentPresets；`:27` 声明 team-member；`:183` 挂载 Team tools；`docs/architecture/tools-and-preset.md:5` | 不能让普通 Session 获得新增工具或 guidance。外部用户自定义 composition 不属于本次“唯一”的证明范围。 |
| 新增工具只需改 preset | 过时或错误 | preset 一次挂载整个 Team tools 插件（`cordis.patch.yml:183`），源码还须注册工具、更新保留列表（`packages/tool-agent-team/src/index.ts:1530`；`packages/agent-team/src/member-runtime.ts:107`） | 还要 Host 方法/权限、schema、core skills、文档和测试；原 spec 未明确声称“只需”，此处纠正可能的实施推论。 |
| branded ref 风格已有（`spec.md:39`、`:71`） | 核实为真 | `packages/agent-team/src/types/entities.ts:6` 使用 Branded；`packages/agent-team/src/spec.ts:22` 对边界 ref 校验；`packages/agent-team/src/ledger.ts:6424` 集中产生 ref | Reminder/Subscription/Delivery/Event 的身份需明确哪些暴露为 ref、哪些仅内部，不要都用裸 string。 |
| revision 乐观并发模式已有（`spec.md:76`） | 核实为真，但不是现有 Thread revision 每次简单 +1 | `packages/agent-team/src/ledger.ts:5473` 比较 baseRevision；`:5315` 返回 stale_revision；`:3355` 验证 Thread revision 对应 operation.sequence | 可复用并发契约形态，不要复用错误的计数假设；定义新对象的版本推进范围和 expectedRevision。 |

## E. 部署与材料可信度

| 断言与文档位置 | 结论 | 证据 | 对设计的实际影响 |
|---|---|---|---|
| 每个 DSH home 一个 Host 是已保证的部署事实（`spec.md:244`） | 未能核实：未找到本次所查 Team Host/文档中覆盖整个 Host 生命周期的跨进程排他保证 | `docs/architecture/host-authority.md:5` 只规定一个 collaboration domain；`packages/agent-team/src/ledger.ts:6655` 是进程内串行 | 可以规定为限制，不能声称已由现有机制强制；应检测/拒绝第二实例或明确告警。 |
| 不同 profile 能隔离新旧操作（`spec.md:242`） | 过时或错误 | `packages/agent-team/src/index.ts:447`；`docs/development/environments-and-install.zh.md:83` | 独立 DSH_HOME 才是本场景需要的隔离粒度。 |
| 材料记录的 rc.2 与依赖范围兼容（`materials/harness-webhook.md:7`） | 核实为真，作为历史调查说明 | `package.json:172` 起的 Harness peer 范围为 `>=0.2.1-rc.2 <0.2.2`；当前 webhook 包 `package.json:4` 是 rc.5 | “范围允许”不是已通过兼容认证；记录实际验证版本。不能把本机 rc.5 的测试结果虚构为 rc.2 验收。 |
| Holon / dsh-superagent 外部实现足以证明本设计的可靠性 | 未能核实：材料引用的本地源码快照不存在，未另行取回上游 | `materials/holon-webhook-ingress.md:4` 指 `/tmp/holon-src`；`materials/dsh-superagent-event-design.md:4` 指 `/tmp/dsh-super` | 只能作为取舍参考，不能替代 Team 的事务、身份与生命周期证明。 |

## 选择现有能力的结论

1. **不直接采用 dsh-schedule：理由成立。** Member 承诺的身份与 Session 不同。不要顺带声称 schedule 不持久或不恢复冷 Session。
2. **不直接采用 Harness webhook runtime 的接收语义：理由成立，但 spec 应补写。** 它的 202 对应 in-memory dispatch，而 Team 要求 durable admission；返回 null 只能避免新 Session，不能增强 202 的可靠性。
3. **仍应复用 WebServer、shell/subprocess/sandbox 等公共 Interface。** 不需要改 Harness，也不需要自建完整 HTTP 服务器和进程执行栈。隔离 WebServer 的建议与源码装配一致。
4. **不把 jobs 当长期订阅 authority：理由成立。** 但“jobs 只能运行本地进程”不成立；是否复用其运行观测是可选工程决定，不影响 Team 对订阅事实的所有权。

以上结论分别由 A、B、C 各表列出的源码支持；均不表示新订阅能力已经存在。

# PR #77：整体设计质量与 ticket 审视

引用口径：`spec.md`、`issues/`、`materials/` 相对于 Team 仓库的 `.scratch/active/project-event-notifications/`；`packages/`、`docs/` 相对于 `/data/repos/review-pr77`。源码基线为 Team `2f80359`、相邻 Harness `b830ec950`。本篇的“缺少”指目标设计/验收未明确，不将尚未实施的行为虚构为现有缺陷。

## 1. 方案是否成立

### 合理的核心

- **Member 时间承诺与 Project 外部事实分开是合理的。** 前者应随 Member 身份而非 Session 存活；后者不应因创建者离职而停掉整个 Project 的观察。现有 Session recycle 已足以证明这两个身份不同（`packages/agent-team/src/ledger.ts:1026`）；目标归属和创建者离开语义见 `spec.md:11`、`spec.md:173`。
- **事件面向全部 owner，比只叫醒创建订阅的人更符合领域负责制。** 现有 Main markers/explicit reads 可作为送达基础（`packages/agent-team/src/ledger.ts:5118`、`:5152`）；但需要新增全 owner 扇出，而不能直接使用仅向被变更 owner 送达的 helper（同文件 `:5247`）。
- **entry script 存快照优于运行时反复读取原文件。** 它能稳定这一段脚本文本，且可在审计里引用 hash（`spec.md:75`、`:88`）。不过不能保证脚本加载的依赖、仓库分支、CLI 版本或凭据不变；不要把“脚本文本快照”扩大成“完整执行环境快照”。
- **日志不写 ledger 是合理目标。** stdout/stderr 是诊断而非 Team 协作事实；但接受事件、投递交接和影响自动暂停的 checkpoint 不是同类可丢数据（`spec.md:105`、`:121`、`:150`）。

### 统一脚本抽象的真实收益与代价

统一的 `Event[]` 输出 Interface 能将 Main stream、去重、owner delivery 和 UI 做成一次实现，对 GitHub、CI、其他系统形成复用。这个统一点很有价值（`spec.md:116`、`:158`）。但“触发方式 + 脚本”没有消除 provider adapter，只是让 owner 的脚本承担 adapter 的职责：签名、body schema、分页、限流、认证、时间窗口、稳定 ID、查询失败处理。

依据是设计自己已经要求脚本自行验签和确定事件 ID（`spec.md:120`、`:130`、`:193`），同时 Host 为这些脚本承担无监督执行、重试和日志管理（`:102`、`:106`、`:150`）。因此它比“每服务一个受维护 adapter”更灵活，但未必更便宜；需要可验证脚本模板和明确错误契约，不能只给技能文档建议。

### 更简单的替代形态

| 方案 | 能解决什么 | 不足/适用限制 | 建议级别与依据 |
|---|---|---|---|
| 先交付 Member reminder，让 owner 被唤醒后用普通工具检查领域 | 最小成本证明“无需 Human 也会主动巡查” | 每次需要模型介入；检查结果共享和去重仍需 owner 自己完成 | P2：可作为第一 tracer bullet；直接对应 `spec.md:16` 和 `issues/01-member-reminders.md:3`。 |
| 定时只读订阅先行，稳定后再接 webhook | 验证脚本输出 → durable acceptance → Main → owners 的完整路径 | 低于 webhook 的即时性 | P2：当前最终验收只要求 GitHub CI 订阅并唤醒 owner（`README.md:38`），不要求第一条纵切片具备全部 webhook 运维面。 |
| webhook 只置“需要重新查询”标志，统一执行查询脚本 | 可合并重复推送，减少 raw payload/retry 状态，推送与定时共用同一权威查询 | 无法覆盖只存在于推送、无法事后查询的瞬时事件 | P2：比当前每个请求保留并跑 payload adapter 更简单；取舍对应 `spec.md:105`、`:130`，需明确不支持的事件类别。 |
| 固定几个受维护 provider adapters | 可集中维护鉴权、分页、错误分类，降低脚本踩坑 | 扩展速度慢、需求分叉、多 provider 测试成本高 | P2：不建议立刻恢复全量 provider registry；当前没有证据证明广泛 provider 支持比灵活脚本更有价值。 |

**判断：**这项能力对“owner 主动推进”有实际价值，但完整的 durable webhook execution 平台不是证明该命题的最小必要步骤。建议保留最终方向，缩小首个可运行纵切片，而不是抛弃所有订阅设计。

## 2. 概念与模型完整性

| 概念 | 当前定义 | 缺口/风险 | 建议 |
|---|---|---|---|
| MemberReminder | memberId、schedule、note、active/done/cancelled（`spec.md:38`） | P1：缺 occurrence 身份、下一到期计算依据、未消费 occurrence、消费事实；done 容易被误解为已读 | 区分“单次已触发”与“通知已消费”；业务对象结束不等于删除 delivery obligation。 |
| Subscription | projectRef、script/hash、revision、triggers、state（`spec.md:70`） | P1：未规定各 mutation 的 revision 变化、运行采用哪版、暂停原因切换 | 补管理状态转换表；脚本版本与管理 revision 是否分开要明确。 |
| Trigger | 配置有 interval/webhook；env 还有 test（`spec.md:74`、`:101`） | P1：配置类型与实际执行原因不是同一个枚举；create/update/resume 的试运行来源无法审计区分 | 分开 TriggerConfig、RunReason；RunReason 至少能区分正式运行和各管理试运行。 |
| WebhookDelivery | 持久队列、稳定 ID、重试（`spec.md:105`） | P1：没有数据形状、版本绑定、attempt、nextRetryAt、receivedAt、validated output 阶段 | 明确 `received → running → output-saved → accepted` 与 retry/failed/cancelled；run attempt 不是 delivery 本身。 |
| Run | 摘要、输出 tail、50 条保留（`spec.md:150`） | P1：无 runRef、revision/hash、deliveryRef、错误类别；“发布事件数”晚于 run 结束 | 记录关联身份和 outcome；区分 emitted/deduped/accepted/published 数。不要把等待发布当仍占 shell 运行位。 |
| Event | id/title/url/detail（`spec.md:116`） | P1：id 是 provider key 还是 Team ref不明确；name变化后历史显示、重复 id 不同 payload 未定义 | 明确不可变发布内容、订阅内去重键、eventRef/operation identity；同 id 不同 payload 的冲突策略。 |
| Dedupe baseline | create/update 试运行得到（`spec.md:90`） | P0：与验证耦合会吞新事件；P1：替换/合并、版本和 pending 交互不明确 | 显式初始化或 rebaseline，默认更新不吞事件；定义 baseline 与 published id 的联合判断。 |
| Owner marker | 发布给当前 owners（`spec.md:160`） | P1：current 的时间点、Human加入、新旧 owner 交替、历史补送没定义 | 发布提交时固定 recipients，并随同一次 ledger operation 持久化；读取/离开按领域规则消费或清理。 |

现有 ref 使用 `Branded`，requestId 和业务 ref 是不同身份（`packages/agent-team/src/types/entities.ts:6`）。新模型应延续该分离，不应把 `id` 同时用作 HTTP 投递 ID、外部事件 ID 和账本 operation ID。

## 3. Authority、恢复和审计

**P0/P1：需要的是可验证的存储切分，不是“一切都写账本”。**

现有契约要求 mutation 提交一个 durable operation，Inbox 与投影从提交记录派生，重放核对 delta（`docs/architecture/host-authority.md:12`、`:14`）。建议明确四层：

1. **协作事实：**订阅配置、生命周期、已接受/已发布事件、收件人和读取，归 Team ledger authority。
2. **原始入站传输：**webhook 原始请求及接收承诺可以是 Team-owned ingress journal；说明恢复和交接规则，避免原始敏感 body 全部写入不可删除 ledger。
3. **运行 checkpoint：**重试次数、nextRetryAt、failure streak、output-saved 等是影响未来行为的 durable 状态，要有唯一来源和 schema/version。不得用随时可淘汰的 50 条诊断日志替代。
4. **诊断附件：**stdout/stderr、耗时等可按保留策略删除，不应因日志丢失改变“是否应发布/是否已确认”。

`spec.md:82`、`:105`、`:121`、`:150` 目前没有完成以上区分。至少要能回答：只重放账本会得到什么；恢复完整 Host 还需要哪些媒体；哪个媒体丢失应 fail closed；如何备份；被判为 corrupt 的队列是否允许静默清空。外部运行结果本来就不能从 ledger 重新执行来“验证”，重放应验证接受该观察时的身份、顺序、基线与 delta，而不是重新访问 GitHub。

## 4. 可测、可观测、可运维性

- **可测性方向正确，故障点不足（P1）。** 假 shell/时钟、真实脚本和浏览器测试已列出（`spec.md:248`）。还需在每个 durable handoff 前后注入失败，验证重放不重发、不漏标记和终态不复活；仅“202 后重启”不能覆盖全部窗口（`spec.md:252`）。
- **错误面不足（P1）。** exit nonzero/timeout/invalid output 已有，但缺执行器 unavailable、workspace missing、取消、入队失败、磁盘满、corrupt store 和输出持久化失败的分类。Harness result 已区分 timedOut/aborted，基础设施失败会 reject（`../deepseek-harness/packages/shell/shell/src/types.ts:139`；`../deepseek-harness/packages/shell/shell/src/index.ts:49`）。
- **运行日志可读但不足以定位停滞（P1）。** 只显示“上次成功/事件数”无法区分 webhook 未到达、等待 slot、等待 retry、等待发布、零事件成功（`spec.md:201`、`:215`）。至少暴露 lastReceivedAt、nextRunAt、oldestPendingAge、pending/failed counts、failure streak 和结构化最后错误；不用为第一版增加通用监控平台。
- **权限规则总体清楚，必须在 Host 执行（P1）。** logs 输出只给 Human/owner 是好的目标（`spec.md:151`）；列表、详情、失败投递、Remote 返回和后续权限变化都必须以当前 Host 授权为准，不能仅隐藏按钮。
- **运维恢复不完整（P1）。** 失败投递 replay 没有完整工具 Interface；不同 profile 不隔离账本；没有明确单 Host 的排他策略（`spec.md:106`、`:192`、`:242`、`:244`）。

## 5. 六个 ticket 的纵切片与依赖

| Ticket | 判断 | 证据与具体建议 |
|---|---|---|
| 01 Member reminders | 最接近真正独立的纵切片 | create/list/cancel、Host wake、Member 详情与生命周期齐全（`issues/01-member-reminders.md:7`）。P1：补自动消费协议与浏览器验收；不能靠 Task Thread read 代替。 |
| 02 定时订阅 | 核心链路完整性不足 | 声称 Human 创建/恢复（`:3`），但最小表单在04，resume强制试运行在03；事件卡片也在04（`issues/04-subscriptions-tab.md:11`）。P1：把最小UI、resume验证、基础run outcome放回02，或收窄完成声明并注明不可单独发布。 |
| 03 运行记录/失败/更新 | 依赖02合理，但不仅是“历史页”增强 | 自动暂停和安全恢复是核心行为（`issues/03-run-history-and-failures.md:9`），05会用到；P1：让05显式依赖03，或把共用状态机前移02。 |
| 04 标签页 | 依赖03合理，但过于横向 | 大量用户可见能力集中在这里（`issues/04-subscriptions-tab.md:3`），导致02没有端到端Human路径。P2：02先最小界面，04做完整可观察性、编辑和视觉打磨。 |
| 05 webhook | 当前依赖图错误 | 只依赖02（`:4`），却需要03失败计数/记录（`:13`）和04标签页（`:15`）。P1：依赖03+04；若要保留并行分支，拆开可独立完成的Host ingress与UI集成验收。 |
| 06 guidance | 最后做真实验收合理，但例子应更早参与协议验证 | 当前依赖01/02/05（`:4`）。修正05依赖后可间接包含03/04；签名示例与试运行应成为执行器契约的输入，而不是所有实现结束后才发现无可用凭据/fixture（`:7`）。 |

01、02都ready却分别硬写“八个”“九个”工具，会产生并行文档冲突（`issues/01-member-reminders.md:14`；`issues/02-interval-subscriptions.md:19`）。应按实际合并集合更新，而不是为数字人为建立不必要的业务依赖。

## 6. §4.4 硬要求逐项对照 tickets

“部分/未显式”表示 ticket 没有独立列出验收断言；它仍可能通过“规则见 spec”间接引用该要求，但这不足以证明边界被测试。此处不把间接引用误报为完全没有要求。

| spec 规则与定位 | ticket 落点 | 覆盖判断 / 应补内容 |
|---|---|---|
| NDJSON、忽略空行（`:113`） | 02 `:11` 泛称输出解析 | 部分：明确空行、CRLF、无末尾换行的测试。 |
| id/title 必填和长度、url http(s)、detail长度（`:116`） | 02 `:11` | 部分：没有列出字段类型/字节与字符口径的边界断言。 |
| 严格UTF-8（`:119`） | 02 `:11` | 未显式：真实执行器返回已解码字符串，必须单独验收原始字节策略。 |
| 任一行非法整批失败且零发布（`:119`） | 02 `:11` | 明确覆盖；测试应验证此前合法行也没有持久发布。 |
| 去重范围为单订阅，基线+已发布事件（`:120`） | 02 `:11` | 部分：跨订阅同id已明确；基线/已发布集合各自命中及组合需独立断言。 |
| 持久待发布队列、重启续发、20/min、500上限（`:121`） | 02 `:12` | 明确覆盖；补窗口定义和重启不重置发布额度。 |
| 入队前同时对ledger与待发布队列去重（`:122`） | 02 `:11`、`:12` | 部分：ticket只说按订阅/id；需要“已入队未发布”的重复测试。 |
| 定时批次放不下就保存，整批入队，不重跑（`:121`） | 02 `:12` | 明确覆盖；补输出持久化与入队交接崩溃测试。 |
| 每订阅最多一个等待定时批次（`:121`） | 02 `:12` | 部分：描述等待期间跳过，但最好显式断言持久等待批次数<=1。 |
| 等待期间后续定时跳过、不计失败且不改变streak（`:121`） | 02 `:12` | 部分：“不计入连续失败”有；“也不清零”应显式断言。 |
| 定时>500新事件不保存，计1次失败（`:121`） | 02 `:12` | 部分：失败计数有；不保存与错误要求缩小范围需补。 |
| webhook输出暂存、只重试入队，21–500全部发布（`:121`） | 05 `:11` | 明确覆盖，包含脚本运行次数不增加。 |
| webhook>500直接失败投递、不重试、计1次（`:121`） | 05 `:11`、`:13` | 部分：失败投递/计数有；“不重试脚本”的计数断言应明确。 |
| 暂停时pending events继续发布（`:122`） | 无单独验收项 | 未显式：02/05应测试此处与“不运行新脚本”的差别。 |
| 暂停时queued/retrying deliveries保留且冻结，resume继续（`:122`） | 05 `:13` | 明确覆盖。 |
| 暂停时正在运行脚本完成且照常处理（`:122`） | 无单独验收项 | 未显式；特别要测最后结果到达时的state检查。 |
| 暂停新请求409、手动replay拒绝（`:122`） | 05 `:9`、`:13` | 明确覆盖；API尚缺replay action，需先补契约。 |
| 等待入队的定时批次在暂停期间仍入队（`:122`） | 无单独验收项 | 未显式，不能被统一paused gate误拦。 |
| 删除或Project归档清空pending与delivery队列（`:122`） | 02 `:17` 只说停止；05未单列清理 | 未显式：需测试两队列、定时等待批次和迟到run输出。 |
| stderr只进run record，不影响结果（`:123`） | 03 `:7` 保存stderr | 部分：缺 exit0+stderr 输出仍成功的断言。 |

## 7. §4.6 硬要求逐项对照 tickets

| spec 规则与定位 | ticket 落点 | 覆盖判断 / 应补内容 |
|---|---|---|
| trigger/start/duration/exit-or-timeout/event count（`:150`） | 03 `:7` | 字段明确覆盖；event count需先区分accepted/published。 |
| stdout/stderr各尾部8KiB（`:150`） | 03 `:7` | 明确覆盖；补多字节边界、spill清理契约。 |
| 最近50条、私有存储、不写账本、重启保留（`:150`） | 03 `:7` | 明确覆盖；schema损坏/媒体丢失不在当前验收。 |
| Human/owner可读输出，其他Project成员只见摘要（`:151`） | 03 `:8` | 明确覆盖；最好包含权限被撤销后的请求，不能只测初始权限。 |
| 不扫描改写输出；删除订阅删日志（`:151`、`:154`） | 03 `:12` 覆盖删除 | 部分：隐私保证还需核对subprocess spill与传输副本，不应宣称日志tail是唯一副本。 |
| 连续3次失败自动暂停、账本、Main、全部owners（`:152`） | 03 `:9` | 明确覆盖；“全部”应包含Human、已unfollow、suspended。 |
| 只有interval/webhook计数（`:152`） | 03 `:9` | 明确覆盖基本范围。 |
| webhook仅重试耗尽计1次，中间重试不计（`:152`） | 05 `:13` | 部分：耗尽计1次有；中间任一时点不得提前暂停需单独断言。 |
| webhook>500直接失败计1次（`:152`） | 05 `:13` | 明确覆盖。 |
| retry任次成功视为投递成功（`:152`） | 05 `:13` | 覆盖失败后重试成功流程；与streak清零时点的结合未明确。 |
| test/create/update/resume的试运行既不加也不清streak（`:152`） | 03 `:9` 写“test等” | 部分：逐一枚举四种入口，避免resume trial和resume commit混为一谈。 |
| 任一正式运行成功清零（`:152`） | 无单独验收项 | 未显式；必须定义成功在output accepted还是published。 |
| resume成功后清零（`:152`） | 03 `:9` 只写试运行通过 | 未显式；测试应分“trial成功但提交冲突”与“resume commit成功”。 |
| resume/test都试运行，resume只有通过才恢复（`:153`） | 03 `:9`、`:11` | 明确覆盖；webhook-only fixture缺口仍需解决。 |
| 删除日志、保留账本事件（`:154`） | 03 `:12` 只显式删除日志 | 部分：保留历史event内容/可读性应有回归断言。 |

## 8. 实施最可能卡住的地方

1. **P0：长运行与ledger串行队列的切分。** 不能把最多60秒的脚本执行放进全Team mutation队列，也不能在队列外完成后不重新校验。现有序列化是 `packages/agent-team/src/ledger.ts:6655`；需设计 prepare/run/commit 的明确阶段。
2. **P0/P1：接受事件到发布的崩溃一致性。** 当前domain只有operations表（`packages/agent-team/src/spec.ts:767`），新增私有持久状态不是简单添个Map；先明确authority和事务，不要临时发明恢复优先级。
3. **P1：执行器真实契约。** 无Session调用可行，但shell类型识别、严格UTF-8、stdout截断、凭据、取消和Windows agentless策略要有真实测试（`../deepseek-harness/packages/shell/shell/src/index.ts:64`；`../deepseek-harness/packages/subprocess/subprocess-local/src/output.ts:305`；`../deepseek-harness/packages/sandbox/sandbox-local/src/index.ts:357`）。
4. **P1：新Main source的全路径扩展。** schema、replay、Inbox source、tool formatter、surface rendering和Remote都要同步，不能将Event硬塞进要求memberId的旧MainActivity（`packages/agent-team/src/types/entities.ts:393`）。
5. **P1：保持客户端是投影而非authority。** 非乐观UI方向正确（`issues/04-subscriptions-tab.md:9`）；Typert应从Host声明生成（`docs/architecture/client-and-remote.md:6`），slot继续用现有公开注入方式（`packages/client-agent-team/src/client/index.ts:117`）。此次订阅标签页没有理由复制Harness私有UI或重声明workspace slot children。

## 结论

这份文档在产品归属、权限主体、数量限制和失败场景意识上优于粗略草案；不足集中在跨状态机交接，而非“缺更多功能”。修订重点应是删掉错误等价关系、补不可省略的状态与提交点、重排纵切片。不要再增加适配器注册中心或通用任务平台来掩盖这些问题。

# PR #77：Edge cases 与崩溃一致性审视

## 阅读方式

本篇区分“spec 已写但有问题”与“新增的未定义场景”，避免把已考虑的限制冒充新发现。每条给出触发条件、后果和建议；后果属于依据条款推演的风险，不声称已经在尚未实现的代码里复现。

证据基线：Team `/data/repos/review-pr77@2f80359`，Harness `/data/repos/deepseek-harness@b830ec950`。`spec.md`、`issues/` 相对于 `.scratch/active/project-event-notifications/`，其他路径相对于 Team 根。P0 是会导致错误行为或架构返工；P1 是关键未定义行为；P2 是改进。

## A. 已有条款中写错、漏限定或互相冲突的部分

### A1 · P0：“脚本推进游标也不会丢事件”承诺过强

**原文：**“这样即使脚本在运行中推进了游标或消费了 API 分页，事件也不会丢。”（`spec.md:121`）

**触发 → 后果 → 建议：**脚本先消费外部消息/提交游标，尚未把完整 stdout 交给 Host 就崩溃 → 下次无法重读，持久待发布队列也没有该事件 → 无丢失保证只能从 Host 持久接受输出开始；禁止依赖脚本自行提交游标，或设计由 Host 持有的 checkpoint/确认协议。至少一次运行不自动提供至少一次事件交付。

**证据：**文档在脚本成功、输出校验后才保存结果（`spec.md:108`）。这就是外部状态改变与本地记录之间的不可原子窗口。

### A2 · P0：更新试运行会把等待恢复的真实事件变成基线

**原文：**“update 同样先试运行，再重新写入去重基线。”（`spec.md:91`）

**触发 → 后果 → 建议：**两次轮询间出现X，owner只是改名称；或者为失败投递修复脚本并试运行输出X → X进入不发布的基线，后续正式运行/重放把X去重 → 普通update保留baseline；初始化历史水位和主动discard必须是显式动作。待发布事件不得被新baseline无意吞掉。

**证据：**试运行输出不发布（`spec.md:90`），正式去重检查baseline和已发布id（`spec.md:120`）。这不是只有崩溃才出现的问题。

### A3 · P1：严格 webhook-only 脚本没有创建、test、resume 的合法输入

**原文：**“Host 用正式运行时的同一套方式试运行”；“resume 只有试运行通过后才恢复”；stdin包含headers/body。（`spec.md:89`、`:153`、`:130`）

**触发 → 后果 → 建议：**脚本要求真实事件头及HMAC，试运行却无fixture → 合法脚本无法创建或恢复；若test分支直接返回0，则验证不到正式路径 → 加test envelope或明确独立validation协议，禁止声称一次空载运行能验证全部触发方式。试运行可能有副作用，不能被UI隐藏的重复调用放大。

### A4 · P1：仅 Host delivery ID 并不能覆盖外部重投幂等

**原文：**“在入队时由 Host 分配……投递 ID”；“以投递 ID 做幂等判断，避免重复执行造成重复修改”。（`spec.md:107`）

**触发 → 后果 → 建议：**入队成功但202丢失，采用重试策略的提供方再次发同一事件 → 两次admission可能获得两个Host ID，副作用执行两次 → 区分provider delivery ID、Host admission ID、业务event ID；副作用用provider/业务稳定键，或第一版只支持可重复查询。

**证据：**GitHub的独立投递身份来自 `x-github-delivery`（`../deepseek-harness/packages/experimental/webhook-github/src/handler.ts:93`），spec尚未定义admission重复识别。

### A5 · P1：“暂停”不是停止事件/停止所有副作用

**原文：**“暂停……待发布队列中的事件继续发布”；“正在运行的脚本会运行完”；风险处理为“Human 可以随时暂停”。（`spec.md:122`、`:237`）

**触发 → 后果 → 建议：**Human因异常脚本或通知风暴点击暂停 → 最多剩余一轮执行仍可能修改外部状态，已接受事件仍继续通知owner → 这组条款不是必然逻辑矛盾，但UI/风险说明必须写“停止新运行，继续排空已接受事件”。若产品需要急停，定义独立的取消/丢弃策略，不要悄悄改变暂停语义。

### A6 · P1：“与现有通知一致”同时指定了不同送达和消费行为

**原文：**运行中“在本轮结束后送达”，通知进入一轮即已读。（`spec.md:49`、`:62`）

**触发 → 后果 → 建议：**直接复用现有Inbox → 通常下一step送达，而且Task reminder仍需显式Thread read → 为Member reminder定义新的消费事实和明确lane。

**证据：**`packages/agent-team/src/index.ts:2976`；`packages/agent-team/tests/task-reminders.spec.ts:156`。

### A7 · P1：500条队列上限不是500条总积压上限

**原文：**“待发布队列上限500条”；定时可另存一批；每个webhook投递可保存已校验事件；webhook最多排10个。（`spec.md:121`、`:105`）

**触发 → 后果 → 建议：**pending占满，定时和多个webhook都有已校验输出 → 除500条pending之外还有其他durable backlog；若允许10个投递均到output-saved阶段，理论身份槽可达500+500+10×500条事件，实际数量还受stdout字节上限约束 → 明确每订阅及全Host的总字节/条目预算，包含所有等待批次和raw body；不要把单队列上限宣传成总内存/磁盘上限。

### A8 · P1：成功清零与“全部入队后才完成投递”缺少共同定义

**原文：**“任何一次……运行成功都会把计数清零”；“投递只在其运行成功、全部新事件已进入待发布队列后才删除”。（`spec.md:152`、`:105`）

**触发 → 后果 → 建议：**脚本exit0但事件等队列空间；另一投递耗尽retry → 何时清零、何时自动pause由实现顺序偶然决定 → 明确run success、output accepted、delivery complete三个状态；规定streak在何处改变，并持久化其决策顺序。`DSH_TEAM_LAST_SUCCESS_AT`必须使用同一个已定义概念（`spec.md:101`）。

### A9 · P1：日志留存声明遗漏执行器的输出副本

**原文：**“只保留最近50条，删除订阅时一并删除”。（`spec.md:241`）

**触发 → 后果 → 建议：**脚本产生大量stdout/stderr触发subprocess spill → Team删除50条日志后临时文件仍可能存在 → 将spill写入/清理纳入执行器契约，或缩小隐私承诺。

**证据：**`../deepseek-harness/packages/shell/bash-local/src/index.ts:157` 配置spill；`../deepseek-harness/packages/subprocess/subprocess-local/src/output.ts:31` 说明完整输出文件保留直到外部清理。

### A10 · P1：无限去重集合是已接受限制，但没有长期承载依据

**原文：**“去重id集合不清理……第一版接受；单个id不超过200字。”（`spec.md:243`）

**触发 → 后果 → 建议：**订阅长期高频产生全新id → 账本、重放时间和内存集合持续增长；单id长度限制不能限制集合规模 → 给出支持规模、启动重放预算和运维报警。若20/min按每订阅理解，持续满额一年约10,512,000条事件，这是上界压力算例，不是对真实流量的预测。不要直接加TTL删除已发布id，否则会改变“永久不重复”的契约；需设计显式generation/retention。

**证据：**发布额度见 `spec.md:121`；当前ledger重放按全部记录验证序号、requestId及投影（`packages/agent-team/src/ledger.ts:2924`）。

## B. 未覆盖的崩溃窗口：逐一给出恢复结果

现有测试点有“202后重启”和“队列重启恢复”（`spec.md:248`、`:252`），但没有以下各个中间提交点的协议。它们是未定义的窗口，不是声称spec完全没考虑重启。

| 等级/窗口 | 触发条件 → 具体后果 | 建议处理 | 证据 |
|---|---|---|---|
| P0 B1：durable admission前后 | 队列写入失败或只是内存成功，HTTP却返回202 → 上游以为已接受，Host重启丢请求 | durable commit成功才202；磁盘满/存储不可用返回明确5xx；不得吞异常 | `spec.md:144` 的202保证；现有Harness adapter只做in-memory dispatch（`../deepseek-harness/packages/experimental/webhook-github/src/handler.ts:115`），不能直接借用其ACK。 |
| P1 B2：admission成功、202发送失败 | 响应丢失，上游重投 → 重复admission/运行 | admission去重策略与ID说明；允许重复则必须文档化，脚本幂等不能只依赖新Host ID | `spec.md:105`、`:107`。 |
| P0 B3：脚本运行中或输出保存前 | Host被kill；子进程是否继续、外部游标是否已改、完整stdout是否已保存不清 → 重复副作用或永久丢事件 | 记录run attempt和恢复策略；限制脚本行为，明确不保证外部副作用exactly-once | `spec.md:107`、`:108`；Shell进程生命周期由subprocess控制（`../deepseek-harness/packages/shell/shell/src/index.ts:60`）。 |
| P0 B4：输出保存后、交接pending前 | crash发生在validated-output durable write和pending enqueue之间 → 可能重跑脚本，或重复/漏入队 | 持久output-saved阶段；重启先重做幂等交接，不重跑该attempt；stable batch ID | `spec.md:108`、`:121`。 |
| P0 B5：pending入队后、原delivery删除前 | 重启仍看到原delivery → 再执行或再加入同批事件 | 幂等acceptance receipt或同一事务交接；恢复时依据receipt确认，不靠运行日志猜测 | `spec.md:105`、`:122`。 |
| P0 B6：ledger发布后、pending确认删除前 | 重启重新发布同一项 → Main重复记录或重复owner marker | 发布operation使用稳定业务幂等键；ledger中已发布即确认，不另发；event和recipients同一operation | `spec.md:120`、`:160`；现有byRequest先查再写的模式见 `packages/agent-team/src/ledger.ts:1029`。 |
| P1 B7：部分owner收到通知后crash | 一些Agent收到hint，另一些尚未收到 → 若以hint成功标记全体完成则有人漏；若重建全部hint则有人重复 | ledger原子记录每个owner未读marker，按当前未读重派生hint；允许hint至少一次，不重复事实 | `spec.md:160`；`packages/agent-team/src/ledger.ts:5152`；`packages/agent-team/src/inbox-delivery.ts:56`。 |
| P1 B8：跨媒体备份/恢复 | ledger恢复到新时点、队列恢复到旧时点或缺失 → pending复活、已接受事件丢失、streak回退 | 备份一致性边界、媒体generation/checkpoint、恢复校验及fail-closed；不能静默清空无法解析的队列 | `spec.md:82`、`:105`、`:150` 的分媒体设计；当前存储路径见 `packages/agent-team/src/index.ts:447`。 |

## C. 时间、排队与调度

| 等级/场景 | 触发条件 → 具体后果 → 建议处理 | 证据 |
|---|---|---|
| P1 C1：时钟回拨/跃进 | NTP回拨、手动改时钟或长时间休眠 → once重复/迟延，retry和“每分钟20条”额度异常 → 持久UTC到期目标和occurrence身份；timeout用单调计时；恢复只补最新missed occurrence且不重复已记录触发 | `spec.md:51`、`:52`、`:109`、`:121` 未给回拨算法；Harness schedule已专门在恢复Session后重查时间（`../deepseek-harness/packages/schedule/schedule/src/runtime.ts:105`）。 |
| P1 C2：cron方言与最小间隔 | cron含秒、DOM/DOW组合或相邻触发不足10min，检查器只看平均频率 → 绕过提醒频率限制或与预期日期不同 → 固定cron方言、数字范围和DOM/DOW语义；校验实际最小相邻间隔；once.at要求有明确时区 | `spec.md:41`、`:51`、`:53`。固定UTC+8自身没有DST，不应虚构它的夏令时bug；问题在输入解析和浏览器展示。 |
| P1 C3：反复启动绕过interval | Host每次启动都立即随机延迟<=1min运行，即使5min间隔未到 → 频繁重启产生额外请求、可能反复触发副作用 → 明确启动立即check还是仅对due/missed补发；持久nextDue，恢复不重置节流额度 | `spec.md:109` 同时规定启动首次运行和最小间隔，未定义二者优先级。 |
| P1 C4：webhook抢占/全局饥饿 | 一个订阅持续有10个delivery并重试，其他订阅interval/test排队 → 4个slot不足时长期饥饿或测试占满无人值守执行 → 所有入口共享明确fair admission；每订阅最多一个running，待入队输出不占shell slot；限制每订阅连续服务批次 | `spec.md:103`、`:104` 只完整描述定时等待合并；webhook公平性未给出。 |
| P1 C5：失败重试与成功交错 | 一个坏webhook正在1/5/30min退避，定时每次成功0事件 → streak可能永不达到3；多个投递耗尽的顺序又影响“连续” | 按明确定义的terminal outcome提交顺序计数，另显示每通道健康与failed delivery数量；不要擅自改成“任意3次失败” | `spec.md:106`、`:152` 已指定成功清零，但未说明混合通道的可观察语义。 |
| P1 C6：配额竞争 | 两个owner同时create，分别在试运行前看见19/20订阅；两个提醒请求各看见49/50 → 长试运行后双双提交超过上限 | 配额在最终串行commit重查；如需reserve，定义超时回收；quota检查不能仅在表单或执行前 | `spec.md:53`、`:92`；现有ledger串行队列见 `packages/agent-team/src/ledger.ts:6655`。 |

## D. 配置、状态与身份的交叉

| 等级/场景 | 触发条件 → 具体后果 → 建议处理 | 证据 |
|---|---|---|
| P1 D1：r1运行与r2更新 | r1运行中提交r2或暂停后更新 → r1结果误用r2baseline、日志误标、给新脚本计失败 → run固定revision/hash；配置生效与迟到结果处理分开；错误计数归属明确 | `spec.md:75`、`:76`、`:91`、`:103`。 |
| P1 D2：旧delivery在新脚本下retry | 初次运行r1失败，owner更新到r2，retry/replay继续 → 相同delivery ID执行不同程序；若副作用幂等缓存已记录失败阶段，修复也可能被跳过 → 选择并记录版本策略；重放可显式选择当前版本并展示差异，不要隐式切换 | `spec.md:106`、`:107` 没有revision绑定。 |
| P1 D3：删除/归档与在飞行结果 | 清空队列后脚本返回、pending drain已取出项、或原请求仍在读body → 终态后复活队列/写事件/返回错误202 → 在admission、execution、acceptance、publication各提交点检查终态；取消与排空顺序明确 | `spec.md:122`、`:172`。可从Project归档操作派生停止，不必为每订阅额外写删除操作。 |
| P1 D4：多owner管理竞争 | pause/resume/reset/delete同时发生；试运行期间操作者被撤销owner → 覆盖别人的控制意图或提交无权变更 → 每种mutation都规定expectedRevision和requestId；等待后重新鉴权；resume trial成功但commit失败不得清streak | `spec.md:177`、`:183`、`:152`；已有Project owner gate见 `packages/agent-team/src/ledger.ts:5071`。 |
| P1 D5：Member归档时提醒在飞行 | reminder hint已排队但尚未认领，Member归档/移除；旧Session在换代 → 被取消的提醒仍唤醒旧Session或错误消费新occurrence → occurrence和Session generation分离；取消后撤销可撤销hint，消费回写时重查身份；已进入模型的输入不可假装撤回 | `spec.md:49`、`:61`、`:63`；Team notice覆盖与queued消息存在 `packages/agent-team/src/index.ts:2959`。 |
| P1 D6：done但未消费的单次提醒 | once触发写done后Host重启，或Human执行cancel → 若只扫描active提醒则漏掉应送达的done occurrence | 活跃schedule与未读occurrence分开投影；规定done提醒可否cancel未消费消息、是否计“50个有效” | `spec.md:43`、`:49`、`:53`。 |
| P1 D7：owner集合改变 | 事件被接受后在pending等待25min，期间owner换人/取消关注/暂停 → 按run开始名单与发布时名单得到不同收件人 | 定义以发布ledger commit时的owner集合为准，显式加入Human；新owner是否补历史另定规则；收件人列表随operation冻结 | `spec.md:160`；`packages/agent-team/src/ledger.ts:2653` 的projectOwnerIds不包括Human。 |
| P1 D8：日志阅读途中失去权限 | Web页面已打开日志或订阅详情，Member被撤销owner；后续poll仍带旧缓存权限 → 继续泄露stderr/raw body | 每次Host读取重新鉴权；客户端收到权限变更后清理敏感缓存；无法撤回已合法返回的数据需明确 | `spec.md:151`、`:183`，只定义静态角色表，未定义订阅/缓存失效。 |
| P1 D9：Team插件/执行器热重载 | Team停用或shell-only reload，旧run仍存活，新Host开始调度 → 同一订阅并行、旧结果写入新实例 | Team持有每个run的AbortController和generation；dispose停止admission并处理在飞行任务；重启对旧generation结果拒绝提交 | `../deepseek-harness/packages/shell/shell/src/index.ts:60` 明确进程受subprocess生命周期管理、可存活于executor-only reload；`spec.md:103` 的互斥尚无跨reload定义。 |

## E. Workspace、脚本输入与输出极限

| 等级/场景 | 触发条件 → 具体后果 → 建议处理 | 证据 |
|---|---|---|
| P1 E1：Workspace目录替换/改名 | 解析Workspace后、spawn前目录被改名或同路径被替换为另一个repo；symlink目标改变 → 在错误项目或错误写入根执行 | 从registry取可信路径，运行前验证可用性和执行世界路径；记录canonical cwd；路径身份变化fail closed或要求确认，不退回process.cwd | `spec.md:97`、`:176` 只覆盖“不存在”；Workspace路径是realpath语义（`../deepseek-harness/packages/workspace/workspace/src/types.ts:74`）。 |
| P1 E2：快照仍读取可变依赖 | script快照执行`source ./helpers.sh`、读取仓库配置/相对文件；分支切换 → 页面脚本相同但实际逻辑改变 | 明确快照只冻结entry文本，示例尽量自包含；记录hash/cwd/必要诊断；需要可重复部署时另定义依赖策略，不假装已经冻结环境 | `spec.md:26`、`:75`、`:88`。 |
| P1 E3：Agent路径与Human粘贴差异 | Agent当前cwd不同于Session初始cwd；提交路径是symlink/FIFO或读取中被改写；Human试运行后又编辑文本 → hash和实际执行不一致、Host读文件卡住 | Agent路径由当前working-directory服务解析，限制普通文件与读取字节；读一次生成不可变content/hash；Human文本使用同一校验/执行路径，测试结果绑定输入hash与revision | `spec.md:87`、`:88`、`:229`；Member bash实际使用workingDirectory.ensure（`../deepseek-harness/packages/shell/tool-bash/src/index.ts:488`）。 |
| P1 E4：silent success | `gh api`认证过期/限流失败，被管道后段或`|| true`吞掉，最终exit0且stdout空 → Host合法判0事件成功、清失败数；若推进lastSuccess会漏查询窗口 | bash示例保留失败状态、使用适当pipefail；pwsh示例明确终止错误处理；示例包含认证过期测试。generic Host不能可靠猜测空输出是否业务失败 | `spec.md:89`、`:113`、`:152`。 |
| P1 E5：JSON极端输出 | 超长单行、无结尾换行、CRLF/BOM、非法UTF-8、重复JSON键、重复event id不同payload、空白id/title、嵌套对象、控制字符 → 解析器之间出现分歧或静默改写身份 | 固定字节解码和行切分，明确BOM/CRLF规则；严格字段类型、trim/长度计量和unknown-key策略；重复键/重复id冲突必须选定拒绝或确定性规则，不能靠JSON.parse偶然行为 | `spec.md:113`、`:116`、`:119`。现有collector有损解码见 `../deepseek-harness/packages/subprocess/subprocess-local/src/output.ts:305`。 |
| P1 E6：重放与baseline交互 | pending已有X；update重建baseline含X；恢复时ledger已有X但pending未删 → 有实现丢旧pending，有实现重发X | baseline generation、accepted IDs、published IDs关系固定；replay不执行脚本；入队与发布两阶段都以ledger/receipt判断幂等；旧generation历史不重解释 | `spec.md:90`、`:91`、`:120`、`:122`。 |
| P1 E7：查询窗口与分页遗漏 | 用LAST_SUCCESS_AT当API水位，但外部事件最终一致性延迟、分页未取完、提供方时钟不同 → 成功运行仍永久漏掉事件 | lastSuccess不承诺是provider cursor；模板使用重叠窗口+稳定id，明确分页完整性失败；确需游标则用独立checkpoint协议 | `spec.md:101`、`:121`，未定义该env的时间语义或提供方水位。 |
| P1 E8：不可信文本进入不同阅读面 | Main卡片不解析Markdown，但tool read/history或通知格式化路径仍直接拼接恶意标题、URL/控制字符 → 视觉欺骗或提示注入风险被误认为已消除 | 所有面统一纯文本投影、长度/控制字符处理、明确外部数据标注；不让文本决定mentions/权限/命令。标注可降低风险，不能保证模型永不把文本当指令 | `spec.md:159`；现有Main类型需扩展全部formatter（`packages/agent-team/src/types/requests-results.ts:474`）。 |

## F. HTTP、token 与资源放大

| 等级/场景 | 触发条件 → 具体后果 → 建议处理 | 证据 |
|---|---|---|
| P1 F1：原始body与HMAC字节 | 非UTF-8、带BOM、gzip、chunked body、重复header → 把body转string/改写header后验签与提供方不同，或限制作用在错误字节层 | 定义支持的媒体/编码；对支持的UTF-8保留签名字节，或stdin提供base64原始bytes；不支持编码明确拒绝；签名header超限宜拒绝而非截断 | `spec.md:130`、`:131`；现有GitHub adapter专门bounded UTF-8读取和验签（`../deepseek-harness/packages/experimental/webhook-github/src/body.ts:36`；`../deepseek-harness/packages/experimental/webhook-github/src/handler.ts:101`）。 |
| P1 F2：慢请求/中断请求 | 客户端不发Content-Length、慢速chunked、读body途中断开 → 队列虽有10条限制，尚未入队连接仍占资源 | header/body/read deadline、总并发、流式字节上限、abort处理；验证token/state尽量早做，commit前再次检查；状态码定义400/5xx等故障面 | `spec.md:135` 只列正常拒绝类别；WebRoute原始req/res由handler负责（`../deepseek-harness/packages/host/webserver/src/index.ts:47`）。 |
| P1 F3：429与重试共振 | 多个采用自动retry的provider同时撞满队列；内部1/5/30min重试也同步 → 周期性流量尖峰、其他订阅饿死 | 返回Retry-After（若支持）、内部retry加受控jitter、公平admission；对全Host连接/字节限额，不只每subscription条数；不假设所有provider会自动重投 | `spec.md:106`、`:140`，未定义两层退避协调。 |
| P1 F4：暂停/归档/禁用webhook/重置token交叉 | 请求通过token检查后owner reset/archive；或202已接受后token失效 →旧请求是否继续入队/执行不确定 | admission commit时重查token generation和终态；规定已202接受的请求是否保留，reset仅拒绝新旧地址请求还是取消旧delivery要明确；关闭webhook也应撤销地址 | `spec.md:127`、`:138`、`:172`；`issues/05-webhook-trigger.md:14`只规定旧地址立即失效。 |
| P1 F5：token一次返回与响应丢失 | create/reset已提交hash，响应丢失；客户端按requestId重试 → Host无法从hash恢复同一完整URL；再次create可能多建订阅 | 幂等重试返回已提交对象和“地址不可再次取回”，提供显式rotate恢复；不得偷偷存明文token到ledger或静默新建对象；测试commit后断连 | `spec.md:127`、`:230`；现有requestId机制见 `packages/agent-team/src/types/entities.ts:9`。 |
| P1 F6：URL泄漏不在ledger内 | 代理access log、错误日志、工具结果、Session导出记录完整capability URL → token哈希存储仍不能阻止别人触发 | 路径日志脱敏，文档列出代理配置与URL保密范围，避免把URL渲染成会触发预取的链接；已接受Session本地副本风险不等于其他副本不存在 | `spec.md:127`、`:239`、`:240`；签名不强制时URL本身即调用资格。 |
| P1 F7：失败记录过期但旧输入仍存在 | subscription长期paused，pending delivery无限保留；failed仅10条/7天，run仅50条 → raw敏感body寿命不统一，失败可重放性随淘汰消失 | 分别定义raw admission、output-saved、failed、run/spill的TTL和淘汰可见性；失败记录淘汰需可观察，不假装永远能replay | `spec.md:106`、`:122`、`:150`，只有failed/run的数量期限，暂停队列TTL未定义。 |
| P2 F8：恢复旧备份复活旧token/水位 | 从reset前备份恢复 → 旧地址再次有效，已发布事件可能重新处理 | 恢复runbook明确rotate全部外部token并核对checkpoint；若要求跨备份的不可复活撤销，再设计独立epoch，不把它当默认现有保证 | `spec.md:127`、`:129`、`:243` 的持久状态及重置语义；备份恢复策略尚未规定。 |

## 最应先写成测试的六组场景

1. r1 run跨过update/delete/archive：迟到结果不复活终态、不污染r2统计。
2. 在B1/B4/B5/B6各持久交接点注入崩溃：恢复后的event/marker集合确定且不重发事实。
3. 创建webhook-only、修复失败投递、resume及重放：fixture/基线不吞新事件。
4. 多owner、Human、unfollow/suspended组合：发布收件人确定，通知至少一次而显式读取只消费自己的marker。
5. stderr-only、非法UTF-8、超限但尾部合法JSON、silent gh失败：outcome不被误分类。
6. pause与三种积压（pending events、output-saved batch、retry delivery）交叉：排空和冻结分别符合已选择的语义。

这些测试分别对应本篇B、D、E和A5，均是在现有 `spec.md:248`、`:252` 测试计划上的具体化，而不是增加与目标无关的测试平台。

# PR #77：合并前的 spec 修改清单

## 总体建议

**建议修改后合并，不建议按现状合并并标为“设计已收敛”。** Member 时间承诺与 Project 外部事实的归属合理，也有现成 Inbox/主时间线机制可复用；阻塞项是权限推导、持久交接和试运行/基线语义，而不是缺少更多功能。

本 PR 仅改设计文档：下面“合并前”要求把契约与实施验收写清楚，**不要求先实现全部功能或跑完未来功能测试才能合并设计 PR**。实际实施时再按 tickets 执行相应检查。

引用约定：`spec.md`、`issues/` 相对于 `/data/repos/review-pr77/.scratch/active/project-event-notifications/`；`packages/`、`docs/` 相对于 Team 根。核实基线为 Team `2f80359`、相邻 Harness `b830ec950`。

## A. 三个首先解决的 P0

- [ ] **P0 · §2 / §4.3 / §4.9：重写自动化执行权限。** 删除“不提权所以等于Member bash权限”的推导；明确受限owner是否可以create/update/test，Project自动化是否是新的显式授权能力；给出无人值守执行mode/root的唯一来源。不能由固定保留的 `team_subscription` 绕过 `tools.allow`。证据：`spec.md:98`、`:101`；`packages/agent-team/src/member-runtime.ts:98`；`../deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts:164`。
- [ ] **P0 · §4.1 / §4.3 / §4.4：补权威、持久化及交接协议。** 分开配置/事件事实、raw ingress journal、运行checkpoint、可删除诊断；画出admitted → running → output-saved → accepted → published的提交点、幂等身份及崩溃恢复。明确发布与所有owner markers同一ledger operation。将“不丢事件”限定在Host已持久接受的范围，不承诺脚本自行推进外部游标也无损。证据：`spec.md:82`、`:105`、`:108`、`:121`；`docs/architecture/host-authority.md:12`。
- [ ] **P0 · §4.2 / §4.6：分离试运行与初始化去重基线。** create可明确选择忽略当前历史；普通update不得自动吞掉新事件；定义显式rebaseline的作用。补webhook-only的测试输入/fixture，说明resume如何验证及失败投递修复后如何重放。证据：`spec.md:89`、`:90`、`:91`、`:120`、`:153`。

## B. 按 spec 章节修改的 P1/P2 动作

### §1–§2：问题与复用决策

- [ ] **P2：改正问题定义的绝对说法。** 改为“已有Task/执行相关唤醒，但缺通用Member时间承诺与Project外部订阅”；保留owner主动推进目标。证据：`spec.md:7`；`packages/agent-team/src/task-reminders.ts:58`；`../deepseek-harness/packages/jobs/tool-jobs/src/index.ts:296`。
- [ ] **P1：补不直接采用Harness webhook/jobs的准确理由。** schedule的关键是Session ownership；webhook runtime的关键是202仅代表in-memory dispatch；jobs并非仅本地进程，但不是durable Project订阅。说明仍复用公开WebServer和shell/subprocess。证据：`../deepseek-harness/packages/schedule/schedule/src/runtime.ts:101`；`../deepseek-harness/packages/experimental/webhook-github/src/handler.ts:115`；`../deepseek-harness/packages/jobs/jobs/src/types.ts:179`。

### §3：Member reminder

- [ ] **P1：补occurrence和消费事实。** 明确schedule状态与未读occurrence独立、once触发后done仍可待送达；循环替换以哪个occurrence为单位；未在通知中实际呈现的提醒不得消费。写出Session认领/持久化与Team消费commit顺序及重复容忍。证据：`spec.md:43`、`:49`、`:50`；当前Task消费测试为 `packages/agent-team/tests/task-reminders.spec.ts:156`。
- [ ] **P1：明确通知lane与取消竞争。** 选择下一step或下一turn，不再称二者等同；补suspend/archive/remove、旧Session换代和在飞行hint的处理。证据：`spec.md:60`、`:61`、`:62`、`:63`；现有lane为 `packages/agent-team/src/index.ts:2976`。
- [ ] **P1/P2：固定时间输入契约。** cron方言、DOM/DOW语义、最小相邻间隔、once.at的时区格式、已过去时间、时钟回拨及错过补发的occurrence身份；UI明确UTC+8与浏览器本地时间。证据：`spec.md:41`、`:51`、`:52`、`:53`；`packages/agent-team/src/time-format.ts:2`。

### §4.1–§4.3：模型、快照与执行

- [ ] **P1：补最小运行身份和状态表。** 列出deliveryRef、runRef、batch ID、subscriptionRevision/scriptHash、run reason、attempt/nextRetryAt、outcome和checkpoint；哪些字段是derived明确标出，不要求每个概念都新增表。证据：`spec.md:70`、`:105`、`:150`。
- [ ] **P1：把“待实施时才知道可写根”改成已核实的公共接口与待验证的平台行为。** 明确Host传workdir和完整sandboxPolicy，不伪造Session；明确shell类型身份来源、服务注入和executor不可用的行为。证据：`spec.md:96`、`:99`；`../deepseek-harness/packages/shell/shell/src/types.ts:103`；`../deepseek-harness/packages/shell/bash-sandbox/src/index.ts:85`。该字段在 `687f282e` 也存在。
- [ ] **P1：补凭据通道。** 选择credential reference显式注入或受控凭据文件；说明ambient scrub和显式env差别，不建议改名绕过scrub；去掉gh凭据必在文件的断言。证据：`spec.md:100`、`:130`；`../deepseek-harness/packages/subprocess/subprocess/src/index.ts:47`；只读命令 `gh auth login --help`、`gh help environment`。
- [ ] **P1：固定调度、公平性和取消规则。** test/create/update/resume的试运行也必须纳入per-subscription互斥和全局admission；说明webhook与interval优先级、等待批次是否占slot、重启是否无条件首跑、重复启动如何保持频率。证据：`spec.md:102`、`:103`、`:104`、`:109`。
- [ ] **P1：两条创建路径收敛到同一快照。** Agent按当前working directory解析路径，Host限普通文件/字节并只读一次；Human粘贴走相同content/hash/执行校验。保存验证不信任客户端通过标志，已通过结果要绑定文本/配置/revision，或明确Host保存时重新执行。证据：`spec.md:87`、`:88`、`:229`；`../deepseek-harness/packages/shell/tool-bash/src/index.ts:488`。

### §4.4：输出、去重与pending

- [ ] **P1：写成可独立测试的输出schema。** 明确UTF-8原始字节策略、BOM/CRLF/末尾换行、字段类型、非空/trim、字符计量、unknown keys、重复JSON键、重复id不同payload；超限判失败必须显式检查truncated。证据：`spec.md:113`、`:116`、`:119`；`../deepseek-harness/packages/subprocess/subprocess-local/src/output.ts:305`。
- [ ] **P1：明确所有积压形态和总预算。** pending、定时等待批次、delivery保存的输出、failed delivery分别设条目/字节预算和归属；定义20/min是每订阅还是全Host、窗口和重启后的额度；入队、发布阶段均有幂等检查。证据：`spec.md:105`、`:121`、`:122`。
- [ ] **P1：把暂停行为画成矩阵。** 新触发拒绝、正在运行完成、pending继续发布、等待定时批次继续入队、queued/retrying webhook冻结、manual replay拒绝分别列出。说明delete/archive是终态屏障，而不是单次clear队列。证据：`spec.md:122`。

### §4.5：Webhook ingress

- [ ] **P1：补HTTP与接收协议。** raw body编码/签名字节、header重复和超限、Content-Length/chunked、读取超时/中断、存储5xx、429/Retry-After、全局admission；只在durable commit后202。明确Host admission ID和provider delivery ID不相同。证据：`spec.md:127`、`:130`、`:131`、`:135`、`:144`。
- [ ] **P1：补token完整生命周期。** entropy/生成、只存hash、启用/禁用、reset、archive、在飞行请求、已202请求，以及create/reset commit后响应丢失时的幂等恢复；写反向代理访问日志脱敏要求。证据：`spec.md:127`、`:138`、`:240`；`issues/05-webhook-trigger.md:14`。
- [ ] **P1：补实际装配。** 除公网URL之外说明独立WebServer监听host/port、隔离scope、Team-owned handler如何注入同一个agentTeam、注册与dispose。不要让新入口暴露浏览器API或实例化另一个Team Host。证据：`spec.md:128`；`../deepseek-harness/apps/cli/tests/fixtures/github-webhook/cordis.yml:18`；`../deepseek-harness/packages/host/webserver/src/index.ts:366`。

### §4.6：运行结果、失败与重放

- [ ] **P1：定义success/streak/LAST_SUCCESS_AT的同一语义。** 区分脚本成功、输出接受、全部发布；trial不加不清，resume commit成功才清；skip和queue-blocked不改变streak；webhook耗尽只计一次；给混合通道成功/失败的提交顺序。证据：`spec.md:101`、`:105`、`:150`、`:152`。
- [ ] **P1：补独立failed-delivery查询与replay Interface。** 它不能依赖最近50条run logs仍存在；规定deliveryRef、版本选择、权限、requestId/revision、重复replay和到期淘汰提示。证据：`spec.md:106`、`:192`；`issues/05-webhook-trigger.md:13`。
- [ ] **P1：补outcome与敏感副本策略。** 异常、timeout、abort、nonzero、invalid output、workspace missing、队列/存储失败应结构化；日志字段关联hash/revision/run/delivery。明示raw body、run tails、subprocess spill各自TTL/清理，不能宣称50条日志限制覆盖所有副本。证据：`spec.md:150`、`:151`；`../deepseek-harness/packages/shell/shell/src/types.ts:139`；`../deepseek-harness/packages/subprocess/subprocess-local/src/output.ts:31`。

### §4.7–§4.9：事件呈现、生命周期与权限

- [ ] **P1：固定发布时收件人集合。** 当前owner以发布commit为准，明确加入Human；新owner是否补历史另列；event和markers同一ledger操作；通知失败按未读重派生。所有阅读面保持不可信纯文本规则，标注不等于保证模型免疫提示注入。证据：`spec.md:158`、`:159`、`:160`；`packages/agent-team/src/ledger.ts:2653`、`:5152`。
- [ ] **P1：补所有mutation的版本/幂等表。** create/update/pause/resume/delete/reset/replay/test逐项写expectedRevision、requestId、是否推进revision、许可状态和返回错误；长试运行后重查权限、配额、终态；不给r1迟到run污染r2的机会。证据：`spec.md:76`、`:166`、`:177`、`:183`；`packages/agent-team/src/ledger.ts:5473`。

### §5–§6：工具、guidance、UI

- [ ] **P1：让工具表与承诺一致。** 增加replay或明确其他可调用入口；新增工具同步注册和mandatory-name列表，保持只在team-member挂载；非owner日志授权在Host做，不以UI隐藏代替。证据：`spec.md:192`；`packages/tool-agent-team/src/index.ts:1530`；`packages/agent-team/src/member-runtime.ts:32`；`cordis.patch.yml:183`。
- [ ] **P1/P2：把示例当协议样本。** 至少一个纯interval、一个严格webhook-only、一个双触发样本；包含认证过期、失败退出、稳定事件ID、分页、签名凭据来源、test fixture；不得用test直接exit0伪装完整验证。证据：`spec.md:193`、`:229`。
- [ ] **P1：补最小可运维UI状态。** queued/running/retrying/output-saved/publishing/failed/paused分别能解释；显示当前/上次运行revision、pending/failed数量和下一动作；“暂停仍排空”的文案明确；保留非乐观、键盘/焦点和移动端验收。证据：`spec.md:201`、`:215`；`issues/04-subscriptions-tab.md:9`、`:10`。

### §7–§9：部署、测试与正式文档出口

- [ ] **P1：修正隔离和单Host条款。** 用独立DSH_HOME隔离不兼容开发，不只是不同profile；明确“一home一Host”是部署限制还是被检测执行的保证，并指定排他/拒绝方案或醒目未强制说明。证据：`spec.md:242`、`:244`；`docs/development/environments-and-install.zh.md:83`；`packages/agent-team/src/ledger.ts:6655`。
- [ ] **P1/P2：给长期规模和恢复预算。** 明确无限id/ledger增长的支持范围、启动重放目标、队列磁盘预算、备份恢复流程和告警。若推迟压缩/retention，写明代价，不只写单id长度。证据：`spec.md:243`；`packages/agent-team/src/ledger.ts:2924`。
- [ ] **P1：把缺漏边界分配给具体ticket。** 对照 `04-design-quality.md` 的§4.4/§4.6矩阵，为暂停排空、等待批次、success清零、resume清零、删除保留历史等加明确断言；添加 `05-edge-cases.md` 的durable handoff故障点。证据：`spec.md:248`、`:250`、`:252`；现有03验收为 `issues/03-run-history-and-failures.md:7`。
- [ ] **P1：修复ticket依赖和完成声明。** 05显式依赖03与04，或拆出独立Host子片和UI集成；02若声称独立端到端，就前移最小Human UI与恢复验证。01/02并行时工具数量按实际合并集合更新。证据：`README.md:16`、`:37`；`issues/05-webhook-trigger.md:4`、`:13`、`:15`。
- [ ] **P2：修订materials和状态。** 更新核实commit，纠正gh、jobs、sandbox fallback的泛化说法；将“设计已收敛”改成与已决策程度一致的状态；正式文档出口增加存储/恢复/部署说明，不修改归档史料来冒充当前实现。证据：`README.md:7`；`materials/harness-webhook.md:3`、`:27`、`:48`；`spec.md:256`。

## C. 实施阶段应保留的验收门槛

这些不是本次文档PR已经完成的测试。

1. Host：用假时钟/执行器覆盖状态转换，按提交点注入crash，重放后核对event、baseline、owner markers和未完成obligations。
2. 执行器：真实bash/pwsh验证cwd/root、凭据注入、超时/取消、截断与UTF-8、stderr、shell类型变化和spills；只报告实际验证的平台。
3. 工具/Remote：受限owner、非owner、权限撤销、跨Project ref、旧revision、重复requestId、replay/测试输入。
4. Webhook：202 durable含义、并发quota、raw字节、错误码、token reset、暂停恢复、body中断、429/内部retry以及shutdown。
5. Client：按仓库规则运行适用component检查及 `npm run test:browser`，检查桌面和390×844，验证键盘/焦点、loading/error/empty及普通DSH恢复；Typert从声明生成，不手改生成产物。
6. 产品：保留“Agent owner自行建立GitHub CI订阅并被真实事件唤醒”的最终验收，但不能用单次happy path替代上述durable与权限检查。

依据：`spec.md:248` 至各测试切入点；`README.md:38` 的最终产品验收；`issues/04-subscriptions-tab.md:10` 的浏览器要求；`docs/architecture/client-and-remote.md:6` 的生成路径。

## 合并判断

完成A项并让B中的P1形成明确契约/有主人的实施验收后，可将这份设计作为后续实施的基线合并。P2可以明确延期。最不建议的做法是保持“已收敛”，把权限、存储authority和webhook验证这些架构决定交给实施者在各自ticket里临时选择。
