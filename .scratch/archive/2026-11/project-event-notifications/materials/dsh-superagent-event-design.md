# dsh-superagent 的事件接入设计，以及如何复刻 Holon 式 webhook 订阅

- 对象：`deepseek-ai/dsh-superagent-prototype`，main 分支，`package.json` 版本 0.1.0（DSH bundle）
- 源码位置：本地快照 `/tmp/dsh-super`
- 前置阅读：`docs/001-domain.md`、`docs/002-authorization.md`、`docs/007-architecture.md`、`docs/008-cookbook.md`
- 注意：README 明确说明这是研究原型，不是正式产品，部分设计与配套文章不一致
- 一句话：它不做 webhook 推送，而是把"外部事件"做成可插拔的 Source，用拉取加确定性 ID 去重；推送与拉取的区别被限制在 Source 内部，领域模型不感知传输方式。

## 1. 它解决的是什么问题

Holon 的问题是"外部系统怎么叫醒一个 agent"，答案是 capability URL。dsh-superagent 的问题更靠前一步：**外部事件怎么变成一个被授权的工作单元**。所以它的设计重心不在入站传输，而在事件进入之后的准入与分派。

目标场景也不同：dsh-superagent 是单仓库、单智能体的常驻服务（`deployment.repository` 只有一个），因此不需要为多 agent 设计按人分发的入站令牌。

## 2. 事件流水线

```
                    ┌─────────────── Source（可插拔）───────────────┐
GitHub API ────────>│ 轮询 notifications / issues / comments / CI  │
Feishu 长连接 ─────>│ lark-cli event consume + 历史补收 + 线程轮询 │
                    └───────────────────┬──────────────────────────┘
                                        │ Trigger（不可变、确定性 ID）
                                        ▼
                              ┌──────────────────┐
                              │ Intake           │ 去重 → scope 过滤
                              │ (core/intake.ts) │ → Thread 关联
                              └────────┬─────────┘
                       ┌───────────────┴────────────────┐
                       ▼                                ▼
              已订阅工单的扇出                     Thread 上排队等待 Eval
              （上下文本推送，不授权）              （每线程一次一个）
                       │                                ▼
                       │                        ┌───────────────┐
                       │                        │ Gate 准入     │ 身份 + 是否点名 + 准入表
                       │                        │ Assessment    │ 模型按规则研判
                       │                        └───────┬───────┘
                       │                                ▼
                       │                        Decision：accept / stop / ignore / unavailable
                       │                                ▼
                       └───────────────────────> Ticket + Mandate（授权）
                                                        ▼
                                                Assignment → DSH Session（每工单一个目录）
                                                        ▼
                                                Channel 回写（GitHub 评论 / 飞书话题）
```

对应代码：`src/core/intake.ts:19`、`src/policy.ts:191`、`src/core/engine.ts`、`src/executor/dsh.ts`。

## 3. Source：把"传输"关进插件里

### 3.1 契约

`src/sources/kind.ts:85` 的 `SourceKind` 是一份能力清单，实现哪些方法决定这个 Source 能做什么：

| 成员 | 作用 | 不实现时 |
|---|---|---|
| `kind`、`title`、`description` | 稳定 ID 与面板文案 | 必需 |
| `schema`、`fields` | 配置校验与设置表单 | 必需 |
| `scope(meta, config)` | 这个事件是否在监听范围内、是否"全量接收"、属于准入表的哪一行 | 全部接收，但不参与准入表 |
| `channel.send` / `allowed` / `link` | 回写消息 | 不能回复 |
| `threadContext.read` | 评估时读取上下文消息 | 评估拿不到上下文 |
| `find(query)` | 把 `#12` 这类引用映射到线程 | 无搜索 |
| `policy` | 允许名单、机器人名单、准入表行的定义 | 无独立身份体系 |
| `health` | 健康检查条目名 | 无 |
| `environment` | 注册给执行环境的变量 | 无 |

关键设计：**Source 只负责翻译**。它把 GitHub 的 comment、飞书的 message 翻译成统一的 `Trigger`，其他一切（去重、线程、评估、工单、回复）都由核心处理。

### 3.2 GitHub：轮询加游标

`src/sources/github.ts:127` `watch` 是主循环，每轮 `pollRound`（`:280`）依次做四件事：

1. `pollNotifications`（`:298`）：读智能体账号的 notifications，按 `since` 游标增量拉取
2. `pollRepository`（`:179`）：按开关拉仓库级的 issues / pulls / comments / review-comments 流
3. `pollTicketPulls`：拉打开工单对应 PR 的 CI 状态
4. `pollThreads`：拉已订阅线程的后续讨论

三种游标粒度：

| 位置 | 键 | 作用 |
|---|---|---|
| 通知全局游标 | `github-since` | 下一轮通知的起点 |
| 单 Issue/PR 游标 | `github-cursor:<number>` | 该线程已读到哪里，通知与轮询共用 |
| 每条仓库级流 | `github-stream:<id>` | `{since, started, etag}`，含各类型的启用时间 |

### 3.3 三个去重与追赶技巧

**确定性 Trigger ID。** ID 由来源和原生 ID 派生（`key(...)`），重复读到同一条消息时 `Intake.receive` 返回 `duplicate`，不会产生第二个工单。

**五秒回退。** `src/sources/poll.ts:16`：

```ts
export const cursorAt = (started) => new Date(Date.parse(started) - 5000).toISOString()
```

下一轮从"本轮开始时间减 5 秒"开始读，容忍迟到的远端事件；重叠部分靠确定性 ID 丢弃。这是用幂等换"至少一次"的典型做法，比精确一次便宜得多。

**ETag 协商。** 游标没前进时带 `If-None-Match` 重发上一页，GitHub 返回 304，不消耗限额（`readStream`，`:203`）。

失败处理也有明确边界：

- 单条线程读失败记在该线程的 `pollError` 上，不影响整轮
- 410（已删除）直接丢弃；404 视为可重试（可能是私有仓库权限被撤销）
- 通知重试超过 24 小时自动放弃，避免一条永久读不到的线程把整个 Source 卡在错误状态
- 连续失败达到 `failuresBeforeError` 才报健康异常，单次网络抖动不打扰人

### 3.4 飞书：长连接加历史补收

`src/sources/feishu-loops.ts:70` `consume` 起一个子进程持续消费事件：

```
lark-cli event consume im.message.receive_v1 --as bot
```

- stdout 逐行解析成 Trigger，串行处理（`chain = chain.then(...)`），保证同一条连接内不乱序
- 单事件上限 1 MiB
- 45 秒内没 ready 就判定失败
- 断线重连退避：稳定运行过 1 分钟则 1 秒后重连，否则翻倍，上限 60 秒（`consumerRetry`，`:68`）
- 长连接只是"实时通道"，历史补收由 `backfillChat` 和 `pollThreads` 兜底，二者各用独立的游标和已见消息集合

也就是说，**实时通道和补偿通道分离**，这与 Holon "推送只是提示，真实状态自己拉"的思路一致，只是这里补偿是内置的。

## 4. 准入：两道闸门

这是它与 Holon 最大的不同。Holon 只有一个动作（唤醒），是否继续由 agent 自己判断；dsh-superagent 在事件和工单之间插入了确定性的准入判断。

### 4.1 第一道：Source 的接收范围

`scope` 返回 `{ listened, observed, row, reason }`：

- `listened: false`：事件只入库并标记 `filtered`，不建线程。存下来是为了让面板能解释"为什么没理这条"
- `observed: true`：该范围接收全部消息，未点名的消息才允许进入准入表
- `row`：对应准入表的哪一行（GitHub 是新 Issue / 新 PR / 评论 / 默认分支 CI）

### 4.2 第二道：Gate 与准入表

`src/policy.ts:191` 的 `gate` 按顺序判断：

| 条件 | 结果强度 |
|---|---|
| 允许名单里的人点名了 agent | `explicit` |
| 准入表对应单元格写着 explicit | `explicit` |
| 允许名单里的人在本线程跟帖 | `explicit` |
| 未在名单的人在本线程跟帖，且 accept 模式允许 | `inferred` |
| 准入表写着 inferred，且 accept 模式允许 | `inferred` |
| 其他 | 不接收，记录原因（`not_a_member` / `admission_ignored` / `no_mention`） |

三个单元格（`src/admission.ts`）：

| 单元格 | 含义 | 默认 |
|---|---|---|
| 名单内 + 未点名 | 接收但不点名 | inferred |
| 名单外 + 点名 | 陌生人点名 | ignore |
| 名单外 + 未点名 | 陌生人闲聊 | ignore |

机器人单独处理：只有在 Source 的 bot 名单里，且点名或处于全量接收范围，才能成为 `inferred`，永远不能是 `explicit`。

### 4.3 强度与授权

接受后生成的 `Mandate` 记录：策略版本、范围、强度、命中的规则、发起人身份、接收范围与准入依据（`via`：`addressed` / `followup` / `admission` / `bot`）。

- `explicit` 可以直接接受
- `inferred` 必须走完整评估，且 accept 模式为 `auto`、至少命中一条启用规则
- `observe` 模式下，本应接受的推断结果记录成"would accept"，不真正建单

恢复一个已结束工单前会用 `revalidate` 重新校验 Mandate：策略收紧、发起人移出名单、规则被禁用，都会让旧的授权失效。

### 4.4 策略版本

规则、accept 模式、各 Source 的策略部分共同构成版本号。版本变化时：

- 正在跑的评估作废，触发器重新排队
- 受影响的活跃工单收到一条"策略已变"的输入
- **不会立即撤销已在执行的授权**——避免把半成品工作打断

这条取舍值得记住：Holon 用"撤销 token"处理权限回收（硬切断），这里用"通知加下次恢复时重新校验"（软收敛）。

## 5. 投递与合并

### 5.1 Thread 内串行、批量

- 每个 Thread 同时只跑一个 Eval
- 评估期间到达的触发器进入下一批，不丢弃
- 评估有 deadline：超时后重新排队，连续第三次记为 `unavailable` 并展示给人处理

这和 Holon 的 `wake_hint` 合并是同一种问题的两种答案：

| | Holon | dsh-superagent |
|---|---|---|
| 突发 100 个事件 | 只保留最新一条提示 | 全部保留，合并成一个评估批次 |
| 适合场景 | 事件只是"去看看"的信号 | 每条事件都是需要审计的证据 |
| 代价 | 中间事件不可追溯 | 批次过大时评估质量下降 |

### 5.2 扇出与恢复

`Intake.receive` 在去重和过滤之后：

1. 把触发器写入所有关联 Thread
2. 向已订阅这些 Thread 的工单扇出为 `Input`（纯上下文，不授予任何权限）
3. 如果没有工单"拥有"这条消息，就排进评估队列
4. 唤醒相关工单的执行器

只有人的消息能恢复一个已结束的工单；机器人和 CI 的消息只做上下文，因为执行器恢复时会自己重读线程。

### 5.3 回写

`src/app/outbox.ts` 是唯一的回写出口：

- 每条回复带幂等键（`message.id`），重试不会重复发
- 永久失败（会话已删除、410）返回 `gone`，消息标记为丢弃，不再重试
- 可重试失败按 5 秒起、翻倍到 300 秒退避
- 同一工单同一会话内保序：前一条未失败三次之前，后一条等待

## 6. 与 Holon 的概念映射

| Holon | dsh-superagent | 差异 |
|---|---|---|
| External trigger capability URL | Source 实例配置 | 一个是推送入口，一个是拉取配置 |
| `POST /callbacks/wake/<token>` | 轮询 / 长连接消费 | 推送 vs 拉取 |
| token 哈希、单 agent 一条 ingress | 无 token；单仓库单智能体 | 多租户 vs 单租户 |
| payload 作为提示 | `text` 与 `meta`，明确标注不可信 | 同样不作为授权依据 |
| `wake_hint` 合并 | Thread 评估批量 | 丢弃最新 vs 全部保留 |
| `WaitFor(external)` | Ticket 订阅 + Assignment | 等待 vs 生命周期 |
| `AuthorityClass::IntegrationSignal` | Gate 强度 + Mandate | 标签 vs 可重新校验的授权对象 |
| 停 agent 撤销 trigger | 人工停止撤销 Mandate | 硬撤销 vs 软撤销 |
| 审计事件 | Disposition / Decision / Reason / DomainEvents | 更细，按决策记录 |

一句话总结差异：

- **Holon 把信任成本放在入口**：一个 URL 就是一次唤醒权限，之后交给 agent 判断。
- **dsh-superagent 把信任成本放在判断**：入口只做范围过滤，真正的授权是"谁、在哪、说了什么、命中哪条规则"。

## 7. 如果要在 dsh-superagent 里加 Holon 式推送入站

架构上这是加法而不是改造：新增一个 Source kind，核心管线不动。`docs/008-cookbook.md` 已经给出了完整模板，这里只写推送特有的部分。

值得注意的是，cookbook 里那个示例 kind 就叫 `webhook`，但它读的是一个消息队列（`hookq pull`），本质仍是拉取。这说明作者把"推送"理解为"上游已落地的队列"，而不是由本进程暴露 HTTP 端点。如果需要真正的端点，只能落在 DSH host webserver 这一层。

### 7.1 需要新增的东西

```
DSH host webserver
  POST /webhooks/github
    ├─ 验签：X-Hub-Signature-256 + WEBHOOK_SECRET（常量时间比较）
    ├─ 解析：delivery id、event、action、repository、sender
    ├─ 过滤：仓库不匹配、action 不在白名单 → 200 记录后返回
    └─ ctx.receive(trigger)  ← 同步落库，再返回 202
```

### 7.2 Trigger 映射

| 字段 | 取值 |
|---|---|
| `id` | 复用 `github-trigger.ts` 的构造：Issue/PR 用 `key('github-issue', number)`；评论用 `key('github-comment', html_url, comment.id, updated_at)`；CI 用 `key('github-ci', number, revision)`。`X-GitHub-Delivery` 只作为没有业务对象 ID 的事件兜底 |
| `source` | `'github'` |
| `threads` | `{ source: 'github', id: String(number) }`，默认分支 CI 用 `ci:<branch>`；必须与轮询侧一致才能落到同一线程 |
| `actor` | `sender.login` |
| `human` | `isHumanLogin(user) && !sameName(login, agent)` |
| `addressed` | `mentions(body, agent)` 为真时记 `mention` |
| `channel` | 复用 `githubChannel(number, html_url)` |
| `meta` | `{ number, isPr, kind, commentId }` 等，与轮询侧同构，供 `scope` 与面板使用 |

要点：**ID 必须与轮询侧的内容派生规则一致，而不是用 delivery id。** 同一事件既走 webhook 又走轮询时，`Intake.receive` 的 `duplicate` 会把第二次丢掉，不会重复建单；反过来，如果推送用自己的 delivery id，同一条评论被两条通道各读一次就会生成两个触发器。

### 7.3 需要补的三件事

1. **验签在传输层完成，且不能省略。** 现有 GitHub Source 靠 `gh` 的凭据鉴权，推送入口没有这层保护；签名失败必须在进入 `receive` 之前拒绝，且用常量时间比较。
2. **ack 与落库的顺序。** 先 `receive` 再返回 2xx。如果先 ack 后落库，进程崩溃会丢事件；`receive` 是同步的，正是为这种用法设计的。
3. **scope 必须只依赖 `meta` 和配置。** 授权恢复时会用 `Mandate` 里存的 `meta` 重新调用 `scope`，如果实现里读了外部状态，恢复结果就不可重现。

### 7.4 不需要补的

- 去重：`Intake` 已有
- 合并：Thread 评估批量已有
- 回写：`channel.send` 与 Outbox 已有
- 权限：准入表和 Gate 已有

这就是这套设计最值得借鉴的地方：**传输方式的差异被压缩到一个插件文件里**，其余部分对推送还是拉取完全无感。反过来看 Holon，它把传输能力做成了核心，代价是没有准入、分派、回写这一整套。

## 8. 设计取舍清单

| 决策 | 这里的做法 | 适用条件 |
|---|---|---|
| 订阅模型 | 拉取优先，游标持有在 Source | 远端有可靠的增量接口与稳定 ID |
| 实时性 | 长连接仅作加速，历史补收兜底 | 允许秒级到分钟级延迟 |
| 去重 | 确定性 ID + 重叠窗口 | 事件有稳定原生 ID |
| 合并 | 保留全部，按线程批量评估 | 每条事件都需要审计 |
| 授权 | 确定性 Gate + 模型评估 + Mandate | 需要解释"为什么接这活" |
| 权限回收 | 通知 + 恢复时重新校验 | 不能接受半成品被打断 |
| 回复 | 幂等 outbox，保序，永久失败即丢 | 远端支持幂等键或可加隐藏标记 |
| 失败可见性 | 按 Source / 线程分级，连续失败才报警 | 常驻服务，噪音要低 |

## 9. 参考文件

| 主题 | 路径 |
|---|---|
| 领域概念与规则 | `docs/001-domain.md` |
| 授权与准入 | `docs/002-authorization.md` |
| 架构索引 | `docs/007-architecture.md` |
| 新增 Source 教程 | `docs/008-cookbook.md` |
| Source 契约 | `src/sources/kind.ts:85` |
| GitHub 轮询 | `src/sources/github.ts:127`、`:280` |
| 游标与重叠窗口 | `src/sources/poll.ts:6`、`:16` |
| 飞书长连接 | `src/sources/feishu-loops.ts:70` |
| 去重与扇出 | `src/core/intake.ts:19` |
| 准入判断 | `src/policy.ts:191` |
| 准入矩阵 | `src/admission.ts` |
| 游标键定义 | `src/kv.ts:21` |
| 评估调度 | `src/core/engine.ts:75`、`src/app/passes.ts:22` |
| 回写 | `src/app/outbox.ts` |
