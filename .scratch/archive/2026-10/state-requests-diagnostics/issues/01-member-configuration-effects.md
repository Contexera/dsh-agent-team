# 01 — 成员配置保存与生效一致

**What to build:** 修改 Member 的运行配置后，调用方能区分配置已保存、正在等待生效、应用成功与应用失败；任何失败后的重试都补做未完成效果，不把旧提交当成执行成功。
**Blocked by:** None — can start immediately
**Status:** complete

- [x] 先复现能力配置提交成功、实际应用失败、同请求重试漏做应用的缺陷，再以真实可见的工具或 skill 行为验证修复。（正式回归在 member-tool-policy 规格里红跑复现后修复转绿：失败后工具面与改前逐项一致，同 requestId 重试完成未竟效果、无第二次业务提交。）
- [x] 明确调用方可观察的提交与执行结果，以及适用的重试语义；Member presence 继续表达运行可用性，不兼任所有配置阶段。（响应 `effect` 四值：applied／already-applied／deferred 带 no-live-handle 与 generation-changed 两个原因，失败保持响亮拒绝不进枚举；名册每行恒带 `capabilityState: applied|pending` 回答「stored 生效没有」，与 availability/presence 回答「会不会跑」正交；五个无活面状态字面 pending，有活面的按已应用记录推导。）
- [x] 重试不产生第二次业务提交；以当前期望配置为准，不让过期请求覆盖后来已经接受的配置。（账本按 requestId 早退幂等；运行时与回报状态改由 `getMember` 的当前行驱动而非重放行——红跑 t10：A 应用失败 → B 被接受 → A 重试，运行时与状态都不回退到 A；可空性由类型检查捕获，补了显式「成员不存在」守卫。）
- [x] 应用失败必须原子：Member 停在改前的有效工具面，绝不出现「旧限制已释放、新限制未装上」的更宽窗口（先装新限制、成功后再释放旧的，或失败回滚）。（实现取失败回滚：新装失败即恢复原 allow-list，恢复失败另有告警日志。）
- [x] 应用失败有可关联的请求、操作、Member、Session、阶段与原因；等待状态不会被报告为配置已生效。（抛出保持响亮；同一失败另存 `capability-apply` 结构化槽——detail 带 requestId/operationId/阶段/原因、sessionId 字段带上——经名册 diagnostic 露出，post-commit 失败日志带同一组关联 id；未生效一律报 pending，含推迟与失败回滚，成功落位或下次激活即清槽。）
- [x] 覆盖实际有运行效果的配置变更路径，包括工具限制、skills 选择和 model 选择；保留现有回合边界及同 Session 热更新约定。（工具面 t1–t14；skills＝member-skills 规格的 select/widen/clear 逐步读 live 目录，本规格新增停等回合中的编辑：当前回合不中断、目录按边界换、effect/capabilityState 不被绕过；model＝pin 后下一回合真实请求 `provider/model` 与改前同 sessionId、解 pin 回 Host 默认 provider/model 双断言。model 与 skills 两处均为覆盖性证据，首跑即绿——路径本来正确，票要的是把行为钉住。）
- [x] 验证第一次应用失败、重复请求、后续配置覆盖、Member 停止与重启后的行为；不以一个内存标志代替实际效果成功的证据。（分项：首败 t8/t9/t12；重复请求＝同 requestId 补做 t8＋过期重放 t10，「无二次提交」用账本序列号量；后续覆盖＝B 盖过失败的 A（t10）并清槽（t12）；停止/重启＝t3 的 suspend→resume→Host 重启，恢复后 `capabilityState: applied` 与真实工具面双断言，另有 member-lifecycle 的 recover/失败激活重启。所有成功证据都读真实面：工具 schemas、skills 目录、adapter 收到的请求。）
- [x] 同步受影响的 Remote 类型、Client 错误呈现和维护文档；若涉及可见交互，先给 ASCII 示意并按仓库流程验收。（Remote：typert 重生成，`updateMember.effect`、`memberStatus.capabilityState`、诊断 class 联合 + `capability-apply` 进类型声明；Client：闭合 `RISK_CLASS_KEYS` 补映射＋双语 locales 新增两键＋fixture 补字段；文档：host-authority 双语各加两条、CHANGELOG Unreleased 条目随 `c115317f`。ASCII 示意：`updateMember -> { receipt, effect: applied | already-applied | deferred:no-live-handle | deferred:generation-changed, status }`；`roster row -> { …, availability, presence, capabilityState: applied | pending, diagnostic?: { class: 'capability-apply', detail: 'requestId=… operationId=… stage=apply error=…', sessionId } }`。可见面（风险行新文案）按仓库流程归收口轮 test:browser，双方已约定。）
