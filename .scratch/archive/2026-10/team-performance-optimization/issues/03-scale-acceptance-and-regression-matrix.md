# 03 — 完成规模验收和性能回归矩阵

**What to build:** 运行固定版本、固定负载的矩阵，对照端到端与分段p50/p95/p99、通知事实和构建体积，确认实际收益、代价与未查明的长尾，而不是把所有优化都预设为更快。
**Blocked by:** 02
**Status:** complete

- [x] 默认15个case覆盖内存/SQLite的1/20/100Thread、日常1–4额外follower、8档延迟通知及32档压力；固定版本14个对照case各31样本+3warmup
- [x] 完整Agent工具协作同时覆盖cold/warm回合；两次read、两次持久reply、六次接收者模型请求
- [x] 独立测量新Member activation、已有Session resume、新进程Host ready、两个持久Member恢复及Session inventory
- [x] 覆盖通知失败、Thread读取/回复、Task start和DM；语义探针检查失败重试、大小批次顺序、Client invalidation和关闭取消
- [x] 分别记录commit ack、notice queued/claimed、read/reply committed、idle、调用标识与operation数；总派发完成不等于commit返回
- [x] fan-out通过真实未读填充和数量断言，排除只创建Thread没有积压的假负载
- [x] 比较器自动测试正常、回归、无效分位数、零基线和完全空测量；指定门槛时不能无证据通过
- [x] 对五个波动case三轮交替版本复测，各31样本+5warmup；SQLite同文件另外四轮控制实验
- [x] 如实记录代价：大批次commit等待稳定下降，但total dispatch不保证改善；SQLite原始长尾差异未稳定复现，原因未查明。详细结果见materials/final-performance-results.md
- [x] 最终全量tests（1548通过、1跳过）、typecheck（含Node性能脚本）、build、artifact、Browser（10/10）及最终矩阵（15/15）均通过并核对构建体积

## 性能结论

原票希望所有p95都无回归。实际对照不支持这个笼统结论：延迟派发允许Agent工作交错，总完成时间会有代价；不能把它隐藏在commit收益中。保留队列的目标是减少调用方阻塞，保留单次派生复用的依据是确定性调用次数减少。没有因为长尾再增加缓存、合并层或改变Host恢复顺序。

运行方法与限制在正式性能文档；固定版本来源、复现命令和逐轮结果在materials/closure-validation-2026-10-30.md与materials/final-performance-results.md。最终交付检查以reviews/04为准。
