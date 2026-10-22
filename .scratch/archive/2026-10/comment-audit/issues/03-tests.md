# 03 — 测试文件注释清理

**What to build:** `packages/*/tests/` 下经审查确认不成立的注释被删除，测试行为与通过数不变。

**Blocked by:** None — can start immediately
**Status:** complete

- [x] 按机械校验后的条目判定测试文件的删除条目（135 条通过机械校验）
- [x] 保留：指向外部 issue 编号的注释（第 5 类）、外部协议/平台的强制行为（第 2 类）
- [x] 保留：解释"这个测试钉住的是哪个真实回归"的注释——它记录的是不可从代码推出的历史约束；只删复述断言的旁白
- [x] 删除后 `npm test` exit 0，通过数与删除前一致
- [x] 未触碰 `packages/client-agent-team/tests/` 中 3 个工作区既有改动文件
