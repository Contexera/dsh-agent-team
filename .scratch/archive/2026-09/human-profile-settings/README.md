# human-profile-settings — Human 可配置项（avatar / name / 版本脚注）

- **状态**：已交付并归档 — Host 接口与设置骨架落地；`My profile` 设置段（名称、头像）随 0.1.14（2026-09-22）发布（见 CHANGELOG）。归档时 Task #43 的 Human 验收未在目录内留记录。
- **最后核实**：2026-09-18（以 `packages/` 源码与 `../deepseek-harness` 只读契约为准；全量窄门禁已过：typecheck＋vitest 671 passed＋boundaries＋docs）。
- **当前前沿**：接口落地（未提交）：Host `agent-team-human` namespace＋`humanProfile`/`putHumanAvatar`/`getHumanAvatar`/`removeHumanAvatar` 四个 Remote＋`settings.section#team-human` 骨架页；human 决议：description 不要、avatar 上传、版本脚注要、时区另批。
- **完成条件**：Iris UI 落地＋human 验收 #43；时区单独立项；本目录按 `.scratch` 生命周期归档。
- **正式文档出口**： durable 结论进 `docs/architecture/README.md`（Host 权威/持久化）与 `docs/frontend-design/README.md`（可见 UI），中英成对（待 UI 落地后补）。

## 接口落点（Iris 入口）

- Host：`packages/agent-team/src/human-profile.ts`（namespace 常量＋schemastery schema＋校验）、`packages/agent-team/src/human-avatar.ts`（持久目录 `$DSH_HOME/agent-team/human/v1`，无 TTL）、`packages/agent-team/src/index.ts`（`humanHandle()`/`humanProfile()`＋四个 Remote＋ledger 同步）。
- 账本：`packages/agent-team/src/ledger.ts`（`humanDisplayHandle` 运行时名；@ 候选＋唯一性校验同源；actor 校验只认 memberId，handle 显示化）。
- Tool：`packages/tool-agent-team/src/index.ts`（team_view 的 human handle 改读 `host.humanHandle()`）。
- Client：`packages/client-agent-team/src/client/HumanSettingsSection.tsx`（骨架，文案待 Iris 细化）＋`client/index.ts`（section 注册 id `team-human` order 5，写经 `remote.settings`，读经 `remote.agentTeam.humanProfile`）。
- 测试：`packages/agent-team/tests/human-profile.spec.ts`、`packages/agent-team/tests/typert-generation.spec.ts`（边界＋4）、`packages/client-agent-team/tests/human-settings.client.spec.tsx`。
- 已知约束：Team 模式 settings 不可达（只做普通模式）；消息内 human 显示仍读 `t('human')`，Iris 接 UI 时切到 profile 名；`updateAvailable` 恒 false（Host 自查待后续）；`docs/` 待 UI 落地后补。
