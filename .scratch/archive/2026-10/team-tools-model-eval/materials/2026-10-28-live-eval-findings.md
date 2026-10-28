# 活模型评测：结果汇总（2026-10-28，累计 4 轮观测）

链路：`harness/live-eval.mts`（本机 proxy `127.0.0.1:3425`，模型 `auto/gpt-6.1-sol`，隔离 Host over memory pool，七个工具用真实 schema 与真实 persona 前缀——从 `cordis.patch.yml` 原文抽取）。每场景独立 boot+seed；记录每次调用的参数、结果类别、空填、杂参。

## 累计数字（全部轮次合计）

| 轮次 | 内容 | 调用 | ok | 业务拒绝 | 抛错 | 空串填充 | 杂参 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | 5 基础场景 | 18 | 18 | 0 | 0 | 0 | 0 |
| R2 | 5 对抗场景 | 27 | 26 | 0 | 1 | 0 | 0 |
| R3 | repeat 2（proxy 400 中断前） | 8 | 7 | 0 | 1 | 0 | 0 |
| R4 | repeat 2b 完整两轮 | 91 | 89 | 0 | 2 | 0 | 0 |
| **合计** | | **144** | **140** | **0** | **4（2.8%）** | **0** | **0** |

**四分之一发生在对抗场景；干净场景零摩擦。** 10-27 的三处修复（空参归一化、读忽略页大小、报错归类）在活模型上守住了：没有一次空串填充、没有一次 read 带页大小被拒、没有一次多参 projectRef。

## 四例抛错全是同一族：把「序号」当「ref」用

| # | 场景 | 调用 | 错法 | 报错有无指引 | 恢复 |
| --- | --- | --- | --- | --- | --- |
| 1 | reply-to-message | `team_thread message`，`messageRef:'8'`（序列号） | 序号当 ref | **无** | 绕路：退回 read + body 里 @Ben，**「回复到指定消息」任务实际没达成** |
| 2 | inbox-triage | `team_message reply`，`replyToMessageRef:'message:7'`（序号套了品牌前缀） | 序号当 ref | 有 | 下一轮改对 |
| 3 | board-claim | `team_task claim`，`taskRef:'task:2f23…'` 不存在 | 疑似构造/误抄 ref | 有 | 下一轮改对 |
| 4 | board-claim | `team_task done`，缺 `taskRef` | 漏必填 ref | 有 | 下一轮补上 |

**规律**：模型在渲染结果里看到序号（`7 2026-10-28… [member:human]`）就顺手把它当 ref；品牌前缀也只是套层壳（`message:7`）。**有指引的抛错它一轮内自愈；唯一没指引的（#1）它直接放弃那条路。**

## 坐实的缺陷（可落票据）：`readMessage` 抛点无恢复指引

`packages/agent-team/src/ledger.ts:2239`（`team_thread message` 动作的读回路径）：

```
throw new Error(`Message '${request.messageRef}' is not a recorded Message`)
```

同族两个抛点都有完整指引，它光板：
- `ledger.ts:4873`（Main 流 reply target）：`unknownRefHint` + `recoveryFor('reply_target_unknown')`
- `ledger.ts:5555`（Thread reply target）：同上
- `ledger.ts:2241`（`belongs to another Thread`）同样光板。

schema 描述里已经写了「full branded Message ref … including the `message:` prefix」，模型当时没遵守——**所以修法不在描述，在抛错点**：把 unknownRefHint + recoveryFor 补到 2239（和 2241）。这与 10-13 给 reply target 补的是同一族修法，当时漏了 message 读回路径。

## 已落修复（提交 `a03c0a0`，未推送）

按 Claim「先报数后动手」：10-28 10:06 向 Human 报数并声明「你说不停我就落」，随后落这一处：

- `recovery-hints.ts` 新增三个 kind：`message_read_unknown`、`message_read_foreign`、`message_read_foreign_project`（句子与同族一致：指路 + 说去哪复制）。
- `ledger.ts` 四个抛点接上：Thread 路径的 unknown/foreign（2239/2241）与 Main 流路径的 unknown/foreign（readMainMessage 2259/2260）——同一方法家族一次修全，不做半本。
- `recovery-hints.spec.ts` 的 PRODUCED_KINDS 同步加三个（双向守卫要求）。
- `agent-team-attention.spec.ts` 原来两条 readMessage 断言从「光匹配错句」加强为「断指引存在」。
- CHANGELOG Changed 加一条（与 10-13 的「Every Team rejection now names the next action」同族；那条在此之前对本家族并不成立）。

**验证（都在最后改动之后跑）**：
- 变异验证：只回退 ledger.ts 改动 ⇒ 加强后的断言恰好红在新指引上 ⇒ 断言真挂在改动上。
- 失败点探针（`harness/probe-message-ref.mts`，复现评测里的真实形状 `messageRef:'8'` / `'message:7'`）：现在报错为 `Message '8' is not a recorded Message A Message ref must start with 'message:'; reuse the full ref exactly as returned by Team tools ('message:8'). — Message '8' is not a recorded Message — copy a messageRef rendered by team_thread read, team_view, or an inbox notice.`
- 门禁：agent-team 全套 885 过 / 1 跳；tool-agent-team 110 过；typecheck rc=0；lint 0 errors（warning 数 136 与改动前逐文件比对一致）；check:docs、check:comments rc=0。
- **没验到的**：修复后模型是否真的改走恢复路径——重跑 reply-to-message 三轮（26 次调用全 ok）**没有再诱发该动作**（随机路径没走到那步），所以行为级验证只有「坐实过缺陷存在 + 报错已在失败点指路」两层，没有「模型照指引恢复」的现场。要补这层需要更高频地诱发该形状（见「遗留」）。

## 行为观察（非缺陷，解释历史摩擦）

1. **inbox 优先起手**：多数场景第一动是 `team_inbox`，任务无关也先看。
2. **history 的 limit 用得对**：`history limit:30/100` 主动出现——页大小在 history 上是正当用法。
3. **不用 replyToMessageRef**：两轮 reply-to-message 场景，模型最终都用 body 里 @Ben 而不是 `replyToMessageRef`——「链接到具体消息」这条能力它默认不走。
4. **显式带 workspace**：单 workspace 下它也常带 `workspace:'workspace:alpha'`（无害）。
5. **任务措辞直接改变行为**：long-history 说「summarize in one reply」，模型读完用 plain text 回答、没有往 Thread 里 reply。

## 边界（读数前必须知道）

- **发生率是指示性的**：144 次调用、4 例抛错，样本小且模型有随机性；坐实的是「缺陷存在」与「指引决定恢复」，不是精确比率。
- 场景干净：fresh Host、任务直白、token 都由 read 正确交付。历史摩擦的大头（unread_required 186 次、stale_revision 35 次）发生在长会话/rollover/旧构建下，本 harness 量不到那层。
- 真实成员还有 memory/skills/AGENTS.md/compaction 注入，本 harness 未复现；persona 前缀是原文，其余上下文是仿制品。
- R3 因 proxy 上游 400（"Upstream request failed"）中断，runner 已加重试与续跑；#3 的 ref 来源因 transcript 按轮覆盖曾不可追溯（已修：按轮命名），该例只坐实「ref 不存在且一轮恢复」。

## 10-28 10:57 纠正：语料的按模型归因原来是错的（按文件取 ⇒ 回收文件多模型混居）

Human 10:55 观察「最近 Momo tool call 还行」。核实时发现：**回收/rollover 的 session 文件里混着多个成员、多个模型的轮次**（一个文件同时含 `codex/gpt-6.1-sol`、`zcode/GLM-5.3-Flash`、`auto/deepseek-v4.1-flash` 三种 model 事件），而语料脚本按**文件内第一个 model 事件**给整个文件的所有调用贴标签 ⇒ 上午「gpt-6.1-sol 样本仅 31 次」是错的。已改为**按轮次归因**（每次 tool/call 取它之前最近的 model 事件）并重跑。

**纠正后的 gpt-6.1-sol 全景（三个标签合计：`codex/`、`workbuddy-ai/`、裸名）**：

| 日期 | 调用 | 非 ok | 失败形状 |
| --- | --- | --- | --- |
| 10-04 | 17 | 15 | read/history 参数形状（10-13 修复前） |
| 10-12 | 19 | 1 | unread_required（设计门） |
| 10-25 | 21 | **21** | 全是「多带 projectRef」（411b1c6 修之前） |
| 10-26 | 4 | 4 | 同上 |
| 10-27 | 9 | 8 | 06:42 多带 projectRef ×3 → 07:39 读带页大小 ×2 → 08:40 发言多带 start-only 参数 ×3（各自对应 `411b1c6`／`73b9693`／`5ad2362`，都发生在修复落地前） |
| **10-28** | **8** | **0** | **全绿** |

合计 78 次调用 / 49 次非 ok——与 10-27 17:20 人工核的 49 一致（那次是对的，错的是我上午的脚本）。**Human 的观察被日志证实：三处修复上线后，Momo 没有再用旧形状踩坑；10-28 是第一个全绿窗口**（8 次调用仍属小样本，是趋势不是证明）。

## 遗留（下一轮候选，未开工）

1. **诱发 message-read 形状**：reply-to-message 场景只偶发诱发 `messageRef=序号`。要稳定复现，需要场景里放一条「明确要求读回某条消息原文」的任务，或直接把该形状加进离线回放语料（第一层）当回归门。
2. **`replyToMessageRef` 不走**：模型默认 @mention。若要推它用，是工具描述/流程层的事，属产品决策，先记观察。
3. **build + 重启才生效**：`a03c0a0` 改了源码与 lib 消费方；dev profile 的成员进程要吃这个修复，需要 build 产物更新 + 会话重启（与 10-27 同一生效提醒）。
