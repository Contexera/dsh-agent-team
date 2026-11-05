# Agent 工具与上下文呈现

**状态：已归档（2026-11-05）。** 实施、确定性验收与生产输出形状核对完成，全部随 v0.2.6 发布；**07 的付费模型理解评测始终未运行**——未获授权模型配置与费用，按「未做项明确记录」收口，不声称模型验收通过。2026-10-29 Human 确认设计与六段流程后授权实施、subagent 分工和阶段性提交。此前五票提案仅作历史材料。

**最后核对日期：2026-11-05（归档时）。** 实施起点 `deaa671`，07 交付止于 `805394f`（`b1af731` 后补文档审查修正），全部已在 `origin/master` 与 tag `v0.2.6` 内（逐个 `git merge-base --is-ancestor` 核过）。仓库 HEAD 现为 `634c1e8`（v0.2.6 之后 39 个提交，属订阅/提醒/inbox digest 三条新线，非本工作项）；本工作项 harness 在该 HEAD 干净树上**从归档位置**复跑通过（归档后相对路径已按新深度重写并实跑验证）。11-04/11-05 补做了「模型看到的输出形状」的生产日志核查（[证据](materials/2026-11-05-production-result-quality.md)），那是 07 免费的一半；付费的一半（模型理解）仍未运行。工作区原有性能工作项的 `package.json`、Host 通知派发及性能基准脚本修改，实施不得覆盖。

**归档提交形态的偏离说明**：`.scratch/AGENTS.md` 要求在关闭工作项时把归档移动 amend 进交付提交，让归档记录实际发出什么。本工作项的交付提交（`805394f`、`b1af731` 等）早已随 v0.2.6 进入 `origin/master`，改写已发布历史被禁止，因此归档作为独立的 `docs:` 提交落在 tip，并在此写明它对应哪个版本。这是偏离，不是遗忘。

**归档时仍开放的两项**（不阻塞归档，如实记录）：① 真实模型理解评测（07 未勾项，需付费授权；harness 与合成场景已备好，接上模型配置即可跑）；② 分段续读在真实使用中零触发，该承诺目前只有回归测试证据。

## 继续从这里读

1. [spec.md](spec.md)：已确认的行为和工程约束，当前设计唯一入口。
2. [六段完整流程](materials/2026-10-29-accepted-flows.md)：前后输出示例及验收矩阵。
3. [工程核对](materials/2026-10-29-implementation-notes.md)：现有 Session/tool 能力、读取重放约束和旧方案替代关系。
4. 下表中的实施票：按前沿进入，不从旧 Thread 或旧提案推断授权。

## 已确认目标

让 Agent 正确理解状态并完成协作，然后减少重复上下文和无效调用。记忆与身份分类更新；read 能恢复讨论背景；完整可见事实可满足阅读条件；显式 read 才确认已读；长消息可续读而不误确认；通知和结果说清实际状态；规则统一定义但允许必要短提醒。

工程细节由实施者把握，复用现有工具和 Host 能力，不建通用上下文框架、独立已读事实库或两套策略开关。

## 实施顺序

| 票据 | 交付行为 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [01](issues/01-member-context-updates.md) | 背景分类更新与压缩恢复 | 无 | complete |
| [02](issues/02-thread-rejection-recovery.md) | Thread 拒绝提供真实恢复路径 | 无 | complete |
| [03](issues/03-read-and-reentry.md) | read 补背景、确认并省略已提供正文 | 02 | complete |
| [04](issues/04-long-message-continuation.md) | 长消息续读与精确确认 | 03 | complete |
| [05](issues/05-main-and-activity-recovery.md) | Main/Activity 一致的阅读恢复 | 02、04 | complete |
| [06](issues/06-notification-context.md) | 通知优先级、预算与正确读取指引 | 05；先核实性能工作项通知路径 | complete |
| [07](issues/07-tool-guidance-and-acceptance.md) | 七工具规则整理与联合验收 | 01–06 | 非付费部分 complete；付费模型评测未运行（归档时如实保留） |

ready 仅表示依赖满足。Human 已授权本轮实施；各票完成仍须有实际测试与审查证据。实施起点的 typecheck 已通过；真实模型评测始终未运行，也未建立新性能结论——归档不代表这些已通过。

## 归档时前沿

- 01提交`56e5a92`，02与03 Thread提交`241f8f8`，03 Main与04续读提交`1e95b83`，分支`feat/agent-context-reading`。03/04验证1489测试通过/1原有跳过，browser11/11。05已提交`6b6b7f2`：Main完整通知/拒绝可post，Thread与Main Activity使用不可变事件绑定，显式read确认时省略已完整提供事件；真实工具闭环与混合新未读测试通过。最终1505测试通过/1原有跳过，browser10/10（性能browser移出常规套件），Main双尺寸截图正常，类型/文档/产物检查通过。06已提交`05bf168`：新缺失direct优先，已完整事实省略正文，恢复包装含在总预算，Main归属与回复对象明确，reminder省略可查。独立审查发现的问题均有真实测试和修正；最终1519测试通过/1原有跳过，类型/文档/lint通过，改动文件无新增warning。本票不影响UI/Remote/组装，未重复browser。07非付费部分以`b1af731`提交：七工具规则、旧模型输出及文档矛盾清理，真实Host地址检查、F2已有Claim分工和F1–F6回归完成。最终134files/1525tests通过，1原有跳过；类型、lint、文档规则通过，本次文件无新warning，Host/tools构建及真实Session快照组合通过。独立审查完成，主线程加强异Thread双ref测试纠正了共同误判；没有新增权限限制或第二套读取状态。详见[harness说明](harness/README.md)与[验收核对](materials/2026-10-30-acceptance-plan.md)。仅剩真实模型重复样本验收，配置/费用尚未授权。（2026-11-05 归档：该付费评测最终未获授权，按未运行记录，见文首状态。）
- 02 已用真实 Session 与工具→Host 闭环证明事实识别，无正文子串匹配或独立已读状态。最新验证见 [实施记录](materials/2026-10-29-implementation-progress.md)。
- 03/04 涉及返回范围与确认范围，必须照顾旧 ledger receipt 重放，不能只在 Agent renderer 裁剪。
- `team-performance-optimization` 2026-10-30核对入口确认四处生产优化：同次notificationFacts缓存、Thread/Main notificationSnapshot复用Main未读派生、deliveryPlan复用、已有coverage的running边沿不重读；异步fan-out仅原型。上述四处仍未提交，06只能保持这些逻辑，在文本选择/预算内改动；若再改派发段，须先核实并行状态。
- 无待 Human 决定的常规字段、预算或模块细节。只有现有公开 interface 无法承载已确认行为时，再报告具体限制。
- **2026-11-05（Vera，归档日）**：07 欠的「输出形状」半已用生产日志独立核完并落成本工作项材料——[materials/2026-11-05-production-result-quality.md](materials/2026-11-05-production-result-quality.md)（五轴聚合数字、按天归因、假阳性交代）。**同日按「未获付费授权」收口归档**：脚本已从审阅者私有目录提升为 [harness/production-result-quality-scan.mjs](harness/production-result-quality-scan.mjs)，任何人可复跑；JSON 输出默认写到仓库外，因为它含拒绝样本与结果正文片段即真实内部讨论，而本仓库公开。若要补做付费模型理解评测：接上获授权的模型配置重跑 `harness/` 下的合成场景即可，无需重建。

## 完成条件

- [x] Human 确认目标、具体行为、六段完整流程与工程自主决策原则。
- [x] 新设计、流程、工程核对与依赖有序的七张票据已整理。
- [x] 01–06 的行为逐票实现、测试及相应正式文档同步。
- [x] 07 的六段组合流程在真实 Session/工具组合中完成，无未解释的正确性回退。
- [ ] **未完成，如实保留**：获授权模型理解评测（付费）。
- [x] 记录同场景上下文占用与重复输出，并在生产日志里核过实际去重命中与回执体量；不把历史累计字符当真实请求费用。**未测 token、真实请求费用与真实模型目标完成率。**
- [x] 清除被替代的代码路径和矛盾规则；保持普通 Session、Human Client 与历史 ledger 可用。
- [x] 结论移入正式文档后归档本工作项（2026-11-05 归档至 `archive/2026-11/`）。

## 正式文档出口

依实际改动更新双语 `docs/team-collaboration/{tools,boundaries,memory-and-context,attention-and-messaging}`、`docs/architecture/{host-authority,tools-and-preset}`、相关 package README、persona/core skills 和 CHANGELOG。不提前把尚未实现的行为写入正式文档；只有职责变化时才改 package ownership，不借此重写 domain model。

## 历史资料

- [SCOPE](SCOPE.md)：原始范围，已标记由新 spec 替代。
- [旧提案及两轮修订](materials/2026-10-28-baseline-and-proposal.md)：语料与旧方案，不是批准的实现。
- [旧七工具契约清单](materials/2026-10-29-seven-tools-contract-inventory.md)：当时源码盘点，新行为需重新核对。
- [旧票据说明](materials/2026-10-29-superseded-tickets/README.md)：原五票原样保留，编号和状态仅代表历史。
- [原始度量输出](materials/2026-10-28-baseline-output.txt)：保留历史结果；[harness](harness/README.md) 已增加真实Session快照与分段/分类量测，旧个人日志扫描不作为当前验收。
- [Attention 来源工作](../../2026-10/attention-delivery-model/README.md)、[既有模型评测](../../2026-10/team-tools-model-eval/README.md)：复用证据和工具，不重复建设、不照搬归档配置或凭据。
