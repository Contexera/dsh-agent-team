# 04 — 断 cc + 删模型换代面：rollover 工具、handoff 通道、门控/检索/回退全删

**What to build:** `package.json` 不再有 `@contexera/dsh-context-continuity` 和 `@contexera/dsh-jev`；仓内无任何 cc import。**模型可见的 context 工具一个不剩**（v2：连 `context_rollover` 也删，模型不再有换代决策权）。handoff 简报通道（`handoffMessageFor`、新代首条 steer）删除——新代第一眼 = 现有每步注入的身份+memory.md+workspace 列表+唤起消息，无任何换代公告（raft v2 教训：13/13 canary 把公告当仪式执行）。门控/jev/judge、检索工具、checkpointRef 回退、status、advice 三档全部移除；设置页 contextJudge 段与 judge 表单移除。
**Blocked by:** 01, 02, 03（自持换代、投影、引擎子类都就位后才能抽掉 cc）
**Status:** complete

**Outcome (2026-10-21):** 已落地。仓内无 cc import，模型侧 context 工具、handoff 简报、judge/jev、advice、checkpointRef 回退与设置页 judge 段全部移除；旧 operation schema 与旧日志解码保留。

- [x] 删 `packages/agent-team/src/{context-continuity-host.ts, context-judge.ts, compaction-engine.ts}`；`index.ts` 的 coordinator 调用收缩后改接 01 的自持协调器；`package.json` 删两条依赖；`scripts/continuity-dir.mjs` 与 `generate-typert.mjs` 的拷贝段删除
- [x] 工具面：`tool-agent-team/src/context-tools.ts` 整文件删除；`AGENT_TEAM_TOOL_NAMES` 收缩掉全部 context 工具名；persona/指导文案同步删除对全部 context 工具（含 rollover）的引用；`member-runtime.ts:58-63` 工具允许表同步
- [x] 删除 `requestNewContext`（`index.ts:2851`）与 `handoffMessageFor`（`:1626`）及新代首条 steer 链路
- [x] Host 行配置删 `jev`/`gate` 组（schemastery schema、volatile 更新路径、`contextJudge` Remote）；设置页删 contextJudge 段
- [x] **顺序约束（Vera 实测）**：先删 `context-judge.ts`（37 行注释）与 client `judge-form.ts`（80 行注释），再改设置页/其他会加注释的地方；不顺手抬注释额度
- [x] checkpointRef 回退路径删除：投影里 restorable 判定消费方、相关渲染
- [x] advice 整档删除（`contextAdviceFor` 的 `compact-now`/`rollover`/`keep`）：换代不再由模型发起，advice 失去对象；渲染端与测试同步（`tool-agent-team/src/index.ts:72-121,433,513,567,624-646`）
- [x] `reconstructMissingHandoff`（`index.ts:2541-2580`）删除：崩溃恢复时向新代 steer「Context handoff: …」正是 v2 禁止的仪式文本
- [x] 残留面补全（审查发现，票外易漏）：`recovery-hints.ts:156-161` 两条 hint + `recovery-hints.spec.ts:34-35`；`cordis.patch.yml:87-90` persona 整段；`slots.ts:120` 注释；`team-ui.e2e.ts:776`；`member-lifecycle.spec.ts` 67 处提及；client `index.ts:516` 的 jev secret 路径。**别删过头**：transition 诊断（`index.ts:3393` / `locales.ts:471` / `TeamPresenceDot.tsx:23` / `TeamAgentsPanel.tsx:51-98`）v2 仍要显示换代窗口，保留
- [x] durable schema 只停生产、保留 decode（`spec.ts` strict 联合，删旧成员会让旧库打不开）；旧 profile 残留的 gate/jev 配置值无害（schemastery 非 strict，未知键透传不炸启动），但迁移说明要点名 `jev.apiKey` 明文残留
- [x] 新 Host 行配置 `wakeRecycle` 组必须 `.volatile()`，否则设置页写不进（`index.ts:410-420`）
- [x] `shipping.spec.ts` 版本断言更新；`docs/team-collaboration/memory-and-context.{md,zh.md}`、README 双语、CHANGELOG 同步
- [ ] 真实 profile 验收（未做，需真实模型与人工预览）：成员挂载、唤醒换代、自动压缩三条链路可用
