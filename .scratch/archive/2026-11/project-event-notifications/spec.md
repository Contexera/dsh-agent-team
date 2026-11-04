# 决策快照：Member 提醒与 Project 订阅

状态：2026-11-02 获 Human 认可；2026-11-03 按 PR #77 外部架构评审修订（原文见 `materials/pr77-architecture-review.md`，其源码引用已逐条复核）；2026-11-03 讨论收尾并经 Human 确认：确定去重重基线、重放版本与重置地址规则，已接受事件改记入账本，凭据定为全局注册 + 订阅引用。设计收敛，无未决项。本文件是设计快照，不是实现依据；实现以 `packages/` 源码和测试为准。

## 1. 问题

Agent Team 区别于单个 coding session 的地方在于：Project 对应一个领域，Project 的 Agent owner 端到端负责这个领域，应当主动推进工作。目前 Agent 的主动唤醒来源局限于 Task 状态检查与既有执行完成通知（Host 产生的 `review-backlog` / `stalled` 提醒、job 完成通知），缺少两类通用能力：绑定 Member 身份的时间承诺，以及绑定 Project 的外部事实订阅。因此 owner 无法独立推进。

本设计增加两种不依赖 Human 的唤醒来源：

| 来源 | 归属 | 谁能创建 | 送达对象 | 触发条件 |
| --- | --- | --- | --- | --- |
| Member 提醒 | Member | 任何 Agent Member，只能为自己创建 | 创建者本人 | 时间 |
| Project 订阅 | Project | Human 和该 Project 的 Agent owner | 该 Project 的全部 owner | 定时运行脚本，或接收 webhook 后运行脚本 |

- 巡查不是单独的概念，就是 owner 为自己创建的循环提醒。
- 不在本设计范围内：owner 把工作分派给 worker。

## 2. 关键决定

| 决定 | 理由 |
| --- | --- |
| 提醒由 Team 实现，按 memberId 存入 Team 账本，不使用 Harness `dsh-schedule` | `dsh-schedule` 的提醒绑定 Session，Session 停止时提醒也随之停止；Team 会续接、滚动、回收 Member 的 Session（见 `materials/harness-webhook.md`） |
| 订阅 = 触发方式 + 一段脚本；拉取和推送共用同一套模型 | 不需要为每个外部服务写专用代码；脚本内容由 owner 决定，owner 自己选择关注什么 |
| 创建和更新订阅时先试运行一次，通过后才生效；试运行只验证脚本可执行，初始化去重基线是独立动作 | 保证“创建成功就能运行”，也让 Agent 当场得到错误信息；验证与历史水位初始化分离，避免更新时吞掉尚未发布的新事件 |
| 脚本内容以快照形式存入账本，不引用仓库中的文件 | 仓库文件会随分支切换和编辑变化；存快照能保证页面上看到的就是实际运行的内容 |
| Agent owner 创建的订阅立即生效，不需要 Human 确认 | Human 认可（第 3 轮）；同时在 Main stream 记录一条，Human 可以随时暂停或删除 |
| webhook 第一版只用地址中的 token 鉴权 | 与 Slack、Discord 的 incoming webhook 一致，适用于任何服务；需要校验签名时，可以在脚本中完成（见 §4.5） |
| 新增 `team_reminder`、`team_subscription` 两个工具，Team 工具由七个改为九个 | 一个属于 Member，一个属于 Project，分开更容易理解 |
| 两个工具对所有 Member 固定挂载，不随 owner 身份增删；由 Host 按 Project 校验 owner | owner 身份按 Project 区分，按身份增删工具仍需按 Project 校验；与 `team_message start` 的现有做法一致；工具集合变化会使提示缓存失效 |
| Project 无人值守脚本执行是一项新的显式授权，不从“owner 本来就能用 bash”推导 | `capabilities.tools.allow` 可以去掉 Member 的 bash，而 Team 工具强制保留；受限 Member 经订阅获得的是新的执行入口，必须显式承认，并让 Human 的审计面与部署层限制反映这个事实 |
| 订阅在 Project 中有独立的“订阅”标签页 | 需要随时查看运行状态和运行记录 |

## 3. Member 提醒

### 3.1 模型

```
Reminder
  reminderRef     带前缀的品牌化引用
  memberId        创建者，也是唯一的接收者
  schedule        { kind: 'once', at } | { kind: 'every', minutes } | { kind: 'cron', expression }
  note            触发时交给自己的说明，≤ 2000 字
  state           active | done（单次提醒已触发）| cancelled
```

### 3.2 行为

- 触发时，Host 写入一条账本操作，并在该 Member 的 Inbox 中生成一条私有提醒。送达复用现有 Inbox 通知与唤醒通道（`agent.steer`，到达最近的 step 边界）；这是本设计为 Member 提醒选定的策略，与 Task 提醒的消费规则不同。
- 消费：提醒实际进入 Member 的一轮对话（注入上下文）时，由 Host 记录 consumed。进入之前 Host 重启会重新送达（至少送达一次）。每次触发是有独立身份的 occurrence；“单次提醒已触发”与“通知已消费”是两个事实，前者不删除后者的送达义务。Task 提醒依赖显式 Thread 读取消费的机制不适用于 Member 提醒。
- 同一循环提醒上一次触发尚未被消费时，新的触发替换旧的，不叠加。
- cron 按 UTC+8 计算，与 Team 呈现给 Agent 的时间一致（固定时区，无夏令时）。
- 补发：Host 停机或电脑休眠期间错过的触发，恢复后只补发一次。单次提醒在恢复后立即触发。
- 限制：每个 Member 最多 50 个有效提醒；循环提醒的间隔不小于 10 分钟。
- Human 可以在 Member 详情中查看并取消提醒，但不能代替 Agent 创建。

### 3.3 Member 状态变化

| 情况 | 处理 |
| --- | --- |
| Member 暂停（suspended） | 提醒照常计时；触发结果进入 Inbox，Member 恢复后送达 |
| Member 归档或移除 | 其全部提醒取消 |
| Member 正在运行一轮对话 | 与其他 Inbox 通知一样 steer 到最近的 step 边界，不等本轮结束 |
| Member 的 Session 被续接、滚动或回收 | 不受影响，提醒绑定的是 memberId |

## 4. Project 订阅

### 4.1 模型

```
Subscription
  subscriptionRef   带前缀的品牌化引用，与 Task、Thread 引用风格一致
  projectRef
  name              ≤ 80 字
  triggers          { interval?: { minutes }, webhook?: true }，至少一项
  script            { content, sha256, shell: 'bash' | 'pwsh' }
  credentials       [{ ref, env }]，可选，最多 8 项；ref 是 Harness 凭据引用名，env 是注入时的变量名；只存引用，不存值
  revision          每次更新加 1，并发修改需要提交当前 revision；暂停、恢复、重置地址是否推进版本在 §4.8 列出，每次运行固定所使用的 subscriptionRevision 与 scriptHash
  state             active | paused(manual | failures) | deleted
  createdBy
  webhookTokenHash  仅在启用 webhook 时存在
```

账本记录以下操作：创建、更新、暂停、恢复、删除、重置 webhook 地址、去重基线、事件接受、事件发布。每次运行的记录不写入账本（见 §4.6）。已接受但尚未发布的事件内容是账本事实；待发布队列只是发布调度状态，可由接受与发布记录重建（见 §4.4）。

私有存储分四类。只有第一类是 Team 事实；删除其余三类不得改变领域结果：

| 类 | 内容 | 性质 |
| --- | --- | --- |
| 协作事实 | 订阅配置、生命周期、去重基线、已接受/已发布事件、收件人与读取 | 账本权威，重放重新验证 |
| 运行 checkpoint | 投递交接状态、重试与退避、连续失败计数、最后成功时间 | 影响未来行为的 durable 状态，有唯一 schema；不用可淘汰的运行日志重建 |
| 原始入站日志 | webhook 原始请求与接收承诺 | Team 自有 ingress journal，说明恢复与交接规则 |
| 诊断附件 | stdout/stderr、耗时 | 可按保留策略删除 |

### 4.2 创建与存放

1. Agent 在工作目录中编写脚本文件，并用自己的 bash 工具调试。
2. Agent 调用 `team_subscription create`，传入名称、触发方式、脚本路径和可选的 credential 引用列表（ref → env）。路径按 Agent 当前的工作目录解析。Human 在页面上直接粘贴脚本内容，同样可以填写引用列表。Host 校验每个 ref 已配置（未配置则拒绝并列出），env 名合法且不使用 `DSH_TEAM_` 前缀（见 §4.3）。
3. Host 读取文件内容，存为快照，上限 16 KiB。之后修改原文件不会影响订阅，必须调用 `update` 才会生效。
4. Host 用正式运行时的同一套方式试运行一次（见 §4.3）。出现以下任一情况即拒绝：退出码非 0、超时、输出不符合格式。错误连同 stdout、stderr 的末尾内容一起返回。试运行的用途只是验证脚本可执行：webhook-only 订阅没有可构造的正式输入，创建表单与工具必须提供测试 envelope（`DSH_TEAM_TRIGGER=test` 连同样本 header/body），否则该订阅无法创建或恢复。
5. 初始化去重基线是独立动作：创建时默认把试运行输出中的全部 id 写入账本作为基线、不发布为事件，避免第一次正式运行时把已有条目全部推送出来；创建者也可以显式选择“忽略当前历史”。输出 id 是否入基线由这一步决定，与步骤 4 的验证分离。
6. `update` 同样先试运行，但默认保留既有基线，不把试运行输出写入基线——否则两次轮询之间出现的新事件会被静默吞掉。脚本的 id 规则变化后需要重新初始化水位时，使用显式的重新基线动作：只追加要忽略的 id，不替换、不清除既有去重记录；已接受尚未发布的事件继续发布。普通 `update` 不改变去重记录；`test` 样本只用于验证脚本，不计入真实历史（创建时的基线初始化是唯一入口，见步骤 5）。
7. 一个 Project 最多 20 个未删除的订阅。

### 4.3 运行

- 执行器：Harness 的 `ctx.shell`，即当前组合中挂载的 bash 或 pwsh 执行器。快照会记录创建时的 shell 类型；运行时执行器类型不一致，则本次运行失败，并给出明确的错误。
- 工作目录：Project 所属 Workspace 的根目录，由 Host 从可信 Workspace 记录显式传入（不继承进程 cwd）。脚本对 Workspace 的写入范围以 ticket 02 跨平台实测结论为准。
- 权限：Project 无人值守执行是一项新的显式授权（见 §2），不是“Member bash 不提权权限”的等价物。Member bash 按 Session 解析沙箱模式与工作目录，无 Session 调用使用部署默认；`capabilities.tools.allow` 还可以去掉 Member 的 bash 而 Team 工具强制保留。因此 Host 必须从可信的 Workspace 记录构造每次执行的明确策略（sandbox mode 与可写根目录），不继承进程 cwd，也不从 owner 的 Member 配置推导。执行不使用提权模式：提权需要 Human 当场批准，而订阅在无人值守时运行。
- 授权边界：受限 Member（`tools.allow` 不含 bash）经订阅获得的是新的命令执行入口，这是本设计显式承认的新增权限；Main stream 记录每次创建和修改，Human 可随时暂停。该入口无法通过 `tools.allow` 收回（Team 工具强制保留），需要限制时在部署层处理（不挂载 `team-member` preset 或 Host 配置开关）。
- 可写根目录：Harness 公共接口已支持为无 Session 调用指定完整 sandbox policy（`ShellExecRequest.sandboxPolicy`，自 0.2.1-rc.2 起存在），Host 显式传入 Workspace 根目录；未显式指定时的默认回退是 DSH 进程启动目录，本设计不依赖该默认值。ticket 02 已用真实执行器实测（Linux + Landlock，per-call 策略覆盖部署默认、根内可写、根外与 `read-only` 拒绝、cwd 与 env 语义），结论见 `materials/harness-sandbox-executor.md`；macOS / Windows 的真机 enforcement 留待发布前验证。
- 环境变量：与 Member 的 bash 工具相同，由 Harness 子进程服务从 Host 进程环境派生，名称含 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的变量会被清除（名称匹配，仅作用于进程环境；显式传入的 env 在清除之后合并，不受该清除影响，见 Harness `subprocess` 源码）。需要密钥的脚本通过 Host 显式注入：订阅保存 credential reference → env 映射（见 §4.1 `credentials`），Host 每次运行前用 `ctx.credentials.resolve(ref)` 取值注入，显式注入不受清除影响；引用未配置时该次运行明确失败。凭据值由 Human 在 Harness 凭据存储中全局注册（设置界面录入，或环境变量 / `.env` 提供），Team 不另建存储，也不设按 Project 的可用凭据清单：沙箱只约束写入，脚本可直读凭据存储文件，清单不构成安全边界，授权面是 Human 决定注册哪些 secret。映射限制：每个订阅最多 8 项；ref 与 env 都必须是合法环境变量名；env 不得使用 `DSH_TEAM_` 前缀（Host 注入的保留区），同一映射内 ref 与 env 均不得重复。`gh` 的登录状态不能假定：`GH_TOKEN`/`GITHUB_TOKEN` 优先于已存凭据，且默认存于系统 credential store（明文文件是 fallback），keychain、权限和过期都会影响可用性；技能文档要求脚本把认证失败当作显式失败处理，并在目标执行器中实测。
- 信任边界：订阅脚本的权限不等于 Member bash 的权限（见上文“权限”与“授权边界”）：脚本按 Host 构造的明确策略无人值守执行，网络不受限（内置沙箱不限制网络），受限 Member 经订阅获得新的命令执行入口。外部推送方不能修改脚本，只能提供 stdin 中的数据；脚本必须把 stdin 当作不可信数据，不得把其中内容当作命令执行（技能文档写明）。需要更严格隔离（限制环境变量、限制网络）时，应在部署层面换用容器或远程执行器，本设计不单独提供。另外注入 `DSH_TEAM_PROJECT`、`DSH_TEAM_SUBSCRIPTION`、`DSH_TEAM_TRIGGER`（取值 `interval`、`webhook` 或 `test`）、`DSH_TEAM_LAST_SUCCESS_AT`；webhook 运行额外注入 `DSH_TEAM_DELIVERY_ID`（见 §4.5）。
- 限制：单次运行最长 60 秒（`timeoutMs` + kill）；stdout 上限显式设为 65,536 字节（Harness bash-local 默认 64,000，不沿用），超出即判定本次运行失败，且必须检查采集器的 truncated 标志，不能把截断后恰好合法的尾部当作完整输出；同时运行的订阅脚本全局最多 4 个（Team 自有 admission，Harness 不提供）。
- 并发：同一订阅同一时间只运行一个实例（per-subscription 互斥覆盖定时、webhook 和试运行全部入口）。定时触发时，如果上一次还在运行，本次跳过。
- 全局 4 个运行位都被占用时：到期的运行进入一个先进先出的等待队列，有空位后按到期先后执行。同一订阅在等待队列中最多保留一个定时运行，再次到期的合并进去，不叠加。等待不计为失败；等待超过一个间隔的，下次到期时同样合并。Host 重启后等待队列清空，按“错过的运行只补一次”处理。等待队列对所有入口（定时、webhook、试运行）共用同一套公平规则；等待入队或等待发布不占用运行位。
- webhook 投递在返回 202 之前写入 Team 私有存储中的持久队列（不写账本），每个订阅最多排 10 个。202 只在其 durable commit 成功后返回；存储不可用（如磁盘满）返回明确 5xx，不吞异常。投递只在其运行输出已被接受（写入账本，见 §4.1）或确认无需发布后才删除；删除以账本记录和交接 receipt 确认为准，不靠运行日志猜测。Host 重启后继续处理队列中剩余的投递。投递状态机：received → running → accepted，重试与失败投递是其中的转换；一次 run attempt 不是一次投递。
- webhook 投递的脚本运行失败（超时、退出码非 0、输出不合法）时，投递保留在队列中，按 1、5、30 分钟退避重试，共 3 次。仍然失败的投递转为“失败投递”记录，保留请求体和最后一次错误，最多保留 10 条、7 天；owner 在失败投递列表中查看并手动重放（见 §4.6），重放成功后删除。失败投递只对 Human 和 owner 可见，因为请求体可能包含敏感内容。重试中的投递计入每个订阅 10 个的排队上限。一个投递的多次重试只计 1 次连续失败（重试用尽时计入，见 §4.6）；订阅暂停期间，排队和等待重试的投递不运行，恢复后继续（见 §4.4）。
- webhook 运行是“至少执行一次”：同一投递可能因失败重试、手动重放或 Host 在运行中途重启而被执行多次。区分三个身份：Host admission ID（入队时分配，覆盖内部重试与重放，经 `DSH_TEAM_DELIVERY_ID` 传给脚本）、provider delivery ID（如 GitHub `x-github-delivery`，覆盖提供方重投）、领域事件 ID。提供方重投（202 响应丢失）会产生新的 admission，第一版不为外部副作用提供超出契约的保证：脚本只做查询（§5）；需要修改外部状态的脚本必须以 provider delivery ID 或业务幂等键判断，且需受信 provider identity，不能只依赖 Host admission ID。
- 脚本运行成功、输出校验通过后，经过去重的新事件立即作为一次接受写入账本（见 §4.1）；发布只等待额度，不重新运行脚本。只有脚本本身失败（超时、退出码非 0、输出不合法）才会重新运行脚本。重启后依据账本接受记录与交接 receipt 判断进度，不重跑已接受的 attempt。
- 时间：Host 启动后，每个定时订阅的第一次运行在随机延迟（不超过 1 分钟）后开始，避免同时启动；启动只补已到期的运行，不重置持久化的 nextDue 与发布额度。电脑休眠或 Host 停机期间错过的运行，恢复后只补一次。间隔不小于 5 分钟。时间比较用持久化的 UTC 到期目标；时钟回拨不重复触发已记录的发生。

### 4.4 输出契约

stdout 每行一个 JSON 对象，空行忽略：

```
{"id": "必填，订阅内唯一，≤ 200 字", "title": "必填，≤ 200 字", "url": "可选，http(s)", "detail": "可选，≤ 2000 字"}
```

- 输出必须是 UTF-8：按原始字节校验合法性（Harness 返回的是已解码字符串，非法字节会被静默替换，因此 Team 需要自己的字节校验或封装），拒绝 BOM，CRLF 与缺失末尾换行按行切分规则处理。只要有一行不合法，整次运行判定失败，不发布任何事件。重复 JSON 键与重复 id（不同 payload）按确定性规则拒绝；字段按字符计数，unknown key 忽略。
- 去重：按 `(订阅, id)` 去重，依据是账本中已有的去重基线、已接受和已发布的事件。去重范围限定在单个订阅内：两个订阅输出相同的 id，各自都会发布。
- 发布节流：一次运行产出的新事件经过去重后作为一次接受写入账本（见 §4.1），再按发布额度调度：Host 每分钟每个订阅最多发布 20 条（额度按订阅定义，重启不重置）。待发布队列是私有调度状态，可由账本的接受与发布记录重建，不是事实来源。这样 webhook-only 订阅超出 20 条的事件也不会丢。“不丢事件”的承诺从 Host 把输出持久接受进账本开始：脚本自行推进外部游标或消费外部消息的行为不在保证范围内，第一版禁止依赖（需要游标的场景另设 checkpoint 协议，本设计不提供）。已接受未发布的事件每个订阅最多 500 条：单次运行产生超过 500 条新事件时整批不接受，该次运行记为失败并计入 1 次连续失败，错误信息提示缩小输出范围（webhook 投递因此直接转为失败投递记录，由 owner 处理）；单批不超过 500 条、只是现有余量不足时，webhook 投递把已校验事件随投递保存，空间足够后只重试接受，不重跑脚本、不消耗投递重试次数，也不计失败；未发布总量已达到 500 条时，之后到期的定时运行跳过，记为“队列已满，跳过”，不算失败，不改变连续失败计数，直到发布腾出空间。积压总预算（已接受未发布、排队投递、原始请求体）按条目和字节分别设定，单订阅上限不是总上限。对 webhook 运行，输出在接受时即进账本，之后只等待发布额度，不重跑脚本（§4.3），所以已返回 202 的投递不会因队列满而丢失。
- 接受时按 `(订阅, id)` 与账本去重（去重基线 + 已接受/已发布事件）；发布按额度调度，以账本记录判断幂等：账本中已发布即确认，不重发。事件发布与当时全部收件人的 Inbox delta 在同一个账本操作中提交。订阅暂停时，待发布队列中的事件继续发布；已入队、等待重试的 webhook 投递保留但不运行，恢复后继续处理；暂停时正在运行的脚本会运行完，结果照常处理。暂停后新的 webhook 请求返回 409；暂停期间手动重放失败投递同样被拒绝（工具和页面返回订阅已暂停的错误），恢复后才可重放。订阅删除或 Project 归档时，待发布队列和 webhook 投递队列都清空，并构成终态屏障：删除后到达的运行结果、投递不得被接受或发布，已接受未发布的事件不再发布；在飞行请求在 admission、执行、接受、发布各提交点检查终态。
- stderr 只进入运行记录，不影响结果。

### 4.5 webhook 触发

- 启用 webhook 的订阅有独立地址 `<公网地址>/team/hooks/<token>`。token 随机生成，账本只存它的哈希值。完整地址只在创建或重置时返回一次；create/reset 提交后响应丢失时按 requestId 幂等重试，返回已提交对象并说明地址不可再次取回，不得静默新建订阅或存储明文 token。reset 后旧地址立即失效：admission 时重查 token generation 与订阅终态，旧地址新到达的请求按 404 拒绝；已经接受（202、已入队）的投递保留，按原投递继续处理，不因重置地址而丢弃。反向代理访问日志需对路径脱敏。
- 公网地址由 Human 在安装配置中设置。没有配置时，启用 webhook 会被拒绝，并说明原因。本机运行需要隧道或反向代理。入口使用单独的 WebServer，避免把浏览器 API 暴露到公网（Harness webhook 文档的建议）。
- 公网地址变更后，地址中的路径部分仍然有效；外部服务的配置需要相应更新。
- 脚本的 stdin 是一个 JSON 对象：`{"headers": {...}, "body": "<原始请求体>"}`。header 名称一律小写。理由：GitHub 的事件类型（`x-github-event`）、投递 ID 和签名都在请求头中。脚本如果需要校验签名，可以从 Host 显式注入的凭据环境变量读取密钥（见 §4.3 环境变量），自行计算 HMAC；验签使用原始字节（见下）。
- 转发的 header 采用白名单，其余一律丢弃：`content-type`、`user-agent`，以及名称匹配 `x-*-event`、`x-*-delivery`、`x-*-signature*`、`x-*-timestamp` 的 header。这些模式覆盖 GitHub（`x-github-event`、`x-hub-signature-256`）和 GitLab（`x-gitlab-event`）；不符合模式的提供方 header（如 Stripe 的 `stripe-signature`）需要逐个列入。名单之外的凭据类 header（如 `authorization`、`cookie`、`x-api-key`、代理添加的 `x-forwarded-*`）不会进入脚本。单个 header 值最长 1 KiB，超出的拒绝而不是截断（截断会改变验签输入）。白名单在实施时可以按需追加，但必须显式列出。签名字节保持原样：body 以原始字节进入验签路径，不支持的编码（如 gzip）明确拒绝。
- 签名 header 只用于校验，不应输出；技能文档要求脚本不要把 stdin 原样写到 stdout 或 stderr。
- HTTP 响应：

| 情况 | 状态码 |
| --- | --- |
| 已入队 | 202 |
| token 不存在、订阅已删除、Project 已归档 | 404 |
| 订阅已暂停 | 409 |
| 队列已满 | 429 |
| 请求体超过 256 KiB | 413 |
| 不是 POST | 405 |
| 存储不可用（入队失败） | 5xx |

- 202 表示投递已写入持久队列，脚本还没有运行；Host 随后重启也不会丢失这次投递。header、body 读取和总连接有独立 deadline；慢速或中断请求在入队前释放资源，不占队列额度。多个采用自动重试的提供方同时撞满队列时返回 429 并附 `Retry-After`（若提供方支持），内部重试加受控 jitter，避免共振。
- 一个订阅可以同时启用定时和 webhook。webhook 负责及时性，定时运行负责补上 Host 停机期间漏掉的推送。两条通道产生的事件靠 id 去重。
- Agent 拿到地址后，可以自己调用 `gh api` 在 GitHub 上注册 webhook。

### 4.6 运行记录与失败处理

- 每次运行记录：触发方式、开始时间、耗时、退出码或超时、发布事件数、stdout 和 stderr 各自末尾 8 KiB，以及关联身份（subscriptionRevision、scriptHash、deliveryRef/runRef、attempt）和结构化错误类别。每个订阅保留最近 50 条，存放在 Team 私有存储中，不写入账本。Host 重启后仍然保留。subprocess spill 中的完整输出副本有独立生命周期，删除运行记录不代表删除 spill，清理范围在执行器契约中规定。
- 运行输出的可见范围：stdout、stderr 末尾内容只对 Human 和该 Project 的 Agent owner 可见；其他 Project 成员只能看到运行摘要（时间、触发方式、成功或失败、事件数）。原因：脚本继承 Host 环境，输出可能包含凭据或内部信息。Host 不扫描或改写输出内容；防止泄露靠可见范围限制、50 条保留上限、删除订阅时一并删除，以及技能文档要求脚本不输出凭据和原始请求。原始请求体、运行记录尾部、subprocess spill 是不同副本，保留与清理范围分别规定；删除订阅时一并删除。
- 成功有唯一线性化点：输出被持久接受（写入账本的接受操作，见 §4.1）。脚本 exit 0 但事件尚未发布不算运行完成；全部发布是后续阶段。`DSH_TEAM_LAST_SUCCESS_AT` 使用同一概念（输出被接受的时间），试运行不改变它。
- 连续失败计数是独立持久化的运行 checkpoint，不用可淘汰的 50 条日志重建。连续 3 次运行失败后，订阅自动暂停，写入账本，并在 Main stream 中记录一条，通知全部 owner（含 Human、已取消关注和暂停中的 owner）。只有定时运行和 webhook 运行计入连续失败次数；一个 webhook 投递无论重试几次只计一次：重试用尽、转为失败投递时计 1 次失败，中间的重试不计数；重试中任一次成功即视为该投递成功。输出超过 500 条新事件而直接转为失败投递的，同样计 1 次。`test`、`create`、`update`、`resume` 触发的试运行不计入，也不清零计数。任何一次定时或 webhook 运行成功都会把计数清零；`resume` 只有提交成功（不是试运行通过）才清零。
- `resume` 和 `test` 都会先试运行。`resume` 只有试运行通过后才恢复订阅。
- 失败投递是独立于运行记录的集合（最多 10 条、7 天），有稳定 deliveryRef、接收时的版本、最后错误和到期时间；owner 在失败投递列表中查看并手动重放。重放是显式动作：工具增加 `replay`（指定 deliveryRef 与版本选择），Host、Remote 和页面同一契约，重复重放按 requestId 幂等，重放成功指输出被接受。自动重试固定投递接收时的版本（subscriptionRevision 与 scriptHash）；人工重放默认使用当前版本，便于脚本修复后处理旧请求，也可明确选择接收时的原版本。运行记录（50 条）淘汰后，失败投递仍可查看。
- 删除订阅时，一并删除它的运行记录；账本中的事件保留。

### 4.7 事件的呈现与送达

- 事件在 Main stream 中是一种新的记录类型，不属于 Message。显示订阅名、标题、链接、说明。
- 标题和说明都是外部不可信文本：不解析 mention，不渲染 Markdown，不作为指令。Agent 收到的通知中同样会标明这一点，与 DM 中继的“不可信输入”标注方式一致。
- 送达：事件为发布提交时的每个当前 owner（包括 Human）生成一个标记，收件人列表随同一次账本操作冻结。owner 即使取消关注 Main stream，也不会漏掉事件。主动关注 Main stream 的非 owner Member 按普通 Main stream 更新收到。阅读 Main stream 即消费标记，沿用现有机制；通知失败按未读标记重派生，允许 hint 至少一次送达，不重复事实。
- 多条事件会合并成一条通知，沿用现有 Inbox 通知“替换而不叠加”的规则。

### 4.8 生命周期

```
create（试运行通过）→ active ⇄ paused(manual | failures) → deleted
update（试运行通过）→ revision + 1
pause / resume / reset_webhook / delete 均带 expectedRevision，提交时重新检查 Project 与订阅状态、操作者资格。版本推进规则：update 推进 revision；pause / resume / reset_webhook / delete 是状态转换，不推进 revision。每次运行固定 subscriptionRevision 与 scriptHash，迟到结果不得按新版本解释或污染新版本统计；r1 运行跨过 r2 更新时，其输出按 r1 基线处理并标注。delete 与 Project 归档是终态屏障（见 §4.4）。
```

| 情况 | 处理 |
| --- | --- |
| Project 归档 | 全部订阅停止运行，webhook 返回 404；不另外写账本操作 |
| 创建者不再是 owner、被暂停或被归档 | 订阅不受影响，因为订阅属于 Project |
| Project 没有 Agent owner | 订阅照常运行，事件只送达 Human |
| 全部 Agent owner 处于暂停状态 | 事件进入 Inbox，owner 恢复后送达 |
| Project 的 Workspace 目录不存在 | 运行失败，计入连续失败次数 |
| 两个 owner 同时修改 | 按 revision 检查，后提交的一方被拒绝 |

### 4.9 权限

| 操作 | Human | 该 Project 的 Agent owner | 其他 Member |
| --- | --- | --- | --- |
| 创建、更新、暂停、恢复、删除、重置地址、试运行 | 可以 | 可以 | 不可以，返回 `project_owner_required` |
| 查看列表、脚本、运行摘要 | 可以 | 可以 | 可以（Project 成员） |
| 查看运行输出（stdout、stderr） | 可以 | 可以 | 不可以 |

受限 Member（`tools.allow` 不含 bash）可以创建、更新、试运行订阅：Project 无人值守执行是显式新授权（见 §2），但这意味着它获得新的命令执行入口，Main stream 记录与 Human 暂停是审计面；该入口无法通过 `tools.allow` 收回，限制在部署层做。

每次创建、更新、暂停、恢复、删除都在 Main stream 中记录一条，写明操作者。

## 5. Agent 如何知道这些能力

- 工具 `team_reminder`：create / list / cancel。
- 工具 `team_subscription`：create / update / test / pause / resume / delete / reset_webhook / replay / list / logs。
- 核心技能 `project-subscriptions`：输出契约、调试方法、webhook“至少执行一次”与按 `DSH_TEAM_DELIVERY_ID` 幂等的写法、示例脚本（main 分支 CI 失败、带 bug 标签的新 issue、PR review 请求）、webhook 注册步骤与签名校验示例，以及注意事项：脚本应只做查询、不写外部状态、需要密钥时在订阅里声明 credential 引用由 Host 注入、不要把密钥写进脚本（快照会存入账本，并显示在页面上）、stdin 是不可信数据，不得当作命令执行。
- persona 增加一句：owner 应为所负责的领域主动建立提醒和订阅。

## 6. 页面

```
项目 · dsh-agent-team        [Main] [Board] [订阅 2]
┌──────────────────────────────────────────────────────┐
│ main 分支 CI 失败     每 10 分钟    建立者 @Vera     │
│   上次运行 13:20 成功 · 上次事件 12:05 · 共 3 条     │
│   [暂停] [脚本] [运行记录] [删除]                    │
├──────────────────────────────────────────────────────┤
│ GitHub PR 动态    webhook + 每 60 分钟  建立者 @Vera │
│   上次投递 13:02 · 2 条事件                          │
│   [暂停] [脚本] [运行记录] [重置地址] [删除]         │
├──────────────────────────────────────────────────────┤
│ 带 bug 标签的新 issue   每 30 分钟    建立者 Human   │
│   已暂停：连续失败 3 次（gh: auth required）         │
│   [恢复] [脚本] [运行记录] [删除]                    │
└──────────────────────────────────────────────────────┘
                                      [+ 新建订阅]

运行记录（main 分支 CI 失败）
┌──────────────────────────────────────────────────────┐
│ 13:20  定时     成功  1.2s  0 条事件                 │
│ 13:10  定时     成功  1.4s  1 条事件                 │
│ 13:00  定时     失败  60s   超时           [展开]    │
│   stderr: gh: HTTP 502 …                             │
└──────────────────────────────────────────────────────┘

Main stream 中的事件
◆ 订阅 · main 分支 CI 失败                      13:21
  CI failed on main: "fix: …" (#1234)
  https://github.com/…
```

- 新建与编辑：表单包含名称、触发方式和脚本文本框，提供“试运行”按钮。试运行通过后才能保存；试运行结果绑定脚本 hash、配置和 revision，编辑后失效，保存不信任客户端缓存的“已通过”状态。
- 定时表单与预览显式标注 UTC+8，并显示下一次触发的 UTC 时刻与浏览器本地时间（Web Client 按浏览器本地时间呈现）。
- 失败投递列表独立于运行记录，显示 deliveryRef、最后错误、到期时间与重放入口。
- 启用 webhook 或重置地址后，弹窗显示完整地址并提供复制按钮。弹窗关闭后不再显示完整地址。
- 非 owner 只看到只读视图。

## 7. 已知风险与限制

| 问题 | 影响 | 处理 |
| --- | --- | --- |
| 脚本无人值守运行，网络不受限（内置沙箱不限制网络），且对受限 Member 是新的执行入口 | Agent owner 写的脚本可能修改外部状态，或把可读到的本机凭据发到外部；`tools.allow` 去掉 bash 的 Member 也会经订阅获得执行能力 | 技能文档要求只做查询；每次创建和修改都在 Main stream 记录，并显示脚本内容；Human 可以随时暂停；部署层可限制（见 §4.9）；订阅可引用任何已注册凭据，但脚本本就能直读凭据存储文件，注入不扩大读取面 |
| 脚本中写入了密钥 | 密钥以明文存入账本，并显示在页面上 | 技能文档要求通过订阅声明的 credential 引用由 Host 注入，不写入脚本；Host 不做内容扫描 |
| webhook 地址泄露 | 任何人都能触发脚本运行（不能直接写入事件） | 队列上限加去重；可以重置地址；脚本可以校验签名 |
| webhook 完整地址出现在 Agent 的工具结果中 | 地址保存在本地 Session 日志里 | 接受，Session 日志只在本地 |
| 运行时 stdout、stderr 可能含敏感信息 | 写入运行记录 | 只对 Human 和 owner 可见；不进账本，只保留最近 50 条，删除订阅时一并删除；webhook header 采用白名单 |
| 新增的账本操作类型 | 旧版本读取账本时遇到未知操作会直接报错，无法降级（闭合 union 校验或 dispatch 穷尽检查，不保证具体出处） | 与以往新增操作相同；但不同 profile 不隔离账本（共享 `$DSH_HOME/storages/`），预览不兼容版本必须使用独立 `DSH_HOME`：先备份，升级所有共享该存储的 profile，再首次打开 |
| 去重 id 集合不清理 | 长期运行后账本中的 id 持续增加 | 第一版接受；单个 id 不超过 200 字 |
| 同一个 DSH home 同时运行多个 Host 进程 | 定时任务重复执行；两个进程各自维护的账本投影和序号竞争 | “每个 DSH home 一个 Host”是部署约束，不是现有机制强制的保证；禁止共享 home 同时启动两个 Team Host，并提供启动前检查或醒目告警 |

## 8. 测试切入点

- Host：订阅和提醒的各项账本操作及其重放校验；去重与基线（包括两个订阅输出相同 id 时各自发布）；待发布队列的节流、上限与重启恢复；运行位占满时的等待与合并；试运行不计入失败次数；连续失败自动暂停；Project 归档、Member 归档后的停止行为；revision 冲突。使用假的 shell 执行器和假时钟。
- 执行器：用真实 bash 脚本验证超时、输出超限、非法输出、stdin envelope、环境变量注入（名称含 `TOKEN` 等的变量不出现）、shell 类型不一致。
- 定时运行：一次运行的新事件会使未发布总量超过 500 条时整批不接受、计 1 次连续失败；未发布总量已达上限时后续定时运行记为跳过、不计入连续失败；接受即入账本，发布只等额度，脚本不被再次运行。
- webhook：单次超过 500 条新事件的投递直接转为失败投递、计 1 次连续失败；暂停期间手动重放被拒绝。
- webhook：§4.5 表中的各个状态码；token 只存哈希；返回 202 后重启 Host，投递仍会被处理；脚本失败后投递按退避重试，重试成功后删除，重试用尽后进入失败投递记录并可手动重放；重试与重放时 `DSH_TEAM_DELIVERY_ID` 不变；一个投递重试用尽只计 1 次连续失败；订阅暂停时排队与重试中的投递不运行、恢复后继续；未发布总量达上限时只等待发布额度、脚本运行次数不增加；只有白名单中的 header 进入 stdin。
- 工具：权限拒绝返回 `project_owner_required`；非 owner 读取运行记录时不含 stdout、stderr；按路径读取脚本；试运行失败时的错误内容；失败投递的 replay 契约（requestId 幂等、版本选择、暂停拒绝）。
- 崩溃交接：在 durable admission、接受、发布各提交点注入崩溃，验证重放不重发、不漏标记、终态不复活；r1 运行跨过 update/delete/archive 时，迟到结果不复活终态、不污染新版本统计。
- 浏览器：订阅标签页的空状态、列表、运行记录、暂停与恢复、新建表单与试运行、webhook 地址弹窗，桌面和 390×844 两种尺寸。

## 9. 正式文档出口

- 领域词汇（Reminder、Subscription、Project 事件）→ `docs/domain-model.md`
- 送达规则 → `docs/team-collaboration/attention-and-messaging.md`
- 两个新工具 → `docs/team-collaboration/tools.md`、`docs/architecture/tools-and-preset.md`（“七个工具”改为“九个”）
- Host 调度、执行与 webhook 入口 → `docs/architecture/host-authority.md`
- 私有存储分层、崩溃恢复与部署约束（独立 `DSH_HOME`、单 Host）→ `docs/architecture/host-authority.md` 与安装文档
- 订阅标签页 → `docs/frontend-design/components.md`
