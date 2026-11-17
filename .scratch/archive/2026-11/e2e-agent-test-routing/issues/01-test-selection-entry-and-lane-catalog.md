# 01 — 测试选择入口与 E2E lane 目录

**What to deliver:** 根 `AGENTS.md` 的测试选择规则、完整中英文 lane 目录、脚本目录入口和文档一致性检查。
**Blocked by:** None — 当前决策与范围已在 [spec.md](../spec.md) 固定。
**Status:** complete
**Required context:** [README.md](../README.md)、[spec.md](../spec.md)、根 [AGENTS.md](../../../../AGENTS.md)、[`docs/AGENTS.md`](../../../../docs/AGENTS.md)、[`docs/README.md`](../../../../docs/README.md) 与 [`README.zh.md`](../../../../docs/README.zh.md)、[`docs/development/README.md`](../../../../docs/development/README.md) 与 [`README.zh.md`](../../../../docs/development/README.zh.md)、[`docs/development/start-and-checks.md`](../../../../docs/development/start-and-checks.md)、[`scripts/README.md`](../../../../scripts/README.md)、[`scripts/check-docs.mjs`](../../../../scripts/check-docs.mjs)、[`scripts/run-browser-test.mjs`](../../../../scripts/run-browser-test.mjs)（`laneAliases`）与 [`scripts/e2e/`](../../../../scripts/e2e/)
**Background:** [materials/current-audit.md](../materials/current-audit.md) §3
**Boundaries:** 保持现有自验标准和授权边界；根入口只放稳定路由，不复制完整 lane 表；维护文档必须中英文成对并登记到 `docs/README*.md`、`docs/development/README*.md` 与 `scripts/check-docs.mjs` 的 `BLOCK_CHARACTER_CEILINGS`。

- [x] 在根 `AGENTS.md` 增加按 Host / Client / assembled Web / full acceptance 选择测试的规则。
- [x] 新增 `docs/development/e2e-lanes.md` 和 `.zh.md`，列出当前真实 9 条 lane、契约、低层测试、触发条件和证据，并在 `scripts/check-docs.mjs` 中登记其 `BLOCK_CHARACTER_CEILINGS`。
- [x] 更新 `docs/README.md` 与 `docs/README.zh.md`（索引行与 Where to start）、`docs/development/README.md` 与 `.zh.md`、`docs/development/start-and-checks.md` 与 `.zh.md` 的入口链接。
- [x] 修正 `scripts/README.md`，删除旧的 10-file lane 叙述，链接到 lane 目录。
- [x] 增加 E2E 文档一致性检查，至少检查实际 `scripts/e2e/*.e2e.ts` 文件、文档条目（中英文）、Runner `laneAliases` 目标的存在关系，以及 `scripts/README.md` 不再包含旧 lane 清单。
- [x] 运行 `npm run check:docs`、新增一致性检查、`npm run check:scratch` 和 `git diff --check HEAD`。

**Evidence to return:** 修改文件、当前 lane 表、文档检查输出、未验证范围和仍待 Runner 支持的项目。
