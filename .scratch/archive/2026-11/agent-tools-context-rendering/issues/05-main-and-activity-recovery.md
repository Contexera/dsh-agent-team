# 05 — Main 与 Task 变化采用一致的阅读恢复规则

**What to build:** Main 完整直接通知可支持正常 post；Task/Claim 事件完整提供后可支持对应操作重新判断，和 Thread Message 使用同一阅读原则。实现 F3 和 F4 的其它事实类型，不统一本来不同的权限与凭据。
**Blocked by:** 02、04
**Status:** complete

- [x] Main 通知完整提供全部必要事实后可 post，无需重复正文；Main 不新增 Thread revision 凭据；新的必要未读仍拦截。
- [x] Activity 按实际事件定义必要字段，完整提供操作者、对象及变化；看板当前状态、Thread card 和摘要不等同完整事件。
- [x] 通知、read/history/message、拒绝结果的同一事实使用一致判断；不依据来自哪种出口区别放行。
- [x] 阅读条件满足不写水位或消费 marker；显式 read 才确认，完整可见内容不重复；权限、Task 关闭、验收人资格仍由既有 Host 检查。
- [x] Main/Activity 长内容或多条变化未完整时走 04 的读取入口，不遗留另一种无限拒绝正文路径。
- [x] F3 通知→post→read 验证三种状态彼此独立；Task 变化→拒绝→重新判断覆盖 Message 与 Activity 混合未读及新变化到达。
- [x] 一次清理受影响的旧 recovery 句、凭据说法和专门绕过路径；更新正式双语工具、boundary、Attention/messaging 文档及相关 README/CHANGELOG。
- [x] 跑真实 Main/Activity ledger/Session 与 tool 测试；根据 Host/Remote 接口影响执行类型及 browser 检查，不以 render snapshot 单独验收。
