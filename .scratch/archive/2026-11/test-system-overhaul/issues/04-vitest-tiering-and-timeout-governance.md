# 04 — Vitest 项目分层与超时治理（消除 43 处 `vi.setConfig`）

**What to deliver:** 在 `vitest.config.ts` 落实 `unit`、`integration`、长场景、基准和共享 Host 的测试执行分层，移除全仓 43 个 spec 文件散落的 `vi.setConfig({ testTimeout })` 及直接超时参数，并在开发文档补齐快速按层执行命令，使代码实现与 `vitest.config.ts` 的超时策略契约一致。
**Blocked by:** 01, 02, 03
**Status:** complete

**Required context:**
- Binding review constraints: [spec.md §5](../spec.md#5-设计审查补充约束2026-11-14)（按本票编号适用）。
- Work-item entry: [README.md](../README.md)
- Binding decision D5 in [spec.md](../spec.md)
- Config & docs: `vitest.config.ts`, `package.json`, `docs/development/start-and-checks.md`, `docs/development/start-and-checks.zh.md`
**Background:**
- List of the 43 spec files calling `vi.setConfig` in [01-test-suite-audit.md](../materials/01-test-suite-audit.md) §5.
**Boundaries:**
- Included: 在 `vitest.config.ts` 划分 `unit`（默认 5s）、`integration`（默认 60s）、`worker-long`（`worker-inspect.spec.ts` 使用 120s test/30s hook）、`benchmark`（显式启用的 `storage-bench.spec.ts` 使用 900s）及 `shared-host`（`member-tool-policy.spec.ts` 使用 30s test/hook）；删除全仓 43 处文件内 `vi.setConfig` 及测试/钩子中的直接超时参数；必要时在 `package.json` 暴露 `test:unit` 快捷脚本并同步更新中英文 `start-and-checks`。
- Excluded: 不修改业务测试断言；不改大超时来掩盖死锁或性能退化；注意同步更新中英文文档以通过 `npm run check:docs`。

## 分层约束

固定迁移前 spec 清单，五个 project 的 include/exclude 必须互斥且并集等于该清单；返回 discovery 比对结果，防止漏跑或重复跑。保留根配置的 setupFiles、TZ、解析插件与 React 单例设置；同时集中 testTimeout 和 hookTimeout，按实测启动成本分类，不以统一放宽预算替代分类。

## Acceptance Criteria

- [x] `grep -rn "vi\.setConfig" packages/` 返回 0 处结果，所有超时策略集中由 `vitest.config.ts` 的 `projects` 声明。
- [x] `npm test` 默认运行全部 projects 且全部通过；`npx vitest run --project unit`（或对应 `test:unit` 脚本）能独立运行快速单元测试且每条均在 5s 预算内通过；`worker-long`、`benchmark` 的长预算只适用于其明确文件，且能单独运行。
- [x] `docs/development/start-and-checks.md` 与 `docs/development/start-and-checks.zh.md` 已同步记录新的分层命令，且 `npm run check:docs`、`npm run typecheck`、`npm run lint`、`npm test` 全绿。

**Evidence to return:** changes, checks and observed results, unverified scope, and deviations
