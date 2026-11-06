# Member 摘要目标与有界失败退路——已确认决策

**日期**：2026-11-06  
**状态**：选型、路由契约与降级形态已闭合；实施中  
**讨论**：评测 Project `thread:bb069bec-a2dd-402f-bdc9-f264034241ef`

## 范围

采用 O1＋能力门＋有界失败退路。按 Human 提高摘要预算的要求与 Vera 的最坏样本实测（65,536 上限下实际输出 18,804），默认摘要 `maxTokens` 从 16,384 调整为 32,768；O2/O3 暴露 Harness 已有配置手柄，既有重试默认值不变，不根据 `MAX_TOKENS` 自动提高上限，不修改 Harness。

- 首选摘要目标：显式 `summarizationProvider/Model`；未配置时，使用本步骤固定路由，但须通过能力门；不能用拟用模型时沿用已提交路由，最后才是 `AgentOptions`。全局或 committed policy 的显式目标是 operator pin，失败直接断路；step policy 的显式目标通过路由视图解析，先于 step 对话模型的能力门。
- 固定路由唯一来源：`agent/pre-step.modelSelection`。它按 Agent、按 step 暂存；admission 的 `proposed` 只做一致性断言，不是第二来源。
- 能力门：同一个 tokenMeter 量出的被压缩区间消息、实际工具声明与尾随 compaction instruction 开销＋本次实际解析的摘要 `maxTokens`（默认 32,768，按模型配置取最终值）必须严格小于拟用模型 `contextWindow`；恰好相等也不能承接。指令文本不作为第二份权威复制，可使用有依据的保守 reserve。
- 暂存清理：`step/end`、pre-step reject/异常均清理；同 step 重试与 overflow recovery 保留；手动 `/compact` 不继承。
- O1 选择 step route 后失败（包括 step policy 的显式目标经视图解析），只有已提交旧路由与 step 不同且尚未尝试时，才用旧路由做一次替代摘要；否则直接进入有界降级。全局或 committed policy 的显式目标失败直接断路，不改写 operator pin。不做模型轮转，不把现有显式摘要配置同时解释为首选和备用。
- 每个 `compactRegion` 至多 2 次摘要；Team admission 至多一个 region，Harness model-switch 保持既有 `compactionRetries + 1` 个 region，overflow recovery 保持既有 `maxOverflowRetries` 个 region。默认每步理论最坏 `2 + 2 × (1 + 1) + 2 × 1 = 8` 次；若实现证明路径互斥则记录更低实际上限。断路打开后同路由后续 turn 不继续增长。
- 最终降级采用实际窗口内放行，不做 Team 自有裁剪或第二套 surface replacement。完整输入＋必要输出余量必须能放进拟发路由的真实 `contextWindow`，否则以可见错误终止。
- 同一 Agent＋对话路由＋摘要配置在一次有界失败后进入断路：后续自动 admission 不再每轮重复失败摘要，只检查真实窗口并放行或 fail loud。仅在对话路由或摘要配置变化、手动 `/compact` 成功后复位；普通新 turn、工具续步和 surface 变化不复位。取消语义不变。
- 可见失败记录由失败事务的 `compaction/end.error`、进入断路与停止自动摘要的 Host warn、真实窗口不足时的 turn error 组成；本票不新增 Session 消息类型或 Client 渲染，专门成员状态展示仍属 O5。

同路由行为与前缀缓存保持不变。checkpoint 是模型中立格式，新模型续跑质量纳入验收。拟用路由只作临时调用上下文，不写账本、不提前提交 request header。

## 验收门

测试优先复用 `member-compaction-flow.spec.ts` 的真实请求流与假 adapter 的 `summaries[]`，先证明关键用例修复前能红。

1. 无切换长会话在首选与可用替代摘要都失败后，本轮请求仍发出并完成，有可见失败记录；失败后下一轮仍可用，且同一路由下摘要调用数不继续增长；真实窗口不足仍 fail loud。
2. 切换场景中，摘要发往通过能力门的拟用模型，切换成功落地。
3. 小窗口拟用模型不能承接时仍由旧路由摘要，保留原有切换拒绝或旧路由保留语义。
4. 显式摘要配置优先；step policy 的独立摘要目标先于 step 对话模型能力门，全局/committed 显式目标失败直接断路；失败后目标不泄漏，紧接着的手动 `/compact` 回到默认解析。
5. 失败退路新增的替代摘要至多一次，不做模型轮转，不改变既有 `compactionRetries/maxOverflowRetries` 语义。
6. admission 的 `proposed` 与 pre-step 暂存路由不一致时，在摘要前 fail loud。
7. `agent/request` 试图修改 provider/model 时，在摘要前拒绝。
8. `step/end`、pre-step reject/异常都清理；同 step 重试与 overflow recovery 仍读得到，手动 `/compact` 读不到。
9. 能力门使用同一 tokenMeter 的摘要输入＋本次实际解析的摘要 `maxTokens`（默认 32,768，按模型配置取最终值）；恰好等于拟用模型 `contextWindow` 时判不能承接。

## 非目标

- 不全局提高摘要 token 上限或压缩阈值。
- 不做 O5 成员状态与诊断 UI 专项。
- 不把 wake-recycle 引入本次默认退路。
- 不采用裁剪，不新增 Team 自有 surface replacement 事务。
