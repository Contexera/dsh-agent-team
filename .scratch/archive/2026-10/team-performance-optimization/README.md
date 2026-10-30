# Team 性能优化

**状态：** complete，issues/01–03 已完成；随实现、测试和正式文档一同归档提交，不推送。

**最后检查：** 2026-10-30

**当前前沿：** 无未完成票。最终验收见 [Review 04](reviews/04-team-performance-optimization-recheck.md)；未把未完成范围拆成后续工作。

**完成条件：** 全量功能测试1548通过、1跳过；类型检查（含Node性能脚本）、build、artifact、Browser 10/10、基线16场景48样本、矩阵15/15与通知语义5/5均通过。桌面和390×844截图已检查。

**正式文档出口：** [性能评测](../../../../docs/development/team-performance.zh.md)、[Host authority](../../../../docs/architecture/host-authority.zh.md) 与 [Changelog](../../../../CHANGELOG.md)。

## 交付结果

- 保留单次通知内的Thread/Main读取与delivery plan复用；大批次在提交及Client invalidation后按Member顺序派发，后续小批次不得插队。
- 撤回`running` coverage快速返回：旧新差分发现部分读取后会漏掉重试。修复后八个通知检查点完全一致，另有换代、单Member失败和关闭取消回归。
- 补齐真实Agent工具read/reply冷/热闭环、新Node进程启动、两个持久Member恢复与真实未读负载；usage状态折叠和比较器空结果错误已修复。
- 相同脚本的固定版本对照、三轮重点复测、同一SQLite文件控制实验均完成。批量提交等待稳定下降，但全部派发完成时间不保证下降；SQLite原始长尾差异原因未查明。

详细数字见 [最终性能结论](materials/final-performance-results.md)，复现方法见 [收尾验证记录](materials/closure-validation-2026-10-30.md)。

原始决定保留在spec.md；materials/保留研究与未采用方案。Review 01–03是过程记录，最终状态以Review 04为准。原始样本、临时数据库、日志和日常截图不进入归档。
