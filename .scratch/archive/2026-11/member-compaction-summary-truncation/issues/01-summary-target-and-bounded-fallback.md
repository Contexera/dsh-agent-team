# 01 — 摘要目标、能力门与有界失败退路

**What to build:** Member 长会话在切换模型或摘要反复截断时，能选择可读入历史的正确摘要目标，并在有界尝试后继续本轮请求、留下可见失败记录，而不是每次 admission 都锁死。
**Blocked by:** None — can start immediately。最终降级采用真实窗口内放行，并带同路由跨轮断路。
**Status:** done — 合入本地 `master`（`39972250`），Reeve 架构 review 关闭、Vera 独立验收通过

- [x] 无切换长会话在可用摘要尝试都失败后，本轮请求仍发出并完成，有可见失败记录；下一轮仍可用且同一路由摘要调用数不增长；真实窗口不足仍 fail loud。
- [x] 切换场景中，摘要发往通过能力门的拟用模型，切换成功落地。
- [x] 小窗口拟用模型不能承接时仍由旧路由摘要，保留原有切换拒绝或旧路由保留语义。
- [x] 显式摘要配置优先；step policy 的独立摘要目标先于 step 对话模型能力门，全局/committed 显式目标失败直接断路；失败后目标不泄漏，紧接着的手动 `/compact` 回到默认解析。
- [x] O1 选择 step route 后失败，仅用不同且未试过的已提交旧路由做一次替代摘要；全局/committed 显式目标失败直接断路，无可用替代则直接降级，不做模型轮转。每个 region 至多 2 次，默认每步理论最坏 8 次（或记录路径互斥后的更低上限），测试用 `summaries` 断言精确次数。
- [x] admission 的 `proposed` 与 pre-step 暂存路由不一致时，在摘要前 fail loud。
- [x] `agent/request` 试图修改 provider/model 时，在摘要前拒绝。
- [x] `step/end`、pre-step reject/异常都清理；同 step 重试与 overflow recovery 仍读得到，手动 `/compact` 读不到。
- [x] 能力门使用同一 tokenMeter 计算本次区间消息、工具与尾随指令开销＋实际解析的摘要 `maxTokens`（默认 32,768，按模型配置取最终值）；恰好等于拟用模型 `contextWindow` 时判不能承接。
- [x] O2/O3 仅暴露现有手柄，默认摘要预算按 Human 要求调整为 32,768，既有重试默认值不变；关键测试有红→绿证据，维护文档与 CHANGELOG 同步。

## 每步摘要调用上限（实现口径，2026-11-06）

`compactRegion` 至多 2 次摘要：步骤路由一次，加上已提交路由一次替代；替代预算**按 step 共享**，不按 region 计。
外层路径沿用既有语义：Team admission 至多 1 个 region、Harness model-switch 至多 `compactionRetries + 1` 个 region、
overflow recovery 至多 `maxOverflowRetries` 个 region，所以结构上限是 `region 数 + 1`，默认配置算作 8。

但任一次双层失败都会在该路由上打开断路，之后**所有自动摘要**（含 model-switch 与 overflow recovery 路径）
不再调用模型，只有显式 `/compact` 仍会真正尝试。因此默认配置下的**可达**上限是每步 2 次自动摘要，
同路由后续 turn 为 0；8 只是结构上限。用例按可达值断言（`member-compaction-flow.spec.ts` 的
「pays for at most one region and its one alternative per step」）。

## 断路的复位口径（2026-11-06 补，第三轮 review）

开路记录点名「失败的那条路由」。`agent/pre-step` 绑定步骤路由时，若记录里的路由与本次不同，旧记录立即删除：
它描述的是一条本步不会走的路由，留着会让 Agent 回到旧路由时继承一次与它无关的暂停。因此
A 失败 → B 承接成功 → 回到 A 可以重新摘要（用例 `tries the failed route again once another route held the summary`）；
同一路由连续轮次仍保持暂停。摘要配置变化会重建引擎（配置不可变），WeakMap 随之清空；手动 `/compact` 成功仍单独删除记录。

生命周期两条直接门：pre-step `reject`（turn 结束为 `blocked`）与 pre-step 抛错（turn 结束为 `error`）之后，
紧接的手动 `/compact` 都解析回已提交路由，证明暂存没有泄漏。
