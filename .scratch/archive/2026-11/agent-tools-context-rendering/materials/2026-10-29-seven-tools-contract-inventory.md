# 七工具契约清单与 Q3 证据（2026-10-29）

核对版本：master `3d16926`。本文补上 SCOPE「只读审查清单」的主项：七个 Team 工具逐一对照 schema → execute → structured result → render → tests → maintained docs。读法：源码（`packages/tool-agent-team/src/index.ts` 全文 1,358 行、`host-access.ts`、`main-stream.ts`；`packages/agent-team/src/index.ts` 的 `*ForAgent` 包装层与 `ledger.ts` 的写门/读页）、测试（tool 包 6 个 spec + Host 包相关 spec）、正式文档（`docs/team-collaboration/tools.*`、`boundaries.*`、两个 package README、persona、core skill）。行号按上述版本；后续以函数级锚点为准。

度量数字的口径订正（Vera 2026-10-29）：提案 §1.0 的 33.7K 是 **Team 自有文本**（persona 15.0K + 七个工具 schema 18.7K）；按一个成员会话实测，每步固定文本还含 system 部分，合计约 38.9K（system 19.5K + schema 19.4K），叫「每步固定文本」时 33.7K 偏低约 15%。不影响排序，两张表都注明口径。

## 0. 总表

| 工具 | 参数（默认/Workspace 推断） | execute → Host | structured result | render 形状 | 拒绝/抛错 | 测试 | 正式文档 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `team_view` | `projectRef`/`limit`/`cursor`/`workspace`；`limit` 默认 20（Host 校验 1–100）；Workspace 省略时仅唯一参与可推断 | `viewForAgent`（`index.ts:2021`）→ `view` | projects(+owners/role)、workspaces、members、threads、tasks、cursor/hasMore/page | 地址簿三段 + Thread 分页页脚；续页只渲染 Threads | 抛错：`workspace_required/ambiguous/not_participating`、未知 projectRef | `team-tools-render.spec.ts:11-97` | `tools.md:7`、`tools.zh.md` |
| `team_inbox` | `limit`/`workspace`；`limit` 默认 **50**（Host 校验 1–100，render 提示「up to 100 rows」） | `inboxForAgent`（`index.ts:1820`）→ `inbox`/`memberInbox` | totalUnread/totalDirect、hasMore、items（threadRef/projectRef/task 站立/reminders）、main 行 | 总计行 + main 行 + Thread 行 + 读取路由；无正文无 token | 抛错：workspace 三态 | `team-tools-render.spec.ts:145-202` | `tools.md:17` |
| `team_attention` | `action`(status/follow/unfollow, required)、threadRef/taskRef/projectRef 三选一、`workspace` | `changeAttentionForAgent`/`attentionStatusForAgent`/`mainAttentionStatusForAgent`（`index.ts:1756-1775`） | workspaceId/projectRef/kind/scope/following/source(+Task 站立) | 一行 Attention 结果 + 后果句 + 原因短语（`CAUSE_OF_SOURCE`） | 抛错：`missing_thread_identity`、`main_stream_addressing` | `team-tools-render.spec.ts:203-262` | `tools.md:59` |
| `team_thread` | `action`(read/history/message, required)、threadRef/projectRef/taskRef/messageRef/beforeSequence/limit/`workspace`；history 的 `limit` 默认 20（1–100）；**read 的批次由 Host 固定 20，参数被忽略** | `readThreadForAgent`/`threadHistoryForAgent`/`readMessageForAgent`/`mainStreamHistoryForAgent`/`readMainStreamForAgent`（`index.ts:1735-1969`） | 读：anchor/claims/facts/taskCards/reminders/readThrough/remaining/earlier/task 站立/following；message：单条 Message；history：cursor/hasMore | read：结果→身份→导向→Claims→facts→水位→token；history：导向+facts+游标；message：逐字 | 抛错：`missing_thread_identity`、`main_stream_addressing`、`action_only_arguments`(messageRef)、`history_only_arguments`、`missing_message_ref`、message_read_* | `team-thread-render.spec.ts`、`team-thread-task-cards.spec.ts`、`team-tools-render.spec.ts:263-412` | `tools.md:23` |
| `team_dm` | `memberRef`/`body`(均 required)/`workspace`；** stray 参数整体拒绝**（手写守卫，因参数表编译后无 `additionalProperties`） | `dmForAgent`（`index.ts:1928`） | kind/recipientMemberId/recipientHandle/delivered/deliveryNote/occurredAt | Delivered 一行；或 Recorded-not-delivered 三行（原因 + 勿盲重发） | 抛错：stray 参数（手写）、`dm_requires_member`、空 body（手写）；投递失败转 `delivered:false` 结果 | `team-tools-render.spec.ts:468-492` | `tools.md:89` |
| `team_message` | `action`(start/reply/post, required)、projectRef/kind/accountable/sourceThreadRefs/threadRef/taskRef/replyToMessageRef/`body`(required)/baseRevision/attachments/`workspace` | `startThreadForAgent`/`replyForAgent`/`postMainMessageForAgent`（`index.ts:1725-1750`） | committed：refs + revision + source/undeliveredMentions；拒绝：unread_required/stale_revision(+facts)；post 拒绝：main_unread_required(+entries) | committed 动词句 + 身份行 + token；拒绝走共享 `rejectionLines`；`presentationMeta` 只投影 kind/threadRef/taskRef | 类型拒绝：unread_required、stale_revision、main_unread_required；抛错：post/start 的 project 形状、reply 的 token 缺失、`action_only_arguments`、asTask、附件路径 | `team-tools-render.spec.ts:413-544`、`team-rejection-payload.spec.ts` | `tools.md:67-77` |
| `team_task` | `action`(board/list/claim/done/release/promote/accept/close/reopen/transfer, required)、projectRef/mine/threadRef/taskRef/baseRevision/direction/claimRef/accountable/target/`workspace` | `taskBoardForAgent`/`listClaimsForAgent`/`changeClaimForAgent`/`promoteThreadForAgent`/`changeTaskForAgent`/`transferTaskForAgent`（`index.ts:1777-1813`） | board：open/finished/finishedTruncated；listed：claims；committed：claim/task/standing/revision；拒绝：unread_required/stale_revision | board 分栏 + finished 截断结论；claim 先行；resolutions/transfer 各自动词句；拒绝共享 `rejectionLines` | 类型拒绝：unread_required、stale_revision；抛错：每 action 的参数形状（`action_only_arguments` 等十余种）、`self_acceptance_forbidden`/`accountable_owner_required`（附 Task 当前状态） | `team-task-actions.spec.ts`、`team-tools-render.spec.ts:545-697` | `tools.md:107-117` |

跨包边界：工具包只做参数规整、Host 调用、结果投影与 render；领域判定（谁可以写、未读门、revision 门、Task 权威）全在 `packages/agent-team`。`blank-parameter-tolerance.spec.ts` 锁「模型把可选槽填成空串/0/false」的三种观测失败环（空地址 23 次、reply 带 stray projectRef 7 次、空 body 报错形状）。

## 1. 共享 helper 与私有 renderer 的真实边界（SCOPE 清单第 2 条）

**共享（tool 包内，单一权威）**：`rejectionLines`+`rejectedFactLines`（两个写工具的类型拒绝，`index.ts:243-284`）、`nextWriteLine`（token 交接唯一句式，`:131`）、`taskStanding`（Task 站立，`:136`）、`boundedSubject`+`SUBJECT_BOUND=80`（有界主题，`:28/:105`）、`factLine`/`activityLine`/`factMarkers`（事实行，`:738`/`:119`/`:111`）、`factTimelineLines`+`taskCardLine`（事实与卡片混排，`:177`/`:172`）、`readFactView`（read 与拒绝共用同一投影，`:723`）、`claimView`/`claimLine`（`:79`/`:746`）、`repliesToClause`（`:715`）、`blankToAbsent`+`OPTIONAL_ADDRESS_KEYS`（`:207`/`:217`）、`requestId`（`:195`）、`main-stream.ts` 全组（Main 条目 schema/view/line）。

**私有（每工具一个 `render`，7 个）**：每个工具的 outcome 分支各自组织；相同语义的句子在私有 render 里手写——Attention 后果句 6 处（`team_attention` 4 分支、`team_thread` read 的 Thread/Main 各 1、`start`/`claim` 结果各 1），只有原因短语共享 `CAUSE_OF_SOURCE`（`:349`）。这是 04 的收敛对象，不是缺陷，但边界在此。

**Host 私有**：`notificationText`（`agent-team/src/index.ts:2916`）与 `dmRelayText`（`:1961`）是通知侧唯一权威；`recovery-hints.ts` 注册表（38 条）是恢复句唯一权威，`assertRecoveryCoverage` 双向守卫、`forbidHandWrittenRecovery` 扫模型面源码的手写路由句。

## 2. 输出预算总表（SCOPE 清单第 5 条）

| 出口 | 默认 | 上界 | 位置 |
| --- | --- | --- | --- |
| Thread read 未读批次 | 20（硬编码 `unread.slice(0, 20)`） | 20 | `ledger.ts:4310` |
| Main read 页 | 20（`MAIN_READ_PAGE_SIZE`，最新 20 + 被标记条目） | 20+ | `ledger.ts:491`、`5028` |
| `team_thread history` | 20 | 100 | `ledger.ts:2215` |
| Main stream history | 20 | 100 | `ledger.ts:1382` |
| `team_view` Threads 页 | 20 | 100 | `ledger.ts:2376` |
| `team_inbox` | 50 | 100 | `ledger.ts:1897` |
| `team_task board` finished | 5/Project（`TASK_BOARD_FINISHED_PER_PROJECT`） | 100 | `ledger.ts:203`、`1974` |
| Thread 有界主题 | 80 字符 | — | `index.ts:28` |
| Main 卡 preview/gist | 120 字符 | — | `ledger.ts:552` |
| 通知正文 | 8,192 字符后截断并标记 | — | `surface-visibility.ts:17` |
| 工具结果剪裁（历史） | `tool-result-pruner` 8,192 阈值 | — | Harness 侧 |

观察：读侧有两套「20」——Thread read 的 20 是**硬编码魔数**（无命名常量、无参数），Main read 的 20 是命名常量。语义还不同：Thread 取最旧 20 条未读（分批确认），Main 取最新 20 条（不管未读几条）。03 要改的正是后者。

## 3. 相同概念的一致性（SCOPE 清单第 3 条）

一致的部分：token 交接句只有 `nextWriteLine` 一种；拒绝首词只有 `Not committed —`；事实行 read 与拒绝共用 `factLine`；Task 站立只有 `taskStanding` 一种拼法；「去某工具读全文」的路由句全部来自 recovery 注册表。

不一致的部分（均已核）：
1. **token 出现面的说法互相矛盾，且 `tools.md` 同一文件自相矛盾**：`:75` 说拒绝交还当前 revision、「the retry commits with no intervening read」，`:77` 说「Recovery is still read-and-reconsider: the rejection's facts are the gate」。zh 版把两句并进同一段（`tools.zh.md:59`），矛盾依旧。代码事实：两类拒绝都渲染 token（`rejectionLines`），但 `unread_required` 的重试仍被未读门挡住（除非豁免命中）——见 02 票据。
2. **`boundaries.md(+zh)` 与两个 package README 仍在断言旧契约**：`boundaries.md:6`「token 不出现在任何 typed rejection」；`README.md:12`/`README.zh.md:12`「render no numeric revision or write token」——与 `README.md:22`（新契约：token 出现在「a typed rejection that names the current revision」）在同一文件里打架。
3. **persona（`cordis.patch.yml:111`）与 core skill 末行**说「a rejection supplies no write basis」，而拒绝结果 literally 渲染 `Next write — baseRevision: N`。
4. 分页参数的文档不对称：`team_thread` 的 `beforeSequence`/`limit` 有描述，`team_view` 的 `limit`/`cursor` 与 `team_inbox` 的 `limit` 只有类型没有描述（render 里才说「up to 100 rows」）。

## 4. 参数表的开放性与重复文本（SCOPE 清单第 5、6 条）

工具框架把参数表编译成 `{type, properties, required}`，**没有 `additionalProperties`**（`team_dm` 的注释 `index.ts:801` 记于此）。因此未命名参数会被静默丢弃，除四处手写守卫：`team_dm` 的 stray 检查（`:802`）、`team_message` 的 `asTask` 检查（`:911`）、`team_thread` 的 `messageRef` 归属检查（`:601`）、`team_task` 的逐 action 参数检查（`:1140` 起一串）。`team_view`/`team_inbox`/`team_attention` 没有 stray 守卫——对只读工具代价低，但这是一个已知的框架级缺口。

重复文本（本次新量，编译后口径）：37 段参数描述共 8,766 字符，其中逐句重复的浪费 **3,206 字符（36.6%）**：

| 重复句 | 次数 | 小计字符 |
| --- | --- | --- |
| 「An unambiguous abbreviation of the first 6+ UUID hex characters also resolves.」 | 9 | 702 |
| 「Required when you participate in more than Workspaces…」 | 7 | 700 |
| 「Target Workspace id exactly as listed in your participation context or team_view.」 | 7 | 567 |
| 「A unique prefix of at least 6 hex characters also resolves.」 | 7 | 413 |
| 「This does not change your Session cwd.」 | 7 | 266 |
| 其余 11 句（ref 格式、body 文风、taskRef 别名等） | 2–3 | 558 |

单工具 schema 体量（description + 参数 JSON）：`team_message` 5,827（31%）、`team_task` 4,131、`team_thread` 3,203、`team_dm` 2,012、`team_attention` 1,687、`team_view` 1,054、`team_inbox` 808；合计 **18,722**，与基线 18.7K 吻合。workspace 参数一整段（约 280 字符 × 7 ≈ 1.9K）是最大单块重复。

## 5. Q3 证据：已确认问题分级

SCOPE Q3 问「本轮是否允许窄修 schema/action/result」。以下每条都有源码或测试证据；分级为建议，不等 Human 拍板。

### A. 窄修候选（有证据、改动局部、与呈现迁移可分票）

1. **Thread read 批次魔数**（`ledger.ts:4310`）：`unread.slice(0, 20)` 无命名常量、无参数、与 `MAIN_READ_PAGE_SIZE` 同值不同源。建议提为命名常量并注明与 Main 页的语义差异。证据：本节预算表。
2. **`team_view`/`team_inbox` 分页参数无描述**：`limit`/`cursor` 只有类型。建议补一句话描述（默认值 + 上界），与 `team_thread` 对齐。证据：`index.ts:294`、`:1255`。
3. **Main read 的「20 条全文」改有界投影**——这已是 03 整票，不算窄修；列此只为说明 Q3 的「result 问题」主项就是它。
4. **拒绝 token 条件渲染**——02 整票（含结构化探针）。

### B. 有意的非对称（有注释与语料证据，保留）

1. `read` 忽略 `beforeSequence`/`limit`，而 `history`/`message` 拒绝（`index.ts:629-632`）：注释记「一次真实 session 在被要求去掉后原样重试了两次」。
2. `post` 静默丢弃 `kind`/`accountable`/`sourceThreadRefs`（`:894`）：注释记为避免白费一次重试；空 `sourceThreadRefs: []` 等同未传。
3. `blankToAbsent` 把 `''`/`0`/`false` 归一为未传（`:207`）：只对地址/选择参数；`body`/`direction` 不归一（空是真实错误）。
4. `unread_required` 恢复句让人先 read（`recovery-hints.ts:35`）：与未读门顺序一致；02 改的是豁免命中时的句子，不是这条的现状。

### C. 框架限制（记录，不在本工作项修）

1. 参数表无 `additionalProperties`，stray 参数只能手写守卫（见 §4）。
2. `PreStepDecision` 只接受 `UserMessage[]`，member-context 的旧副本无法就地替换（01 票据已记录，Harness 扩展点问题）。
3. `tool-result-pruner`（8,192）只剪工具结果；member-context 旧副本是 user message，剪不到（§1.2 已量）。

### D. 明确不纳入

- 通知文本（`notificationText`/`dmRelayText`）的整理：`team-performance-optimization` 正在改同一路径，等它定型。
- Client/Remote 面：本工作项不改 Human Client；Remote 结果形状是 03 的约束而非对象。
- 模型评测重跑：属 04 的验收，不在本清单。

## 6. 未覆盖与边界

- 本文是**只读盘点**：没有改任何代码、schema 或文档；引用行号对应 master `3d16926`。
- persona 与 core skill 的逐句清点归 04；本文只标了与工具面的矛盾处（§3）。
- 「输出省略后是否仍指出完整事实的入口」逐工具核对结论：七个工具的 render 都以路由句收口（read/inbox/view→`team_thread read`，rejections→recovery 注册表，board→Thread），没有只给截断不给入口的出口；Main read 的截断上下文入口（`history`/`message`）是 03 要补强的那一处。
