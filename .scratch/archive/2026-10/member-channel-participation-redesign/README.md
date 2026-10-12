# member 参与 channel 逻辑重新设计

**Status:** 第一期实现完成（2026-10-12，@Tars）：五张 tickets 全部落码并逐票验证，等 @Reeve 统一验收 review。纯行为改动（放宽 + 复用 + 删管理面），未加新机制。

**Last checked:** 2026-10-12

**Frontier（谁在做什么、什么被挡）：**
- `01` `2c9ce0ea`、`02` `1c9a8d7e`、`03` `14d3b6f4`、`04` `0f735377`、`05` `ae95b004` + 文档 `b3e131cd`，全部在 master（本地，未推送）。
- 05 的 `test:browser` 6 条 journey 全过；截图（`artifacts/browser/ui-04/channel-members-retired.png` 等）确认 Channel 页与编辑器均无管理成员控件。
- 待 @Reeve 统一验收：重点 spec 四硬约束（replay 兼容）；另有两点请专门看——ticket 03 改过一条既有断言（rejoin 后派生可见性会带回该 Channel，原文断言编码的是派生前语义）；`@all` 随派生口径覆盖「被点名进 thread 的人」（spec 二+五字面口径）。

**Completion conditions（第一期全完成）：**
- 五张 tickets 的验收项全绿；全量单测通过；`05` 的 `npm run test:browser` 通过且截图确认无管理成员控件。
- 加载/提交「改动前写入」的账本不抛错（全史全量复校通过）——这是本次最大的回归面。
- team_view 可见范围仍收口于「参与过的 channel」，`@all` 仍只覆盖 channel 已参与者。

**Formal-doc exit（收尾搬运到 maintained docs）：**
- 结论按 docs/AGENTS.md 路由搬运：模型/协作语义 → domain-model.md；授权/replay/membership 派生 → architecture/host-authority.md；mention/attention/@all 范围 → team-collaboration/attention-and-messaging.md；Remote/Client UI 收口 → architecture/client-and-remote.md。中英文档对同步，`npm run check:docs` 过。
- 第二期（显式待邀请态 + 一并理 issue #40）另开工作项，不在本目录。

**背景与依据：** Thread thread:898d427e · Task task:5f9e3661（#47）。设计由 Human 与 @Reeve 定、Human 已撤回 GitHub issue。模型三级分层依据 docs/domain-model.md。
