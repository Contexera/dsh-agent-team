# 03 — addMember 拒绝未注册的 provider

**What to build:** 用一个不存在的 provider 建成员时，当场被拒绝并说明「该 provider 未注册」，而不是先创建一个注定失败、且首回合死因还是另一条消息的成员。

**Blocked by:** None — can start immediately
**Status:** complete

范围决定（Operator 已确认）：**只做「provider 未注册」这一层，不做创建期模型探测。**
不发真实请求去验网关——成本是真的，且各家网关行为不一，容易把能用的路由误判成不可用。

背景：`assertModelRoute` 只在显式给了 `reasoningEffort` 时查元数据，且不检查 provider 是否存在。
实测 pin 到不存在的 provider 时 `addMember` 返回 `active/available`，首回合的失败却是
「context pressure policy: the routed model capacity is unknown …」——另一条消息，
看不出真正原因是 provider 不存在。

- [x] `assertModelRoute` 在 provider 未在 `ctx.llm` 注册时直接拒绝
- [x] 拒绝文案点明是 provider 未注册：`provider 'x' is not registered`
- [x] 没有 provider/model 覆盖、走 Host 默认继承的成员不受影响
- [x] 两个入口都覆盖：`addMember`(1122) 与 `updateMember`(1611) 共用同一个 `assertModelRoute`
- [x] 测试：未注册 → 拒绝（两个入口）；已注册 → 通过；默认继承 → 不受影响
- [x] CHANGELOG `Unreleased` 记一条 Fixed

实现注记：
- 用 `ctx.llm.listProviders().some(p => p.id === ...)`，与 Harness `catalog.ts:81` 的既有写法一致。
- `ctx.llm` 在部分测试里是 undefined，故用 `?.` 并仅在能列出 provider 时才校验——
  这与下方 reasoningEffort 分支「查不到就交给运行时」的既有取舍一致。
  （第一版没加保护，跑全量时挂了 1 条 display-fact 用例。）
