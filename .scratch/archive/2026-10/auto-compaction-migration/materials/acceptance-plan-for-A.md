# A（物理断 cc）的验收清单

Vera · 2026-10-20 · Human 已定走 A，本文件是落地后我据此验收的口径。

## 一、比"删掉依赖"更重要的一件事：别把摘要模板弄丢

`packages/agent-team/src/compaction-engine.ts`（19 行）是个**纯再导出**，导出
`@contexera/dsh-context-continuity/compaction-engine`。而那个子类**唯一做的事**是替换
`summarize()` 的指令模板 —— 选择、保留、计价、压缩锁、触发策略、替换事务全部继承、不动。

**模板本体住在 cc 里**：`lib/compaction-template.js` 的 `DEFAULT_COMPACTION_TEMPLATE`
（由 cc 的 `index.js:23` 公开导出）。它不是一个随便的提示词，cc 的注释给了测量依据：
某部署到 2026-10-05 的 133 次真实压缩里，通用 coding 模板把 30% 篇幅花在复述文件与代码、
只有 2% 给下一步，**41% 的摘要丢掉了"谁在等这个 Member"**。所以模板按"继任者无法自己重建的东西"
排序，并点名要求两件实测会丢的事实：**哪条结论是亲自验过还是转述的**、**欠着谁什么**。

⇒ **断 cc 时这个模板必须搬进本仓（约 42 行字符串 + 它的理由），不能顺手换成
`@deepseek-ai/dsh-compaction-basic` 的通用模板。** 后者行为上是合法配置（cc 注释也这么说），
但它正是上面那份测量认为会丢东西的那个模板。
**验收点**：断 cc 后产物里 `Objective and Current Action` / `Established Facts` /
`Open Loops and Obligations` 这些小节仍在，且"verified vs trusted"的区分仍被要求。

## 二、preset 行名（坑，cc 注释专门警告过）

`cordis.patch.yml:192` 现在写 `name: '@contexera/dsh-agent-team/compaction-engine'`。
注释说明了为什么：**行名是从 profile 解析的**，profile 链了本 bundle 但**链不到它内部嵌套的依赖**，
所以直接写 cc 的包名会「工作树能跑、真实 profile 报 `never started`，所有 Member 不可用」。
⇒ **断 cc 后这个行名必须改成 `@deepseek-ai/dsh-compaction-basic`**（或本仓新实现的名字），
且必须**在真实 profile 里验一次**，不能只在工作树验。同一处 `auto: false` 也要按最终决定处理。

## 三、失败路径（见 `handback-acceptance-matrix.md`）

`holdClaimedInput` + `returnHeldInput` + `handBackInput` 一套 75 行，Team 测试当前**整链零覆盖**。
六条分支 + 两条时序不变量都在那份矩阵里。判据：**删掉对应分支，测试要红。**

## 四、阈值（见 `thresholds.md`）

`modelPolicies` 按路由生效、`retainRatio` 同步下调、触发点放在 idle 边界（`compactNow` 要求 idle）。

## 五、常规

- 断 cc 后 Member 仍可用（端到端起一个真 Member，不是只跑单测）
- 摘要产物质量（拿一段真对话压一次，人读）
- `scripts` 零额度不被撞破（A 不碰 scripts，但别顺手加注释）
- 全套 `npm test` 在最后一次改动之后跑；CI linux+windows 双绿

## 我明确不背书的

- "默认阈值跑 44 天没事"——那 44 天是 `auto: false`，不是引擎自动压缩。
- provider id 的具体值（我没猜过）。
- 长上下文能力是否受损（指标能测，但"够不够用"是产品判断）。
