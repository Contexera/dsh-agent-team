# Review 03 — 完整验收推进

**Conclusion:** Incomplete
**Work item:** `.scratch/active/team-performance-optimization`
**Ticket:** Whole work item（01–03）
**Compared:** 主仓库 HEAD f4de5a0 与当前改动；相同评测工具覆盖旧新生产代码的独立 clean snapshot 对照
**Commits:** 主仓库未提交
**Reviewed:** 2026-10-30

## Findings

### P2 — running 快速返回改变部分读取后的通知语义（已修复）

**Location:** Host notifyMember 的 coverage 快速返回。
**Evidence:** 旧新测试在截断、steer失败、重试、派生失败、Agent替换后均一致，但部分读取后 running 旧路径生成第13条通知并花第14次attempt，新路径仅12条/13次。覆盖事实集合不同。
**Impact:** 仅凭现有coverage非空且undelivered空不能判断读取后是否需要重新派生，破坏原通知重试语义。
**Basis:** spec要求text/covered/undelivered/attempt与旧路径一致。
**Resolution:** 删除该快速返回，保留原重新派生流程；补硬断言和旧新差分。六个检查点现已完全一致。

### P2 — 性能场景未实现其声明的协作闭环及未读规模（已修复）

固定文本Agent回合替换为实际Team工具读写；冷启动改新Node子进程；fan-out为每个Thread建立关注之后再写真实未读事实，断言负载与声明一致。新场景契约测试覆盖这些事实，不设速度门槛。

### P2 — usage 生命周期恢复/移除统计遗漏（已修复）

subagent修复，主线程独立复核真实SQLite CLI测试与此前反例。真实profile只读备份重算后仍为23 enabled、8 archived、483 Attention Thread。

## Acceptance criteria

| 条件 | 结果 | 证据 |
| --- | --- | --- |
| 完整工具协作 | Met | cold/warm真实read/reply，各自receipt与模型可见结果核对 |
| fresh process及恢复 | Met（明确分段） | 新Node到空Host ready；另测两个Member重挂载恢复；SQLite独立测量 |
| clean版本矩阵 | Met | 14 case×before/after×31 samples；每次manifest dirty=false |
| 通知等价 | Met | 八个检查点全部等价：截断、steer失败、重试、派生失败、替换激活、读取后running、carried-input followup、recovery prefix |
| 延迟通知失败与换代 | Met | 八人batch中一人替换、一人失败，其余独立投递；后续重试通过 |
| 全量最终回归 | Not verified | 已有全量1543通过记录，但其后新增测试及撤回running，需重跑 |
| 性能回归结论 | Not verified | 首轮部分p95波动，交替版本复测进行中 |

## Checks run

- 核心baseline独立类型检查通过（继承tsconfig.types.json）。
- 既有三包typecheck通过。
- post-commit + wake swap/safety/windows：4文件23测试通过。
- 新场景契约、usage、post-commit：3文件18测试通过（随后新增1条队列换代测试）。
- 扩展前完整Browser10/10、build、artifact通过；最终生产变更后仍需复跑。
- docs与diff whitespace检查通过。

## Unverified scope and residual risk

- 首轮固定版本数据不支持笼统的“整体加速”或“无回归”。32 follower commit下降而total dispatch不一定下降，正在重复验证。
- before/after是独立临时Git快照commit，不是主仓库交付commit；其源码来源和覆盖文件须进入最终材料，不能把副本commit当上游历史。
- 不归档、不提交，等完整验收结论。

## Review record

- Spec sources: spec.md、issues/01–03。
- Standards: 根AGENTS、docs/AGENTS、.scratch/AGENTS。
- Uncommitted and untracked changes included: 是，所有性能实现、脚本、测试与文档。
- 当前详情：materials/closure-validation-2026-10-30.md；临时原始记录：artifacts/team-perf/closure-2026-10-30/。
