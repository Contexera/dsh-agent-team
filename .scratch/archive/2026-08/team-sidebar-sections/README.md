# Team 侧栏分区化

状态：archived — 2026-08-22 前完成并合入。这里保存侧栏分区、行级编辑、成员模型固定和 Agent 会话跳转的历史实施摘要；当前行为以 `packages/`、测试和正式文档为准。

## 已交付

1. **M1（纯客户端，`fd6131e`）**
   - 宽屏侧栏以工作区列表和「频道」「Agents」两个常驻可折叠分区替代双 tab（`TeamSidebarSection`）。
   - 频道行有 `#` 标识和行级 ⋯ 菜单；Agent 行复用会话头像和 presence 角标。
   - 窄屏 rail 图标请求展开并聚焦对应分区。
2. **M2（Host update 操作、编辑器和跳转，`d1ff4ae`）**
   - Ledger 新增 `team/channel-updated`、`team/member-updated` 快照操作；Remote 提供幂等的 `updateChannel`、`updateMember`。
   - Agent 可继承默认模型或固定 provider/model；活跃成员改模型时由 Host 以相同 Session id 重激活，展示字段修改不重启。
   - 编辑器复用公共 `Menu`，模型目录来自宿主级 `llm.models`；Agent 卡片先退出 Team 模式再打开对应 Session。
   - handle 的 NFKC/大小写不敏感唯一性排除自身；mention 使用稳定 memberId，改名不影响历史引用。

## 当时的关键取舍

- 不使用 `session.selectModel`：它会修改全局默认模型，不适用于成员级覆盖；成员目录改走 host-scoped `llm.models`。
- 不用原生 `<select>`，与 DSH 的 `Menu` 交互语言保持一致。
- 清除模型覆盖时必须显式 omit `model`，不能从先前值展开。

## 验收与当前出口

当时已完成 ledger/Host/Remote/Client 贯通、单测和浏览器 journey 验证。稳定合同已进入：

- [`docs/frontend-design/sidebar-browser.md`](../../../../docs/frontend-design/sidebar-browser.md)「侧栏工作区浏览器」；
- [`packages/client-agent-team/README.md`](../../../../packages/client-agent-team/README.md)；
- 当前实现：`packages/agent-team/src/` 与 `packages/client-agent-team/src/client/`。

本目录不是后续侧栏工作的入口；新工作项应在 `.scratch/active/` 新建目录。
