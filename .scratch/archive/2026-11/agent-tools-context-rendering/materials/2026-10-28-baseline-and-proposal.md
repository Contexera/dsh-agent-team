# 现状基线与方案提案（2026-10-28）

核对版本：master `0881268`。证据来自三处：源码通读（七个工具、Host 通知、recovery hints、persona、core skill、member-context）、全量 session 语料（`~/.dsh/sessions`）、一次真实 ledger 探针。语料脚本在 `harness/`，可复跑，也是后续验收的度量口径。

> **修订记录（同日，Human 安排的独立 review 之后）**：review 复现了本文全部数字，并指出三处错误，均已核实并改正：
> 1. **§1 的排序口径混用**：注入类用累计字符、固定文本用单次量，且把最大的一项放在表外。修正见 §1.0。
> 2. **01 打偏**：memory 段占整块 94.1%，分段去重只省约 5%；真正的杠杆是注入策略。01 重写，默认采用 (b)。
> 3. **02 范围少了一半**：矛盾不止四处（至少 8 处，含两个 package README 仍在断言旧契约）；恢复句不改，往返照样省不掉。
> 另补：03 缺「read 之后紧接 post」的场景验收；`history`/`view` 不能被 pruner 兜底（pruner 只在达到压缩阈值时跑）；SCOPE 主项（七工具契约清单与 Q3 证据）尚未做。
>
> **第二轮修订（2026-10-29，Vera 独立复核后）**：数字全部复现（语料实时增长所致的漂移已注明）；补两条实现缺口、一处证据链订正、一处口径订正、一条排序建议：
> 1. **01 的去重判据必须换**：现在「最近一条 member-context 消息等于这次拼出的完整块」；(b) 中途只发一行后，下一次完整块永远不等于最近一条消息，会每个 step 重发整块、比现状更糟。改为**两类摘要**（非 memory 段摘要 + memory 摘要）按 fail-closed 次序判断：无本 producer 消息 → 整块；非 memory 段摘要不同 → 整块；memory 摘要不同 → 一行；都相同 → 跳过。先比 memory 会漏掉 ownership 变化。删 memory.md / 超 16KiB 不许降级成一行。跨 step 测试与两条边界验收见 `issues/01`（现有集成测试的 fake surface 从不累积消息，该守卫没有回归网）。
> 2. **02 的结构化探针落点未定**：已交付 fact sequence 记在 session 什么位置、重启/压缩/被 pruner 截断后怎么判，要先定再开工；`team-rejection-payload.spec.ts` 与 `team-tools-render.spec.ts` 现在断言「每个 unread_required 都带 token」，条件渲染要主动反转这些断言。已写入 `issues/02`。
> 3. **证据链订正**：`team-rejection-payload.spec.ts` 头注释只锁「拒绝里能学到变化」，「重试必须能提交」只存在于文档。02 的性质是 **render 半边已落、gate 半边没落**，不说成「代码自己的意图已实现」。
> 4. **口径订正**：§1.0 的 33.7K 是 Team 自有文本口径；按成员会话实测每步固定文本约 38.9K（system 19.5K + schema 19.4K），「每步固定文本」说法偏低约 15%，不影响排序。
> 5. **排序建议（已采纳并按「blocker 在前」重编号）**：契约清单先于规则收敛——重排完工具描述后再盘点，可能又找出 schema 问题。原 05（契约清单）与原 04（规则收敛）互换编号：契约清单=04（已交付），规则收敛=05（阻塞在 02）。
> 四个默认项（范围修订、01 用 (b)、02 让拒绝 token 真能用、Harness 先靠 (b) 缩小）Vera 技术上不反对，拍板权在 Human；01/02 票据已按上述两条缺口补写，待 Human 确认后开工。

## 1.0 两把尺子：累计处理量与稳态占用

本文最初只列了「注入的字符累计」，把固定文本排除在表外，却据此得出「最大收益在 context 注入」。固定文本每步都重发，在累计口径下是最大的一项：

| 口径 | 数字 |
| --- | --- |
| 固定文本单次量（Team 自有文本口径） | 约 33.7K 字符（persona 15.0K + 七个工具 schema 18.7K） |
| 固定文本单次量（成员会话实测口径，2026-10-29 订正） | 约 38.9K 字符（system 19.5K + 七个工具 schema 19.4K）；比 Team 自有口径高约 15% |
| member session 的 step 总数 | 62,399（230 个 session；Vera 复跑 62,534 / 234 个，语料实时增长） |
| 固定文本累计（未计缓存折扣） | 约 21 亿字符 |

session 日志的 `request/context` 事件只带 provider/model/contextWindow，**不带请求体量**，所以累计处理量无法从日志直接测得，上面是估算。缓存会把它打折：消息是追加式的，persona+schema 位于稳定前缀，前缀命中后只付缓存读取；但只要 context 中间插入新消息，其后的部分重新计费。

两把尺子回答不同问题，**后续排序必须同时给两个数**：

- **稳态占用**（任一时刻 context 里有多少字符）：member-context 的旧副本最大（p50 8.6K × 每 session 6～21 份），固定文本约 33.7K 常驻。
- **累计处理量**（折算缓存命中）：固定文本最大，member-context 次之，工具结果再次之。

05（每条规则只放一处）因此从「最后一张票」升为与 01 同优先级——它砍的是每步常驻与每步缓存读取量。

## 1. 量出来的事实

### 1.1 Agent 收到的 Team 文本，按总量排

| 来源 | 次数 | 单次 p50 / p90 | 语料总量（字符） |
| --- | --- | --- | --- |
| member-context 块（身份 + ownership + memory + workspaces） | 2,183 | 8,539 / 11,122 | **18,376,284** |
| 全部 Team 工具结果（7,594 次调用合计） | 7,594 | — | 9,697,459 |
| Team Inbox 通知 | 2,923 | 610 / 2,358 | 3,107,308 |
| context snapshot | 252 | 3,300 / 6,005 | 830,969 |
| time context | 2,340 | 254 / 259 | 595,760 |

**member-context 块的体量约为全部工具结果的 1.9 倍。** 本工作项原先假设的重心（工具结果文案统一）不是体量最大的地方。

### 1.2 member-context 为什么这么大

- `member-context.ts` 的 pre-step 钩子把四段拼成**一条**消息；只要拼出的文本和 surface 上最近一份不同，就整块重发。
- 触发原因（`harness/member-context-triggers.mjs`）：**1,720 / 2,183（79%）是 memory.md 变了**；会话首次 230；压缩后重注 199；ownership / workspaces / 身份变化合计 34。
- 每次重发整块 p50 8,641 字符，而变化跨度 p50 3,560（跨度从第一个不同字符量到最后一个不同字符，是上界；用量计数行在正文前，任何改动都会拉长跨度）。
- 旧副本是 user message，不是工具结果，`tool-result-pruner`（8,192 字符阈值）管不到，压缩前一直留在 context 里。每个 session 文件 p50 有 6 份、p90 21 份、最多 125 份。
- 块里约 1.5K 字符是固定教学文本，与 persona 重复：memory 段的说明重复 persona「Private space」；workspaces 段的「Work where the work is…」重复 persona「Loop discipline」。2,186 个块里有 802 个带 workspaces 段，其中平均约 2.2 句与 persona 逐字重复。
- **段构成（`harness/` 之外补测，2026-10-28）**：memory 17,303,742（94.1%）、workspaces 807,758（4.4%）、identity 221,620（1.2%）、ownership 62,840（0.3%）。⇒ 「四段各自去重」在 memory 变化时只省掉约 5%，**分段不是杠杆，注入策略才是**。
- 单位订正：脚本遍历的是 827 个**文件**；语料实际是 724 个 **session 目录**，其中 101 个目录同时存有 v3/v4 两代日志。本次结论未被污染（注入只发生在最新一代），但「每 session 几份」必须按 session 目录口径重写，01 拆票后要按段归并、按 surface 折叠计数。

### 1.3 写入 token 契约四处说法互相矛盾，其中一处是错的

`unread_required` 与 `stale_revision` 拒绝都会渲染 `Next write — baseRevision: N`（`tool-agent-team` 的 `rejectionLines`）。对这个 token 的说法：

| 位置 | 说法 |
| --- | --- |
| `docs/team-collaboration/tools.md` 第 75 行 | 拒绝交还当前 revision 作为下一个 token，「the retry commits with no intervening read」 |
| `docs/team-collaboration/boundaries.md` 第 8 行 | token 不出现在「every typed rejection」中 |
| persona「Team tool workflow」、core skill 末行 | 「a rejection supplies no write basis」，必须重读 |
| 同一条拒绝结果里的 recovery 句 | 「Read the pending updates with team_thread read before reconsidering this write.」 |

真实行为（探针：真实 ledger + 真实 `isFactOnSurface`）：

- `unread_required` 拒绝不确认已读；visible-surface 豁免只认 Team 写的 user message（通知、DM relay），不认工具结果。所以普通更新的场景下，**用拒绝给的 token 重试仍然得到 `unread_required`**；只有该正文已在某条通知里全文出现时才会提交。
- `stale_revision` 给的 token 是有效的：语料里 16 次带它重试，15 次成功。
- 模型大多照「重读」走：`unread_required` 之后 183/188 次先 read。这处错误的实际代价有限，但它出现在最常见的拒绝上（语料 186 次），而且是一条假指令。
- **证据链订正（Vera 2026-10-29）**：`team-rejection-payload.spec.ts` 的头注释只锁「拒绝里能学到变化」，没有证明「重试必须能提交」——那句话只存在于文档。所以 02 的准确性质是 **render 半边已落（拒绝里带事实与 token）、gate 半边没落（未读门仍挡住重试，豁免看不到工具结果）**，不是「代码已实现自己的意图」。

### 1.4 Main stream read 不管未读几条，都回最新 20 条全文

`ledger.ts` 的 `MAIN_READ_PAGE_SIZE = 20`；`mainReadPage` 总是取最新 20 条，再加被消费的旧标记。Thread read 只回未读批次。语料里 Main read p50 6,887、p90 10,314 字符（89 次，Main Attention 刚上线，样本少）。今天我本人两次读：每次 1 条未读，拿到约 20 条全文，其中多条是我自己发的。

### 1.5 同一规则在多处重复

每次请求开工前的固定文本约 33.7K 字符（persona 15.0K、七个工具 description 与参数 18.7K）。**这是单次量；它在累计口径下的位置见 §1.0**，本节只说明重复本身。

| 规则 | 工具 schema | persona | core skill |
| --- | --- | --- | --- |
| ref 格式「exactly as returned by Team tools」 | 7 | 0 | 0 |
| ref 缩写「6+ hex」 | 13 | 0 | 0 |
| 「next-write token」 | 5 | 1 | 0 |
| `@Handle` 提及规则 | 3 | 2 | 2 |
| 「Lead with the conclusion」消息文风 | 2 | 1 | 0 |

此外，每个写结果都带「(copy exactly; never derive or cite)」；Attention 后果句在 6 个 render 分支里各自手写（`team_attention` 4 种、`team_thread` read 的 Thread 与 Main 各 1 种、`start` 与 `claim` 结果各 1 种），只有原因短语共享 `CAUSE_OF_SOURCE`。

### 1.6 其它读侧体量（优先级较低）

- `team_thread history`：p50 4,746，p90 14,180，最大 49,930。
- `team_view`：p50 6,907（270 次）——每次都返回全部 Project、一页 Thread 和全部 Member 描述。
- 两者超过 8,192 字符的部分会被 `tool-result-pruner` 在历史中裁剪，所以长期占用小于单次体量。

### 1.7 已经做对、应保留的

- `recovery-hints.ts` 注册表：每类拒绝一条句子，双向覆盖守卫，加上手写恢复句的扫描门。这正是「单一权威」的形状。
- 模型评测：有指引的抛错一轮内自愈；三处修复上线后 10-28 首个全绿窗口。
- 工具写结果很短（`team_message reply` p50 269 字符）。

## 2. 对 SCOPE 前提的修正

1. **SCOPE Q1 初步倾向「共享的 Agent-facing 语义视图层」——证据不支持。** 工具结果本身短而一致；问题集中在注入策略（1.2）、读页策略（1.4）、契约矛盾（1.3）和规则放置（1.5）。新建语义层解决不了其中任何一个。建议沿用现有注册表形状：需要共享的短语进注册表（如 Attention 后果句并入 `CAUSE_OF_SOURCE` 旁的一张表），不建新抽象层。
2. **「Attention 作为首个端到端用例」已经过时。** `attention-delivery-model` 已归档（`b69bde5`），语义与文案已落地。Attention 剩下的只是 1.5 里的短语收敛，归入规则放置那一票。
3. **收益排序要分两把尺子，不能只说一把。** 稳态占用下最大的是 member-context 副本；累计口径（缓存折扣后）下最大的是每步重发的固定文本。01 与 05 因此同列第一梯队，见 §1.0。

## 3. 方案：五张票据（票据文件在 `issues/`；01、02、03 可并行，05 排在 02 与 04 之后）

每张都是独立可验收的窄切片。执行顺序（2026-10-29 定，采纳 Vera 建议并按「blocker 在前」重编号）：**04 契约清单已交付 → 01/02/03 并行 → 05 等 02 落定**——盘点在规则重排之前，否则 05 找出 schema 问题要返工；02 会改 token 规则与恢复句原文，05 以其为准。原 04（规则收敛）与原 05（契约清单）编号互换，Thread 里的旧编号指互换前。

### 01 — memory 索引的注入策略（重写）

**原方案（四段各自去重）作废**：memory 段占整块 94.1%，分段只省约 5%。

- **默认 (b)**：memory 索引只在会话开始与压缩后整份注入；会话中途 memory.md 变化时，只注入一行（索引已更新的提示 + 用量百分比 + 「以文件为准」）。依据：memory.md 只有它自己的 Member 能写，路径已常驻在块里，Member 有文件工具可随时读回；所以注入的副本是便利，不是 authority。预计 member-context 从 18.4M 降到约 4.6M。
- **(a) 只重发 memory 段** 保留为兜底：若某场景证明模型确实依赖注入副本（例如读不到自己刚写的内容），退回 (a)。
- **去重判据必须同时换（Vera 2026-10-29 缺口，已写入 `issues/01`）**：现在的判据是「最近一条 member-context 消息等于这次拼出的完整块」。(b) 中途只发一行后，下一次完整块永远不等于最近一条消息——无论那一行是不是同一个 producer——结果会每个 step 重发整块，比现状更糟。改成**两类摘要按 fail-closed 次序判断**（每会话保存 lastContextDigest / lastMemoryDigest，或两种消息都携带这两类摘要）：
  1. surface 上没有本 producer 的消息（会话开始 / 压缩后）→ 整块；
  2. 先比**非 memory 段摘要**（identity + ownership + workspaces）：不同 → 整块；
  3. 再比 **memory 摘要**：不同 → 一行；
  4. 两者都相同 → 跳过。

  次序不能反：先比 memory 再比非 memory 是错的——最新一条是一行时它只带 memory 摘要，此时 ownership 变了会被误判为「无变化」，旧列表继续留在 context。另有两个边界不许降级成一行：memory.md 被删除/不可读；超过 16KiB 预算（整块形式的「contents were not injected」警告不能被一行吞掉）。验收含三条跨 step 场景：先发一行再改 ownership/workspaces → 整块；先发一行再删 memory.md → 不可用提示；先发一行再把 memory 推过 16KiB → 预算警告。现有集成测试的 fake surface 从不累积消息，这条守卫目前没有回归网，01 必须补上。
- 无论 (a)/(b)：删掉段内与 persona 重复的教学文本；若保留标记句，必须写明「上方索引已过期，以文件为准」——否则块首「complete replacement」变成假话。
- **旧副本清理**：`PreStepDecision` 只接受 `UserMessage[]`，而 Harness 的替换能力来自它自己的 `RuntimeContextProjection` 用 `SystemPromptCommit` 提交的 `surfaceOp: { op: 'replace' }`（`../deepseek-harness/packages/core/agent-loop/src/runtime-context.ts:108`），**插件钩子申请不到替换**。两条路：(i) 按 AGENTS.md 把「pre-step 上下文无法就地替换」记为 Harness 扩展点不足，再决定是否做 Team 侧插件；(ii) 先用 (b) 把块本身变小，旧副本问题随之缩小约 75%，此时再判断替换能力是否仍然必要。**默认先 (ii)。**
- **验收（含度量脚本改造）**：`member-context-resend.mjs` 与 `member-context-triggers.mjs` 都是按整块文本比对的，拆成多条消息后注入次数与触发原因都归不了类，01 必须同时改造它们（按段归并、按 surface 折叠而非按 log 行计数、按 session 目录口径）。门槛写成可量化：**memory 变化触发的累计字符下降 ≥ 80%**，单测覆盖「会话开始/压缩后整份注入」「中途只发一行」「索引确实变化」「ownership 撤销仍替换旧列表」。

### 02 — 拒绝结果里的 token 只在它真能用时出现（范围扩大）

- `stale_revision`：保持现状，token 有效。
- `unread_required`：推荐方案是把 visible-surface 豁免扩展到「Team 工具结果里全文出现过的消息正文」。拒绝结果本身就全文渲染了这些事实，于是重试真能提交，`tools.md` 的说法成立，186 类场景省一次往返。豁免照旧不写 ledger、失败即关闭；activity 事实和被裁剪的正文不豁免。只有当这次重试真会提交时才渲染 token，否则不渲染，并给出「先 read」。
- **这不是新的设计取舍，是没收尾**（证据链写法见 §1.3 订正：render 半边已落、gate 半边没落）：`team-rejection-payload.spec.ts` 头注释与 `tool-agent-team` 的 `rejectionLines` 注释都写明这条契约的目的是省掉那次多余的 read 往返；行为没跟上。
- **矛盾至少 8 处，不是 4 处**：EN/ZH 的 `docs/team-collaboration/tools.md`、`docs/team-collaboration/boundaries.md`、`packages/tool-agent-team/README.md(+zh)`、persona（`cordis.patch.yml:111`）、core skill（`SKILL.md:83`）。其中两个 package README 仍在逐字断言**旧契约**「Typed rejections … render no numeric revision or write token」，与现行代码直接冲突；`boundaries.md:8` 说 token 不出现在任何 typed rejection 里。02 必须一次改全，否则又是半迁移。
- **恢复句必须一起改**：`recovery-hints.ts` 的 `unread_required` 句子仍让人先 read；语料里 183/188 次照做。只改豁免不改句子，往返照样省不掉。
- **技术风险（重要）**：`surface-visibility.ts` 现在是「结果文本含 body 原文」的子串判断，窄口径正是为了防误命中。扩到工具结果后，`ok`、`done` 这类短正文会在 `team_view`、`history`、Thread card 里大量误命中。**默认改结构化判断**：拒绝/read 把已交付的 fact sequence 记进 session，探针查记录；退一步也要限定匹配位置（`factLine` 行形状）并设最小正文长度。
- **探针落点要先定（Vera 2026-10-29 缺口，已写入 `issues/02`）**：已交付的 fact sequence 记在 session 的什么位置、重启/压缩/结果被 `tool-result-pruner` 截断后怎么判，写进设计再开工。测试侧：现在共 **8 个用例**断言 `unread_required` 带 token（`team-rejection-payload.spec.ts` 的 33/53/68/114/135 行 + `team-tools-render.spec.ts` 的 495/606/688 行），改条件渲染要**主动反转全部 8 个**——含 team_task 侧与「never invents a second write token」那条，别等全套跑红才发现。
- 验收：ledger 层探针改为正式测试（普通更新：拒绝 → 带 token 重试 → 提交；含 activity：仍拒绝且无 token）；render 测试断言 token 出现与否；8 处文档逐条对齐；离线语料回放该形状；短正文误命中有专门用例。

### 03 — Main stream read 只回未读加有界的上下文

- 与 Thread read 对齐：未读条目全文；前面的上下文只给少量有界主题行（复用 `boundedSubject`），更早内容走 history。保持「标记不会被未展示地清掉」的不变量。
- **只改 Agent 工具的投影与 render，不改 ledger 的 `mainReadPage`**：Human Client 经 Remote 调用同一个 `readMainStream`，并消费它返回的 entries（`client-agent-team` 的 `useMainStream`）；改 ledger 会改变 Client 的结果形状，越出本工作项「不改 Human Client」的边界。
- **验收（补场景）**：1 条未读时工具结果只含该条 + 有界上下文；消费的旧标记条目仍全文展示；ledger 与 Remote 结果不变，Client 测试无改动即通过；**必须加「read 之后紧接 post」的场景**——未 follow 该 Project 的 Member 读完就发言时，「1 条未读 + 19 条主题行」可能让它看不到刚聊的内容，此时 `history`/`message` 作为读全文的入口要写进页脚。

### 04 — 七工具契约清单与 Q3 证据（SCOPE 主项，2026-10-29 已交付）

提案把「七个工具的契约审查」收成一句「工具结果短而一致」，没有逐工具清单，SCOPE 的只读审查清单一条都没落证据，Q3（本轮是否允许窄修 schema）没有材料支撑。补做：七张表（schema → execute → structured result → render → tests → maintained docs），标出共享 helper 与私有 renderer 的边界、相同概念的不同命名、输出省略后是否仍指出完整事实的入口，以及预算。产出可能新增票据（窄修 schema/action），与呈现迁移分票。

**交付物**：`materials/2026-10-29-seven-tools-contract-inventory.md`（核对 master `3d16926`）。要点：预算总表（两套「20」的不同语义、inbox 50/100、board finished 5/100 等）；`tools.md:75` 与 `:77` 自相矛盾；参数描述逐句重复 3,206 字符（36.6%），workspace 参数七整段重复；Q3 分级——窄修候选 2 项（Thread read 批次魔数、view/inbox 分页参数无描述）、有意非对称 4 项（有注释与语料证据，保留）、框架限制 3 项（无 `additionalProperties`、pre-step 无替换能力、pruner 剪不到 user message）。

### 05 — 每条规则只放一处（优先级上调）

- 分工：persona 放跨工具的工作流规则；工具 description 放本工具做什么与本工具契约；参数 description 只写本参数格式，一句话；结果只给状态与下一步；core skill 放按需查阅的表格。
- 具体动作：ref 格式与缩写规则只在 persona 说一次，参数描述缩成「`thread:` ref」这类短语；token 规则只在 persona 和 `missing_write_token` 恢复句；Attention 后果句收进一张短语表；body 文风只在 persona。
- 验收：前后对比固定文本字符量；用 `team-tools-model-eval` 的 live-eval harness 重跑基础与对抗场景，比较错误调用、恢复轮数与输出量，不得回退。
- 上调理由见 §1.0：固定文本在累计口径下是最大一项（约 21 亿字符，缓存折扣后仍是每步常驻 + 每步缓存读取），而它此前被排除在我的排序表外。

### 暂缓（证据不足或别处在动）

- 通知页脚与每段「Read:」行重复：量小；`team-performance-optimization` 正在改通知路径（工作树里已有它的 `notificationText` 改动），等它定型后一并处理。
- `history`（p50 4,746、最长 49,930）与 `view`（p50 6,907）：**原先用「有 pruner 兜底」解释暂缓，这个理由是错的**——pruner 只在 `member-compaction.ts` 输入达到压缩阈值那条分支里跑（`prune.pruneSession`），平时不剪，所以占用是一直在的。仍建议暂缓，但理由是「两者是主动翻页/查目录的动作、单次量可控，且 05 会改它们的呈现」，不是因为已被兜底。

## 4. 需要 Human 拍板的

> 2026-10-29：Vera 独立复核后，四个默认项她技术上不反对（范围修订、01 用 (b)、02 让 token 真能用、Harness 先靠 (b) 缩小），拍板权在 Human；01/02 票据已按她指出的两个缺口补写。以下仍待 Human 确认后开工。

1. **接受范围修正**：不建共享语义层；票改为 01（注入策略，默认 (b)）、02（范围扩到 8 处 + 恢复句 + 结构化探针）、03（含 read-then-post 验收）、04（七工具契约清单与 Q3 证据，已交付）、05（每条规则只放一处，优先级与 01 并列，排在 02 与 04 之后）。默认：没有异议就按此推进。
2. **memory 索引是否每步注入**：这是比四段拆分更根本的问题。默认：只在会话开始与压缩后整份注入，中途只发一行用量更新（即 (b)）；若实践证明模型需要注入副本，退回 (a)。
3. **02 的方向**：让重试真能提交（推荐，与 `team-rejection-payload.spec.ts` 的契约意图和现有豁免设计一致），还是只是不再给 token。默认：前者。
4. **Harness 替换能力**：pre-step 钩子申请不到 `surfaceOp: replace`，旧副本只能等压缩。默认：先用 (b) 把块变小，再判断是否值得按 AGENTS.md 记为扩展点不足并做 Team 侧插件。

## 5. 验证方式（回答 SCOPE Q4）

- 体量：`harness/context-volume.mjs`（工具结果与注入消息的分布）、`harness/member-context-resend.mjs`（重发量与每 session 副本数）、`harness/member-context-triggers.mjs`（重发原因）。以本文 §1 为基线。
- **基线原始输出**：`2026-10-28-baseline-output.txt`（同一脚本复跑的未编辑输出）。读前看它的头部两点：语料是实时目录、数字会漂；`files` 是日志文件数而 session 是目录口径，两者别混。
- 行为：`team-tools-model-eval` 的 live-eval harness；离线语料回放用于 02 的拒绝形状。
- 生效前提：改动要 build 并重启成员进程后才进入 dev profile 的语料（与评测工作项的同一提醒）。
