# 01 — 活模型评测 runner

**What to build:** 一条命令可复跑的评测：在隔离 Host（memory pool，不碰真实账本）上播种一个 Project、若干成员与若干 Thread/Task，把七个 Team 工具的真实 schema 通过本机 proxy 呈给 `auto/gpt-6.1-sol`，按场景脚本驱动模型完成典型成员工作（收件箱分诊、读 Thread 回帖、看板领 Claim、Main stream 发帖），全程记录每次工具调用的参数、结果类别（成功/业务拒绝/抛错）与恢复轮数，产出按工具的指标报告。

**Blocked by:** None — can start immediately

**Status:** complete（Task #4 于 10-28 11:15 被 Human accept；可选后续扩展见 README「Human 回来后的回归验证清单」第 3 条，不列为 blocker）

- [x] 隔离 Host 可 boot，工具可执行（冒烟：不走模型，直接 execute 一次 read）
- [x] 七个工具的 schema 以 OpenAI tools 格式送达模型，模型可发起工具调用
- [x] 场景脚本 10 个（inbox 分诊 / 读+回帖 / 看板+claim / 发帖 / view / DM / 长历史翻页 / 已被 claim 的 Task / 回复指定消息 / 关注 Thread / 列 Claims）
- [x] 指标：按工具×action 的调用数、拒绝率、恢复轮数、空串/多参习惯计数
- [x] 输出落 `.scratch/local/team-tools-model-eval/`，报告人可读
- [x] 重复跑出发生率（累计 144 次调用：4 例抛错同族——序号当 ref；指引决定恢复）
- [x] 坐实缺陷的修复已落：`a03c0a0`（`ledger.ts` readMessage 家族四个抛点补恢复指引；变异验证 + 失败点探针 + 全门禁；行为级恢复现场未诱发出，见 materials 遗留 1）
