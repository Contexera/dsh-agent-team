# 03 — read 恢复讨论并确认已读，不重复已提供正文

**What to build:** 普通长度 Thread/Main read 根据当前上下文补必要背景、提供时间顺序的未读批次并确认对应内容；已完整可见的正文可以省略。无未读时仍能恢复讨论，覆盖 F2、F5 和 F3 的确认阶段。
**Blocked by:** 02
**Status:** complete

Thread 部分已于 `241f8f8` 提交；Main 的查询/直接通知正文省略、压缩后背景恢复与再次read已通过真实 Session 测试。读取与确认在队列内选择，Main 不会因后续 Task 卡遮住更早未读。详见实施记录。

- [x] 没有“继续/重入”模式参数：当前上下文有背景则以新增为主，缺少背景或无未读主动查看时补主题、少量最近原文、必要回复对象和当前 Task/Claim 状态。
- [x] 不用永久“曾读过”标记判断背景是否还在；不增加模型摘要调用；原文不足时明确继续读 history/message。
- [x] read 对已完整可见的事实说明本次确认及正文省略；新到或已不可完整见的事实正常提供，无每次回复后强制调用规则。
- [x] 背景、未读、当前状态、Thread card 分开表示；history/message、自动背景和通知不主动确认，不改变 Attention。
- [x] Host 的批次选择与确认范围一致，不在 read 已确认后由 renderer 删除必要正文；Human Remote 原有读取行为不因 Agent 背景策略改变。
- [x] 使用真实累计 Session 验证再次 read 不持续重复背景；压缩后无未读可以恢复，且无已读变化时不新增读 operation。
- [x] 保留历史 ledger receipt 的可重放性；如新增 Agent 读取选择，持久确认范围可由记录确定，不依赖 replay 时的 Session。不得直接修改旧固定批次解释。
- [x] 首次 read→查看分工→claim 与压缩后 read→继续工作均有端到端证据；更新相关双语读取、上下文和 Host 文档及 CHANGELOG。触及 Remote/assembled Web 时执行 browser 检查。
