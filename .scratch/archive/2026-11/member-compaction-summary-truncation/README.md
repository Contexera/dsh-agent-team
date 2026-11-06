# Member 压缩「summarization truncated at the token cap」——诊断与方案（已归档）

- **状态**：已交付并合入本地 `master`（2026-11-06）；Reeve 架构 review 关闭、Vera 独立验收通过。下文为交付时的诊断与方案快照，不再改写。
- **最后核对**：2026-11-06 11:55（合入 master 并归档）；11-05 23:59 的现场读数保留原文（Cole 已恢复，见「现场」）。
- **触发事件**：11-05 21:41–22:28，成员 @Cole 的会话连续 9 次压缩失败，UI 报「本轮运行失败 · summarization truncated at the token cap (incomplete checkpoint)」，成员完全不可用；Human 在切模型无效后报障。

## 一句话现象

成员会话越过 Team 的压缩阈值后，Team 让**该会话当前路由的模型**写一份摘要，摘要输出上限 **16384 token**；某些「思考型且啰嗦」的模型把整个上限花在 reasoning 上、正文 0 字，provider 回 `finish_reason=length`，Team 把这当成**本轮失败**，于是这个成员**每一轮都失败**，而且**换模型也切不过去**（切换前必须先压缩成功，压缩又用旧模型的 header）。

## 五件事（续接入口）

1. **状态**：现象已定位并可复现；临时解已生效——Human 11-05 把阈值从默认 256K 调到 **300K**（11-06 09:31 落盘，09:28 重启后为此值），Cole 恢复；**根因级修复未做**。
2. **最后核对**：2026-11-06 10:11。
3. **当前前沿（谁在做什么、卡在哪）**：
   - Vera：诊断、证据、可复现配方、候选方案和横向影响面已整理在 `materials/`；现按 9 条门独立验收，不参与实现。
   - **横向结论**：15 次截断 / 4 个成员（Cole 8、Tome 5、Aster 1、Ferry 1）/ 2 个模型（hy4free 14、step-5-preview 1）；真正卡死的是 Tome（≈1.8 h）和 Cole（≈1.6 h）。详见 `materials/cross-section.md`。
   - **现役风险**：Aster 仍在 `workbuddy/hy4free` 上（唯一活跃的）；09:28 他的会话已换代，但模型没换。
   - **方案与路由契约已闭合**：`spec.md` 记录 O1、能力门、pre-step 固定路由、按 step 暂存/清理和一次替代摘要；`issues/01-summary-target-and-bounded-fallback.md` 记录 9 条验收门。
   - **实施 Task**：Main-Dev task:80738be1-0eb2-4b01-a127-e2c7c9895e55（thread:5daf443f-a5b2-4492-add6-72614c6ac487），Tars 实现并带红→绿证据，Vera 独立验收，Reeve 负责架构决策与收尾。
   - **降级已定**：采用实际窗口内放行；同一 Agent＋对话路由＋摘要配置失败后跨轮断路，不得在后续每轮重复失败摘要。路由/摘要配置变化或手动 `/compact` 成功后复位；真实窗口不足仍 fail loud。
4. **完成条件（已满足）**：
   - [x] 有一处**能红**的测试或可复跑验收脚本，能在修复前重现「摘要被 reasoning 吃满 → 压缩失败 → 成员不可用」，修复后转绿；
   - [x] 选定的方案落地，含「摘要写不出来时成员不会被永久锁死」的退路；
   - [x] Vera 独立验收 + 维护文档更新（出口见第 5 条）；
   - [x] 临时措施（阈值 300K）可以回到默认值（或改成按模型配置）。
5. **正式文档出口（已落地）**：写在 `docs/team-collaboration/memory-and-context.md` 与 `.zh.md` 的压缩一节（摘要目标选谁、能力门怎么计价、暂存生命周期、失败后的放行与断路），另加 `CHANGELOG.md` Unreleased；本目录不定义产品行为。

## 现场（已恢复，可对照）

- 恢复路径：Human 抬高「默认压缩阈值」→ Cole 的 header 在 **23:04:56** 变成 `magpie/auto/deepseek-v4.1-flash`（切换终于落地）→ **23:13:28–23:13:59 自动压缩成功**（31 s、`maxTokens 16384`、摘要输出 2692 token、覆盖 285,505 token）→ turn 7–10 全部 completed。
- 也就是说：**换到能写摘要的模型就正常**——这是选型时最有用的既有事实，见 `materials/diagnosis.md` 的最小对照。

## 材料

- `materials/diagnosis.md` — 现象、时间线、根因链（含代码位置）、最小对照读数、已核 vs 推断、影响面。
- `materials/cross-section.md` — 11-06 横扫全部会话日志：15 次截断 / 4 成员 / 2 模型、每次失败的时长、各模型「输入 × 上限 × 输出」实测与现役风险面；300K 阈值已经 Human 确认，持久化疑点撤回。
- `materials/scan-compaction-history.py` — 复跑上表的脚本（25 秒扫完 330 个会话文件；只认 `compaction/end` 事件，按 `session/title` 归成员、按最近 `request/header` 归模型）。
- `materials/native-baseline.md` — DSH 原生会话的压缩行为（阈值 0.8×窗口、摘要预算 64K、三条失败路径），以及和 Team 的逐项对照。
- `materials/repro.md` — 从零复现的两条路：会话日志取证 + 直接打网关重放（含脚本 `materials/replay-compaction.py`）。
- `materials/options.md` — 候选方案 O1–O5 与取舍、待答问题、横向量算计划。
- `spec.md` — 已确认的方案、固定路由契约、能力门、有界退路与 9 条验收门。
- `issues/01-summary-target-and-bounded-fallback.md` — 端到端实施 Ticket；最终降级为真实窗口内放行＋同路由跨轮断路。

## 交付（2026-11-06）

- **分支**：`fix/member-summary-target`，四笔提交 `08999c48` → `ff58968d` → `f6e2b2c4` → `39972250`，以 fast-forward 合入本地 `master`；合并后主树 flow spec 复跑 36/36。
- **架构 review**：Reeve 逐笔读完四笔 diff 后关闭，无新增抛光项。
- **独立验收**：Vera 在自己的工作树里按 9 条门复核，flow 36/36、全量 2057 passed / 1 skipped；三项收尾（路由变化复位、pre-step reject/异常清理、中文尾随指令）各有一处反向改动使其单独变红。
- **实现要点**：摘要在能力门通过时写往该步骤的固定路由（`agent/pre-step.modelSelection` 按 step 暂存），显式摘要目标优先且全局/committed 的是 operator pin；首选失败只在选中的是 step route 时用已提交路由补一次，之后跨轮断路并在真实窗口内放行，配置或路由变化与手动 `/compact` 成功会复位。
- **默认值**：摘要预算 16384 → **32768**（`cordis.patch.yml` 的 `compaction-basic` 行），仍可按模型覆盖；为绕过故障临时抬高的 300K 阈值不需要保留。
