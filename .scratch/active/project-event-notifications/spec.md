# 决策快照：Member 提醒与 Project 订阅

状态：已获 Human 认可（2026-11-02）。本文件是设计快照，不是实现依据；实现以 `packages/` 源码和测试为准。

## 1. 问题

Agent Team 区别于单个 coding session 的地方在于：Project 对应一个领域，Project 的 Agent owner 端到端负责这个领域，应当主动推进工作。目前 Agent 只会被 Human 或其他 Member 的消息唤醒，所以 owner 无法独立推进。

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
| 创建和更新订阅时先试运行一次，通过后才生效 | 保证“创建成功就能运行”，也让 Agent 当场得到错误信息 |
| 脚本内容以快照形式存入账本，不引用仓库中的文件 | 仓库文件会随分支切换和编辑变化；存快照能保证页面上看到的就是实际运行的内容 |
| Agent owner 创建的订阅立即生效，不需要 Human 确认 | Human 认可（第 3 轮）；同时在 Main stream 记录一条，Human 可以随时暂停或删除 |
| webhook 第一版只用地址中的 token 鉴权 | 与 Slack、Discord 的 incoming webhook 一致，适用于任何服务；需要校验签名时，可以在脚本中完成（见 §4.5） |
| 新增 `team_reminder`、`team_subscription` 两个工具，Team 工具由七个改为九个 | 一个属于 Member，一个属于 Project，分开更容易理解 |
| 两个工具对所有 Member 固定挂载，不随 owner 身份增删；由 Host 按 Project 校验 owner | owner 身份按 Project 区分，按身份增删工具仍需按 Project 校验；与 `team_message start` 的现有做法一致；工具集合变化会使提示缓存失效 |
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

- 触发时，Host 写入一条账本操作，并在该 Member 的 Inbox 中生成一条私有提醒，送达方式与现有的 Task 提醒（`review-backlog`、`stalled`）一致。
- 消费：提醒随通知进入 Member 的一轮对话后即视为已读，由 Host 记录。如果在进入对话之前 Host 重启，会重新送达（至少送达一次）。
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
| Member 正在运行一轮对话 | 与其他通知一样，在本轮结束后送达 |
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
  revision          每次更新加 1，并发修改需要提交当前 revision
  state             active | paused(manual | failures) | deleted
  createdBy
  webhookTokenHash  仅在启用 webhook 时存在
```

账本记录以下操作：创建、更新、暂停、恢复、删除、重置 webhook 地址、去重基线、事件发布。每次运行的记录不写入账本（见 §4.6）。

### 4.2 创建与存放

1. Agent 在工作目录中编写脚本文件，并用自己的 bash 工具调试。
2. Agent 调用 `team_subscription create`，传入名称、触发方式和脚本路径。路径按 Agent 当前的工作目录解析。Human 在页面上直接粘贴脚本内容。
3. Host 读取文件内容，存为快照，上限 16 KiB。之后修改原文件不会影响订阅，必须调用 `update` 才会生效。
4. Host 用正式运行时的同一套方式试运行一次（见 §4.3）。出现以下任一情况即拒绝：退出码非 0、超时、输出不符合格式。错误连同 stdout、stderr 的末尾内容一起返回。
5. 试运行通过后，输出中的全部 id 写入账本，作为去重基线，但不发布为事件。这样可以避免第一次正式运行时把已有的条目全部推送出来。
6. `update` 同样先试运行，再重新写入去重基线。脚本的 id 规则变化后，也不会把旧条目重新推送一遍。
7. 一个 Project 最多 20 个未删除的订阅。

### 4.3 运行

- 执行器：Harness 的 `ctx.shell`，即当前组合中挂载的 bash 或 pwsh 执行器。快照会记录创建时的 shell 类型；运行时执行器类型不一致，则本次运行失败，并给出明确的错误。
- 工作目录：Project 所属 Workspace 的根目录。可写范围取决于下面“待实施时验证”一条的结果，ticket 02 完成验证前不承诺脚本能写入 Workspace。
- 权限：使用部署默认的沙箱模式，不能提权。原因是提权需要 Human 当场批准，而订阅在无人值守时运行。因此，脚本的权限不超过 Member bash 工具在不提权时的权限。
- 待实施时验证：Host 调用不属于任何 Session 时，Harness 沙箱策略的可写根目录会退回 DSH 进程的启动目录，而不是 Project 的 Workspace（来源：Harness `sandbox-policy` README）。ticket 02 需要验证能否为这类调用指定 Workspace 根目录。如果不能，脚本对 Workspace 只有读权限；`gh` 等工具写缓存失败时，需要在技能文档中说明处理方式。
- 环境变量：与 Member 的 bash 工具相同，由 Harness 子进程服务从 Host 进程环境派生，名称含 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的变量会被清除（名称匹配，见 Harness `subprocess` README）。`gh` 的登录信息保存在用户配置文件中，不在环境变量里，所以本机的 `gh` 登录状态可以直接使用。
- 信任边界：订阅脚本的权限等于 Agent owner 自己 bash 工具在不提权时的权限，包括同样的文件读取范围、`gh` 登录状态和不受限制的网络访问（Harness 沙箱只限制文件写入，不限制网络）。Agent owner 本来就能用 bash 执行任意命令，所以订阅不会给它新的凭据或权限，增加的只是“无人值守、定时或被外部触发”这一点。外部推送方不能修改脚本，只能提供 stdin 中的数据；脚本必须把 stdin 当作不可信数据，不得把其中内容当作命令执行（技能文档写明）。需要更严格隔离（限制环境变量、限制网络）时，应在部署层面换用容器或远程执行器，本设计不单独提供。另外注入 `DSH_TEAM_PROJECT`、`DSH_TEAM_SUBSCRIPTION`、`DSH_TEAM_TRIGGER`（取值 `interval`、`webhook` 或 `test`）、`DSH_TEAM_LAST_SUCCESS_AT`；webhook 运行额外注入 `DSH_TEAM_DELIVERY_ID`（见 §4.5）。
- 限制：单次运行最长 60 秒；stdout 上限 64 KiB，超出即判定本次运行失败；同时运行的订阅脚本全局最多 4 个。
- 并发：同一订阅同一时间只运行一个实例。定时触发时，如果上一次还在运行，本次跳过。
- 全局 4 个运行位都被占用时：到期的运行进入一个先进先出的等待队列，有空位后按到期先后执行。同一订阅在等待队列中最多保留一个定时运行，再次到期的合并进去，不叠加。等待不计为失败；等待超过一个间隔的，下次到期时同样合并。Host 重启后等待队列清空，按“错过的运行只补一次”处理。
- webhook 投递在返回 202 之前写入 Team 私有存储中的持久队列（不写账本），每个订阅最多排 10 个。投递只在其运行成功、全部新事件已进入待发布队列后才删除。Host 重启后继续处理队列中剩余的投递。
- webhook 投递的脚本运行失败（超时、退出码非 0、输出不合法）时，投递保留在队列中，按 1、5、30 分钟退避重试，共 3 次。仍然失败的投递转为“失败投递”记录，保留请求体和最后一次错误，最多保留 10 条、7 天；owner 可以在运行记录中查看并手动重放，重放成功后删除。失败投递只对 Human 和 owner 可见，因为请求体可能包含敏感内容。重试中的投递计入每个订阅 10 个的排队上限。
- webhook 运行是“至少执行一次”：同一投递可能因失败重试、手动重放或 Host 在运行中途重启而被执行多次。每个投递在入队时由 Host 分配一个稳定的投递 ID，通过 `DSH_TEAM_DELIVERY_ID` 传给脚本，重试和重放时保持不变。订阅脚本应当只做查询（§5）；确实需要修改外部状态的脚本，必须以投递 ID 做幂等判断，避免重复执行造成重复修改。
- 脚本运行成功、输出校验通过，但新事件因待发布队列空间不足而无法入队时，Host 把已校验的事件与该投递一起持久保存，之后只重试入队，不重新运行脚本。只有脚本本身失败（超时、退出码非 0、输出不合法）才会重新运行脚本。
- 时间：Host 启动后，每个定时订阅的第一次运行在随机延迟（不超过 1 分钟）后开始，避免同时启动。电脑休眠或 Host 停机期间错过的运行，恢复后只补一次。间隔不小于 5 分钟。

### 4.4 输出契约

stdout 每行一个 JSON 对象，空行忽略：

```
{"id": "必填，订阅内唯一，≤ 200 字", "title": "必填，≤ 200 字", "url": "可选，http(s)", "detail": "可选，≤ 2000 字"}
```

- 输出必须是 UTF-8。只要有一行不合法，整次运行判定失败，不发布任何事件。
- 去重：按 `(订阅, id)` 去重，依据是账本中已有的去重基线和已发布的事件。去重范围限定在单个订阅内：两个订阅输出相同的 id，各自都会发布。
- 发布节流：一次运行产生的新事件全部进入该订阅的持久待发布队列（Team 私有存储，不写账本），Host 每分钟最多从中发布 20 条。这样 webhook-only 订阅超出 20 条的事件也不会丢。待发布队列上限 500 条；一次运行的新事件放不进队列剩余空间时，不入队任何事件。对定时运行，这种情况记为“队列已满，跳过”，不算失败，不改变连续失败计数；因为定时脚本每次都会重新查询，这些事件会在之后的运行中再次出现。单次定时运行输出超过 500 条新事件的，队列空了也放不下，记为失败并计入连续失败次数，错误信息提示缩小输出范围。对 webhook 运行，已校验的事件随投递持久保存，等队列被消耗、空间足够后只重试入队，不重跑脚本（§4.3），所以已返回 202 的投递不会因队列满而丢失。单次运行输出超过 500 条新事件的，队列空了也放不下，直接转为失败投递记录，由 owner 处理（例如修改脚本缩小输出）。
- 入队前按 `(订阅, id)` 与账本和待发布队列去重。订阅暂停时，待发布队列中的事件继续发布；已入队、等待重试的 webhook 投递保留但不运行，恢复后继续处理；暂停时正在运行的脚本会运行完，结果照常处理。暂停后新的 webhook 请求返回 409。订阅删除或 Project 归档时，待发布队列和 webhook 投递队列都清空。
- stderr 只进入运行记录，不影响结果。

### 4.5 webhook 触发

- 启用 webhook 的订阅有独立地址 `<公网地址>/team/hooks/<token>`。token 随机生成，账本只存它的哈希值。完整地址只在创建或重置时返回一次。
- 公网地址由 Human 在安装配置中设置。没有配置时，启用 webhook 会被拒绝，并说明原因。本机运行需要隧道或反向代理。入口使用单独的 WebServer，避免把浏览器 API 暴露到公网（Harness webhook 文档的建议）。
- 公网地址变更后，地址中的路径部分仍然有效；外部服务的配置需要相应更新。
- 脚本的 stdin 是一个 JSON 对象：`{"headers": {...}, "body": "<原始请求体>"}`。header 名称一律小写。理由：GitHub 的事件类型（`x-github-event`）、投递 ID 和签名都在请求头中。脚本如果需要校验签名，可以从环境变量读取密钥，自行计算 HMAC。
- 转发的 header 采用白名单，其余一律丢弃：`content-type`、`user-agent`，以及名称匹配 `x-*-event`、`x-*-delivery`、`x-*-signature*`、`x-*-timestamp` 的 header。这些模式覆盖 GitHub（`x-github-event`、`x-hub-signature-256`）和 GitLab（`x-gitlab-event`）；不符合模式的提供方 header（如 Stripe 的 `stripe-signature`）需要逐个列入。名单之外的凭据类 header（如 `authorization`、`cookie`、`x-api-key`、代理添加的 `x-forwarded-*`）不会进入脚本。单个 header 值最长 1 KiB，超出的截断。白名单在实施时可以按需追加，但必须显式列出。
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

- 202 表示投递已写入持久队列，脚本还没有运行；Host 随后重启也不会丢失这次投递。
- 一个订阅可以同时启用定时和 webhook。webhook 负责及时性，定时运行负责补上 Host 停机期间漏掉的推送。两条通道产生的事件靠 id 去重。
- Agent 拿到地址后，可以自己调用 `gh api` 在 GitHub 上注册 webhook。

### 4.6 运行记录与失败处理

- 每次运行记录：触发方式、开始时间、耗时、退出码或超时、发布事件数、stdout 和 stderr 各自末尾 8 KiB。每个订阅保留最近 50 条，存放在 Team 私有存储中，不写入账本。Host 重启后仍然保留。
- 运行输出的可见范围：stdout、stderr 末尾内容只对 Human 和该 Project 的 Agent owner 可见；其他 Project 成员只能看到运行摘要（时间、触发方式、成功或失败、事件数）。原因：脚本继承 Host 环境，输出可能包含凭据或内部信息。Host 不扫描或改写输出内容；防止泄露靠可见范围限制、50 条保留上限、删除订阅时一并删除，以及技能文档要求脚本不输出凭据和原始请求。
- 连续 3 次运行失败后，订阅自动暂停，写入账本，并在 Main stream 中记录一条，通知全部 owner。只有定时运行和 webhook 运行计入连续失败次数；一个 webhook 投递无论重试几次只计一次：重试用尽、转为失败投递时计 1 次失败，中间的重试不计数；重试中任一次成功即视为该投递成功。`test`、`create`、`update`、`resume` 触发的试运行不计入，也不清零计数。任何一次定时或 webhook 运行成功都会把计数清零；`resume` 成功后计数清零。
- `resume` 和 `test` 都会先试运行。`resume` 只有试运行通过后才恢复订阅。
- 删除订阅时，一并删除它的运行记录；账本中的事件保留。

### 4.7 事件的呈现与送达

- 事件在 Main stream 中是一种新的记录类型，不属于 Message。显示订阅名、标题、链接、说明。
- 标题和说明都是外部不可信文本：不解析 mention，不渲染 Markdown，不作为指令。Agent 收到的通知中同样会标明这一点，与 DM 中继的“不可信输入”标注方式一致。
- 送达：事件为每个当前 owner（包括 Human）生成一个标记。owner 即使取消关注 Main stream，也不会漏掉事件。主动关注 Main stream 的非 owner Member 按普通 Main stream 更新收到。阅读 Main stream 即消费标记，沿用现有机制。
- 多条事件会合并成一条通知，沿用现有 Inbox 通知“替换而不叠加”的规则。

### 4.8 生命周期

```
create（试运行通过）→ active ⇄ paused(manual | failures) → deleted
update（试运行通过）→ revision + 1
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

每次创建、更新、暂停、恢复、删除都在 Main stream 中记录一条，写明操作者。

## 5. Agent 如何知道这些能力

- 工具 `team_reminder`：create / list / cancel。
- 工具 `team_subscription`：create / update / test / pause / resume / delete / reset_webhook / list / logs。
- 核心技能 `project-subscriptions`：输出契约、调试方法、webhook“至少执行一次”与按 `DSH_TEAM_DELIVERY_ID` 幂等的写法、示例脚本（main 分支 CI 失败、带 bug 标签的新 issue、PR review 请求）、webhook 注册步骤与签名校验示例，以及注意事项：脚本应只做查询、不写外部状态、不要把密钥写进脚本（快照会存入账本，并显示在页面上）、stdin 是不可信数据，不得当作命令执行。
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

- 新建与编辑：表单包含名称、触发方式和脚本文本框，提供“试运行”按钮。试运行通过后才能保存。
- 启用 webhook 或重置地址后，弹窗显示完整地址并提供复制按钮。弹窗关闭后不再显示完整地址。
- 非 owner 只看到只读视图。

## 7. 已知风险与限制

| 问题 | 影响 | 处理 |
| --- | --- | --- |
| 脚本无人值守运行，权限与 Member bash 不提权时相同，网络不受限 | Agent owner 写的脚本可能修改外部状态，或把可读到的本机凭据（如 `gh` 配置文件）发到外部；这与 Agent owner 用 bash 工具能做到的范围相同 | 技能文档要求只做查询；每次创建和修改都在 Main stream 记录，并显示脚本内容；Human 可以随时暂停 |
| 脚本中写入了密钥 | 密钥以明文存入账本，并显示在页面上 | 技能文档要求通过环境变量或 `gh` 登录状态取得凭据；Host 不做内容扫描 |
| webhook 地址泄露 | 任何人都能触发脚本运行（不能直接写入事件） | 队列上限加去重；可以重置地址；脚本可以校验签名 |
| webhook 完整地址出现在 Agent 的工具结果中 | 地址保存在本地 Session 日志里 | 接受，Session 日志只在本地 |
| 运行时 stdout、stderr 可能含敏感信息 | 写入运行记录 | 只对 Human 和 owner 可见；不进账本，只保留最近 50 条，删除订阅时一并删除；webhook header 采用白名单 |
| 新增的账本操作类型 | 旧版本读取账本时遇到未知操作会直接报错（`assertUnhandledKind`），无法降级 | 与以往新增操作相同；开发和日常使用应分别使用不同的 profile |
| 去重 id 集合不清理 | 长期运行后账本中的 id 持续增加 | 第一版接受；单个 id 不超过 200 字 |
| 同一个 DSH home 同时运行多个 Host 进程 | 定时任务会重复执行 | 不支持，沿用“每个 DSH home 一个 Host”的现有前提 |

## 8. 测试切入点

- Host：订阅和提醒的各项账本操作及其重放校验；去重与基线（包括两个订阅输出相同 id 时各自发布）；待发布队列的节流、上限与重启恢复；运行位占满时的等待与合并；试运行不计入失败次数；连续失败自动暂停；Project 归档、Member 归档后的停止行为；revision 冲突。使用假的 shell 执行器和假时钟。
- 执行器：用真实 bash 脚本验证超时、输出超限、非法输出、stdin envelope、环境变量注入（名称含 `TOKEN` 等的变量不出现）、shell 类型不一致。
- 定时运行：待发布队列已满时记为跳过、不计入连续失败；单次超过 500 条新事件记为失败。
- webhook：§4.5 表中的各个状态码；token 只存哈希；返回 202 后重启 Host，投递仍会被处理；脚本失败后投递按退避重试，重试成功后删除，重试用尽后进入失败投递记录并可手动重放；重试与重放时 `DSH_TEAM_DELIVERY_ID` 不变；一个投递重试用尽只计 1 次连续失败；订阅暂停时排队与重试中的投递不运行、恢复后继续；待发布队列满时只重试入队、脚本运行次数不增加；只有白名单中的 header 进入 stdin。
- 工具：权限拒绝返回 `project_owner_required`；非 owner 读取运行记录时不含 stdout、stderr；按路径读取脚本；试运行失败时的错误内容。
- 浏览器：订阅标签页的空状态、列表、运行记录、暂停与恢复、新建表单与试运行、webhook 地址弹窗，桌面和 390×844 两种尺寸。

## 9. 正式文档出口

- 领域词汇（Reminder、Subscription、Project 事件）→ `docs/domain-model.md`
- 送达规则 → `docs/team-collaboration/attention-and-messaging.md`
- 两个新工具 → `docs/team-collaboration/tools.md`、`docs/architecture/tools-and-preset.md`（“七个工具”改为“九个”）
- Host 调度、执行与 webhook 入口 → `docs/architecture/host-authority.md`
- 订阅标签页 → `docs/frontend-design/components.md`
