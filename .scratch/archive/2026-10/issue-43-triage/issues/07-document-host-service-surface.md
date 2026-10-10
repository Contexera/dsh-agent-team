# 07 — ctx.agentTeam 现有接口面落成文档

**What to build:** 让「能否从外部脚本驱动团队、哪些接口有稳定性承诺」这个问题，看文档就能回答。不新增任何入口。

**Blocked by:** None — can start immediately
**Status:** complete

范围：**8a 放行，8b 不做。** Operator 的决定是「暂时继续保持 agent-team 在 dsh web 去使用」，
所以 CLI / loopback HTTP 一律不碰。本 ticket 只是给既有的东西背书。

现状：包无 `bin`、无 CLI。维护文档写明 Web Client 是唯一 Human control surface，
所有变更经 `ctx.agentTeam` typed Remote 下发。但**没有任何 API 参考**——
`docs/` 下 Service 方法面一行没提，README 只在讲 preset 行必须运行时解析它时顺带提了名字。
外部代码用 `ctx.get('agentTeam')` 属未文档化用法。

- [x] 在 `docs/architecture/host-authority.md` 加一节 **Host service surface**，
      不新建第三份 summary（落在 AGENTS routing 表指定的那一篇里）
- [x] 分清并标注**两类**：`@Remote` 装饰的（Client 契约）vs 仅 Host 侧服务方法（内部）
- [x] 明确写出：只有 Remote 那一组是契约，其余无向后兼容承诺
- [x] 代表方法点名 8 个 Remote + 3 个 Host-only，不逐方法罗列（避免和源码双写漂移）
- [x] 注明 `preset` 行必须在执行时解析 `ctx.agentTeam`、不能静态依赖
- [x] 中英两版同步
- [x] `npm run check:docs` 通过（28 pairs / 34 outlines）
- [x] 未引入任何二进制、CLI 或 HTTP 面

核对过的断言（不是凭印象写的）：
- 34 个 `@Remote` 方法；文中点名的 8 个逐个 grep 确认存在
- 3 个 Host-only 方法（`memberForAgent`/`membersForClient`/`status`）确认无 `@Remote` 装饰
- 两个包的 `package.json` 确无 `bin` 字段
