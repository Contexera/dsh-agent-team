# 08 — 团队管理的两份内置 skills

**What to deliver:** 管理会话用 `team-management-guide` 与 `team-operations` 两份内置 skills 教 Human 按持续责任与 Team 协作，并能按 04–06 已交付的工具执行责任建立、调整和恢复流程；内容以现行维护文档和[定位与责任原则](../materials/product-principles.md)为来源，随 bundle 只读发布。

**Blocked by:** 04, 05, 06, 07

**Status:** pending

**Required context:** [设计快照](../spec.md) 的「产品原则与首版定位」「记忆、笔记与 skills」；[定位与责任原则](../materials/product-principles.md)；[流程与引导参考](../materials/flows-and-guidance.md) 第 2、4 节；04–06 交付的工具契约和 `docs/team-collaboration/tools.md`。

**Boundaries:** 只做两份内置 skill；不复制 `member-memory-manager` / `member-skill-manager` 教程；不宣称无需 Human 发起的自主发现、主动巡视或读取私有对话；不新增引导界面；不把内容拆成互相重复的碎片。

- [ ] `team-management-guide` 覆盖 Team 的长期价值、Project/Domain 区别、长期 Member 的 owner 责任、owner 主动推进与 Worker 并发、Human 直接与领域 owner 协作、独立验收，以及一条完整的责任建立和交接示例；明确一次性任务不扩编、独立验收不默认创建测试成员。
- [ ] `team-operations` 覆盖读取 → 责任方案 → 确认 → 写入 → 回执/续做的操作顺序、模型/能力、故障恢复、责任更新、Project 归档和私有资产纪律；内容与 04–06 的实际工具参数和拒绝语义一致。
- [ ] 两份 skill 通过现有文件发现规则加载，内置目录优先于私有同名 skill；纳入 `scripts/check-core-skills.mjs` 的静态检查，内部链接可解析。
- [ ] Human 阅读后能按持续责任组织 Team，而不是按职能机械扩编；记录一次内容评审结论和仍需补充的例子。

**Evidence to return:** 新增/修改的 skill 文件、静态检查与链接检查命令及结果、Human 阅读结论、未验证范围。
