# 06 — updateMember 改为局部更新（breaking）

**What to build:** 调 `updateMember` 时不带的字段不再被清空。要清除某个覆盖，显式传 `null`。

**Blocked by:** Operator 已批准破坏性变更；本 ticket 需在 CHANGELOG `Unreleased` 先记一条 Changed 再动代码
**Status:** complete

背景：`ledger.ts` 的 `updateMember` 刻意把 `model` / `capabilities` 从 `prior` 里摘掉
（`const { model: _priorModel, capabilities: _priorCapabilities, ...priorWithoutOverlays } = prior`），
注释写明「An absent model or capabilities field must CLEAR any override」。
所以省略字段 = 清空覆盖。类型注释也写明了这一语义。

危险之处在于它不是对称的：`model` 的清除在 UI 上有明确表达（「跟随全局默认」选项），
`capabilities` 的清除没有任何 UI 表达，纯靠调用方记得回显。
Client 编辑器已经踩过并绕开——它显式回显 `status.member.capabilities`（带注释说明原因），
这本身证明了该语义危险。

## 必须与 UI 同批改动的一处

`TeamMemberEditor` 的「跟随全局默认」现在是靠**不传 model**来清除覆盖的
（`...(model === undefined ? {} : { model })`）。改成局部更新后这个按钮会失效——
必须改成显式传 `null`。**不同批会留下一个点了没反应的按钮。**

- [x] 类型：`model` / `capabilities` 改为 `| null`，写明「缺省 = 不动；`null` = 清除」
- [x] `ledger.ts`：`nextModel` / `nextCapabilities` 三分支（省略取 prior、`null` 清除、有值则更新）
- [x] `freezeCapabilities` 无需改动——它本来就是 `undefined` 返回 `{}`
- [x] **UI**：`TeamMemberEditor` 改成 `model: model ?? null`
- [x] UI 的 capabilities 回显删掉，并**新增一条断言**：payload 里不含 `capabilities`
- [x] `assertModelSelection` 加 `null` 分支；`assertCapabilities` 用 `?.` 天然兼容 `null`
- [x] `index.ts` 的 `updateMember` 无需改（effect 判定读的是 `current` 与 `previous` 对比，天然适配）
- [x] 测试：省略 → 保持；`null` → 清除；显式值 → 更新；UI payload 真的带 `null` 且不带 `capabilities`
- [x] 现有依赖旧语义的测试修正 8 处，并给两处补上「省略即保持」的反向断言
- [x] CHANGELOG `Unreleased` 记一条 **Changed**，写明行为变化与迁移
- [x] 维护文档同步：`docs/architecture/host-authority.md`(+zh)、`packages/agent-team/README.md`(+zh)

实现注记（踩过的坑）：
- **必须先摘掉 `prior` 上的这两个字段再回填**。第一版写成 `{...prior, ...(nextModel === undefined ? {} : {model})}`，
  清除分支下 `...prior` 会把旧 `model` 原样带回来，`null` 分支等于没写。
  原来的 `priorWithoutOverlays` 解构是有原因的，重写时把它丢了——已恢复。
- **replay 碰撞校验**要放宽：旧语义下「省略」等价于「清除」，两者可比；
  新语义下「省略」是「保持不变」，记录里无法区分，所以只在请求显式给了该字段时才比较。
- 客户端 `sameModel` 要把 `null` 与 `undefined` 视为同一状态（都表示无覆盖），
  否则 `pendingRequest` 复用判定失效、每次保存都新铸 requestId。
