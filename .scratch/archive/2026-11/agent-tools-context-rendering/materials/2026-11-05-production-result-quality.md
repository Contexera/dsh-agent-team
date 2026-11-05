# 生产日志核对：工具结果输出形状（07 的免费一半）

日期：2026-11-05。核对人：Vera（质量职能）。本文件是 07 验收材料的一部分，**只证明「模型从工具里看到的输出形状对不对」，不证明「模型理解得对不对」**——后者是 07 仍未运行的付费评测，见 [验收核对](2026-10-30-acceptance-plan.md) 与 [harness 说明](../harness/README.md)。

起点：2026-11-04 Human 指出「不应该看 tool result 输出质量？」——批评成立。真实会话日志里有结果原文，对照 [spec](../spec.md) 的承诺做机械核查即可，不需要付费模型调用。本轮把该核查落成本工作项的可复现证据。

## 方法

- 语料：本机全部成员会话日志（`~/.dsh/sessions/--home-yu-projects-dsh-agent-team--/agent-team-*`），会话→成员归因用账本重放出的全代际 `sessionId→memberId` 映射（含 recycled/rolled-over/renewed），不只取当前代。本轮归因成功 **496** 个会话目录，窗口 `2026-10-22` 起。
- 前后切分：以 v0.2.6 发布日 `2026-10-31` 切 before/after。发布日当天成员会话需重启才吃到新构建产物，故按天核对时另做「剔发布日」的干净日对比（见下）。
- 判据：`tool/call.callId` ↔ `tool/result.data.message.toolCallId` 配对；拒绝＝`isError===true` 或正文含 `Not committed`。通知读 `agent/inbox/spliced` 事件（不是 `user/message`），direct 文案有 Main stream / Thread / Team 三种变体，正则须写 `Direct [^\n]*mention`，否则漏一种会把数百条 direct 误归 ordinary。
- 只读、离线、无付费调用、无凭据。

复跑（脚本随本工作项归档，`harness/` 下可直接运行）：

```bash
node .scratch/archive/2026-11/agent-tools-context-rendering/harness/production-result-quality-scan.mjs
```

**JSON 输出默认写到仓库外**（`$HOME/.dsh/result-quality-<ts>.json`，可用 `RESULT_QUALITY_OUT` 改）：它含拒绝样本与结果正文片段，即真实内部讨论内容，而本仓库是公开的。本文件只留聚合数字。脚本只读、离线，不读也不写任何凭据。

## 五轴结果（2026-11-05 复跑）

| 轴 | spec 承诺 | before | after |
| --- | --- | --- | --- |
| A 拒绝→恢复 | §7.1 拒绝给可执行恢复路径 | 恢复 **67%**（92/138） | 恢复 **95%**（42/44） |
| B read 前进 | §4.1 一次调用必须前进，不重复同一开头 | 重复 35/589（5.9%，12 段） | 重复 **0/368** |
| C 正文去重 | §4.2 已提供过的内容不重放 | 命中 27 | 命中 **107** |
| C′ 长消息分段 | §4.1 分段可续读，无零长度分段 | 分段结果 0，零长度 0 | 分段结果 0，零长度 0 |
| D 提交回执体量 | §7.1 成功结果给本次变化与凭据，不回放正文 | post p50=170 | post p50=170（n=81）、reply 373（n=167）、start 527、claim 597、done 496、accept 357、dm 99 |
| E 通知形状 | §6 普通未读给入口与数量、不抄正文；direct 带原文 | ordinary 抄正文 0 | ordinary 抄正文 **0**/497；direct 带原文 387、不带 22 |

补充核对：

- **A 的拒绝族**：before 头部是 `schema/other`（102 拒/58 恢复）与地址族文案（22 拒/18 恢复，即 `threadRef and projectRef address different things` 一族）；after 地址族降到 6 拒/6 全恢复，头部剩流程门（`unread_required`、写令牌过期），属设计行为不是故障。拒绝文案抽样全部是「去哪拿正确的值」型指路（抄写令牌、补 ref、换 workspace id）。
- **B 的 before 重复逐对看过**：13 对全是「无未读仍再读一遍」的良性重复，输出诚实、未伪造未读。因此只报数字，不把它说成修复了缺陷；after 连这种良性空转也为 0。
- **D 的大结果**：`read` p50=2297、`board` 3052、`view` 8577、`history` 14016——都是信息性结果，体量合理；提交类动作无一超过 800 字符，无正文回放。
- **E 的 22 条 direct 不带原文**：全部是发布后出现的「正文已在当前上下文、仍未读」去重形态，引用消息而不重抄——正是 06 票交付的行为。
- **「无法判定」措辞滥用**：真实滥用 **0**。脚本报出的 2 处命中都是假阳性：`team_thread read` 结果里**引用**了含该词的正文（一处是 AGENTS/docs 原文，一处是我自己 11-04 报告里写的「没有任何结果滥用『无法判定』措辞」）。即量测工具开始量到自己的报告，记录在此以免后续复跑误读为回退。

## 归因稳健性

- **剔发布日的干净日对比**（同一批语料按天拆）：拒绝率 before **8.0%**（各日 6.2–14.3）→ after **4.5%**（各日 3.7–5.4），after 每一天都低于 before 任何一天。发布日 10-31 当天仍 7.6%，因为成员会话未重启、旧行为混在 after 桶里——era 对比必须剔发布日或单独归因。
- **可见异常的唯一形态**：10-25 单个成员一天 31 次调用 22 次拒绝（71%），其中 19 次卡在同一个 `threadRef`/`projectRef` 混淆上出不来。这是修复前摩擦「看得见」的样子；本工作项的价值主要是挡掉这类 episode 与省上下文，两者都无画面。
- **两次复跑一致性**：11-04 首跑与 11-05 复跑，before 轴完全相同（140 拒/138 跟进/92 恢复；589 reads/35 重复），after 轴单调增长（reads 336→368、去重命中 87→107、ordinary 490→497），因窗口是开放的。**无任何轴出现回退。**

## 组合场景在当前 HEAD 复跑

工作项 harness 在实施后已随代码提交，本轮在**当前 HEAD `634c1e8`（v0.2.6 之后 39 个提交，含订阅/提醒/inbox digest 三条新线）**、干净工作树上复跑：

```bash
npx vitest run --config .scratch/archive/2026-11/agent-tools-context-rendering/harness/vitest.config.ts --project context-scenarios
# Tests  1 passed (1)
```

即 F3（direct→post→read）、F5（压缩→背景恢复→不重复）、F6（长通知→续读→显式确认）的组合与状态规则在后续三条功能线落地后仍成立，无回退。日志：`.scratch/local/agent-context-implementation/context-scenarios-at-634c1e8.log`。

## 这不能证明什么

- 不证明真实模型会正确理解结果、会按新事实改变行动、不会误调用——那需要 07 剩下的付费评测（获授权模型配置 + 重复样本），本轮未运行、未复制归档凭据。
- 不证明 token 或费用收益：所有长度是 UTF-16 代码单元，不是 token，也不是 provider 请求字节数。
- 分段续读（C′）在窗口内**零真实触发**（没有消息长到需要分段），因此该承诺只有回归测试证据、没有生产日志证据；零长度分段那个已修缺陷无复发迹象。
- 按成员归因是近似（recycle/rollover 文件约 7% 含多成员轮次）；总量与比率精确。
