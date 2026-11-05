# 01 — 连续工作不重复背景，压缩后恢复当前信息

**What to build:** Member 初次工作或背景缺失时得到完整起步信息；工作中只收到对应类别的变化，memory 更新不重发全文，责任或 Workspace 撤销仍明确呈现。实现完整流程 F1，不改变普通 Session。
**Blocked by:** None — can start immediately
**Status:** complete

验证：真实 Session 分类注入/投影/恢复测试与 Host/tools 回归通过；固定 synthetic 场景已重跑，详见实施记录。

- [x] 连续多步使用真实累积的 Session surface；无变化不追加，memory 修改后只追加一次提示，后续不退化为每步重发。
- [x] identity、ownership、Workspace 分别更新；完整当前列表替代对应旧列表，覆盖撤销为空和多 Workspace 缩为一个。
- [x] ownership/Workspace 变化不重发 memory，memory 更新不重发其它类别；不保留第二套注入策略或开关。
- [x] memory 的完整基线与后续更新提示分别识别；压缩后仅剩提示时补最新完整基线，而不是误认为背景齐全。
- [x] 索引删除、不可读、超预算均说明当前异常和入口；保留现有预算与记忆权限，不要求每次自己写完再读取。
- [x] 删除动态块中不必要的稳定教学，保留使用路径等基本事实；本票只调整自身文案，不提前大改全局 persona。
- [x] 更新 member-memory/context 和 Host authority 的正式双语说明及相关 README、CHANGELOG；不把未落地的其它票写成现行行为。
- [x] 同一固定场景比较注入次数、重复正文与当前 surface 占用；不沿用历史 80% 指标作为成功门槛。跑窄的注入与恢复测试，覆盖 F1。
