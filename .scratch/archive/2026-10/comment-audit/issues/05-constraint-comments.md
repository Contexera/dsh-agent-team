# 05 — 约束型注释的证明或清除

**What to build:** 仓库里所有 `do not remove` / `do not change` 一类约束型注释，要么被证明成立并编码成 type / test / lint 可执行的形式，要么删除并把未落实的约束挂起上报。

**Blocked by:** None — can start immediately
**Status:** complete

## 已定位的约束

| 位置 | 内容 | 现状 |
| --- | --- | --- |
| `packages/agent-team/src/types/entities.ts:81` | `capabilities.tools.allow` 是接口预留，"Runtime Revision manifests 依赖这个 seam，cleanup 时勿删" | 待证明 |
| `packages/agent-team/src/spec.ts:65` | 同上（zod schema 处） | 待证明 |
| `packages/agent-team/src/member-runtime.ts:110` | `memberRestrictions` 是"Runtime Revision 编排的原语" | 待证明 |
| `packages/agent-team/src/member-runtime.ts:152` | `applyMemberToolPolicy` 同上 | 待证明 |
| `packages/agent-team/src/member-skills.ts:9` | 每 Member skill provider 是"Runtime Revision 编排的原语" | 待证明 |

## 已知事实

- `capabilities.tools.allow` 是**活代码**：有 zod schema、有 `applyMemberToolPolicy` 消费、有 Remote 写路径、有 `member-tool-policy.spec.ts` 覆盖。
- 注释声称的"Runtime Revision manifests 依赖这个 seam"只在 `.scratch/archive/2026-09/member-runtime-architecture/` 的历史记录与 `docs/architecture/host-authority.md` 里出现，**没有对应的代码或进行中的计划实体**。
- `docs/architecture/host-authority.md:103` 与 `.zh.md:90` 同样写着 "do not remove during cleanup"，属于同一约束的另一处副本。

## 验收

- [x] 每条约束给出结论：证明成立（附证据）或不成立
- [x] 成立的约束给出最便宜的编码方案（type / runtime assert / test / lint），等 Human 批准后编码，再删注释
- [x] 不成立的约束：删注释，并把约束挂起上报
- [x] 同步处理 `docs/architecture/host-authority.md` 双语对中的同一句话

## 结论（2026-10-15）

**5 处约束型注释全部判为不成立，已删除。**

证据：注释声称的依赖方 "Runtime Revision manifests" 只存在于已归档且明确标注暂缓的设计中（`.scratch/archive/2026-09/member-runtime-architecture/spec.md` §"Phase 2 — Runtime Revision（暂缓）"、README "Runtime Revision / Plugin graph 热重载维持暂缓"），代码里没有任何对应实体、类型或进行中的工作项。`runtimeRevisionId` 等标识符只在该归档文档中出现。

**但 seam 本身是活代码，予以保留**：`capabilities.tools.allow` 有 zod schema、有 `applyMemberToolPolicy` 消费、有 Remote 写路径、有 `member-tool-policy.spec.ts` 覆盖。因此只删"未来 Runtime Revision 依赖它"这个无法证实的说法，保留描述当前行为的文档。

同一说法还出现在 4 处维护文档，一并改为陈述当前事实：
- `docs/architecture/host-authority.md` + `.zh.md`
- `packages/agent-team/README.md` + `.zh.md`

**未落实的约束**：无。删除的说法本身不成立，不存在需要保留的约束。

## 补充：约束本身由测试强制（2026-10-15 消融验证）

按 skill 第 5 步，约束"证不出 → 删并挂起上报；证得出 → 给最便宜的编码方案"。这里要区分两件事：

**"未来 Runtime Revision 依赖这个 seam" — 证不出**，已删。

**"不要删掉这个 seam" — 证得出，且已经由测试强制。** 消融验证：

| 消融动作 | 结果 |
| --- | --- |
| 从 `entities.ts` 的 `AgentTeamMemberCapabilities` 删掉 `tools` 字段 | 类型层消融，2 个 spec 仍 19 passed（类型被擦除，测试不感知） |
| 把 `spec.ts` 的 `tools` schema 字段改成 `z.undefined()` | `member-tool-policy.spec.ts` **10 failed / 3 passed** |

即：删掉这个 seam 会让 13 条测试里的 10 条变红。**约束已经由现有测试编码**，不需要新增 type / runtime / lint 编码，注释是冗余的第二道防线。

因此本项的最终处理是：删掉无法证实的"未来依赖"说法，保留 seam 与它描述当前行为的文档，约束由 `member-tool-policy.spec.ts` + `member-skills.spec.ts` 承担。

## 需要 Human 知晓的历史

这两处注释不是随手写的，而是 **2026-09-02 由 Human 明确要求的措辞**：

- `.scratch/archive/2026-09/member-runtime-architecture/issues/01-member-capabilities-schema.md:24`：「防误删注释：capabilities 字段声明、restrict apply 路径、schema 定义处注明"有意的接口预留：Runtime Revision 依赖此接缝，cleanup 时勿删"。**不带任何版本号措辞。**」
- 同文件 :46：「防误删注释按 Human 措辞要求」

且 2026-09-05 的简化审查报告把这几处 seam 判为"活代码或故意预留"，并称预留注释"与代码一致，无 doc rot"——但它核对的是"当前无 UI 写入路径"这个事实，没有核对"未来 Runtime Revision 依赖"这个预测。

如果 Human 希望保留一条**可证实的**提醒，建议措辞改为陈述已被测试覆盖的事实（例如指向 `member-tool-policy.spec.ts`），而不是指向一个暂缓的设计。
