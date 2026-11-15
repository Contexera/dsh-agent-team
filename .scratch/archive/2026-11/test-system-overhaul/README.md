# 测试体系全面治理与架构升级 (test-system-overhaul)

- **状态：** 完成并归档。最后验证日期：2026-11-14。
- **验收：** Human 于 2026-11-14 要求修复复核问题后归档；复核记录见 [reviews/01-test-system-overhaul.md](reviews/01-test-system-overhaul.md) 与 [reviews/02-followup.md](reviews/02-followup.md)。

## 结果

`01`–`06` 全部交付，完整门禁与浏览器回归通过：

- **01 — 生命周期自托管：** Host/Member 底座在资源创建时注册 `onTestFinished`（`beforeAll` 用显式 `afterAll`），释放链包在 `try / finally` 中，恢复 `DSH_HOME`，清理前默认执行 `validateLedger()`；新增 `harness-lifecycle.spec.ts` 覆盖初始化中断、校验失败仍清理、嵌套环境恢复与幂等关闭。
- **02 — Host / Ledger 底座：** 新增 `openTestLedger()`；`surface-harness.ts` 并入 `host-harness.ts`；抽取共享 Worker 引擎夹具与 `TestHuman` / `TestMember` 领域句柄。`packages/agent-team/tests` 的 jscpd 克隆 91 → 69，重复率 2.97% → 2.03%（相同配置，见 [materials/02](materials/02-rich-foundation-analysis.md) §4.2）。
- **03 — Tool 与 Client 底座：** Tool 测试统一使用强类型 `TestToolHost`；Client `harness.tsx` 按域拆入 `packages/client-agent-team/tests/bench/`，`createClientBench()` 自动完成 DOM 卸载、runtime 释放、storage 清理与 slot crash 检查，保留 `runtimeWithTeam()` 兼容出口。
- **04 — 执行分层：** `vitest.config.ts` 划出互斥的 `unit`（5s）、`integration`（60s）、`worker-long`（120s/30s）、`benchmark`（900s）与 `shared-host`（30s/30s）；209 个 spec 全部有且只有一个归属；`vi.setConfig` 清零。
- **05 — 第二轮消融：** 16 项故障注入；消融前检出 15/16，补强一处弱断言后 16/16。记录见 [materials/03](materials/03-round2-ablation.md)。
- **06 — E2E 与 CI：** 浏览器测试只 staging 一次只读模板，每个场景使用独立 `HOME`；共享 `installFakeCodex()` / Worker 设置 helper；CI Linux lane 补齐 `lint`、`check:artifact` 与 `audit-ui-parity`。26 个 E2E 文件 / 28 个用例、195 张截图证据通过。

交付时的完整门禁、修复后的复验结果与未验证范围见 [materials/03](materials/03-round2-ablation.md) §5。

## 票据

| # | 标题 | 前置依赖 | 状态 | 链接 |
| --- | --- | --- | --- | --- |
| 01 | 测试生命周期自托管、异常安全与全局不变量守卫 | 无 | `complete` | [01-lifecycle-and-invariants.md](issues/01-lifecycle-and-invariants.md) |
| 02 | Host / Ledger 测试底座充血与 43 个内联 Spec 收编 | 01 | `complete` | [02-rich-host-and-ledger-foundation.md](issues/02-rich-host-and-ledger-foundation.md) |
| 03 | Tool 强类型契约底座与 Client 分域 Bench 重构 | 无 | `complete` | [03-typed-tool-and-modular-client-bench.md](issues/03-typed-tool-and-modular-client-bench.md) |
| 04 | Vitest 项目分层与超时治理（消除 43 处 `vi.setConfig`） | 01, 02, 03 | `complete` | [04-vitest-tiering-and-timeout-governance.md](issues/04-vitest-tiering-and-timeout-governance.md) |
| 05 | 第二轮测试消融（2026-11-02 之后新增的 67 个 Spec） | 02, 03 | `complete` | [05-round2-test-ablation.md](issues/05-round2-test-ablation.md) |
| 06 | E2E 只读模板 Staging 提速、Worker 夹具复用与 CI 机械门禁补齐 | 01 | `complete` | [06-e2e-staging-and-ci-gates.md](issues/06-e2e-staging-and-ci-gates.md) |

## 目录导航

- [spec.md](spec.md) — 已确认的测试体系治理与底座充血规格说明
- [materials/01-test-suite-audit.md](materials/01-test-suite-audit.md) — 2026-11-14 测试体系全量盘点与实证记录
- [materials/02-rich-foundation-analysis.md](materials/02-rich-foundation-analysis.md) — 测试底座充血可行性、前后对比、迁移执行核对与 4 条护栏
- [materials/03-round2-ablation.md](materials/03-round2-ablation.md) — 第二轮测试消融、16 项故障注入与交付复验
- `issues/` — 实施票据（`01`–`06`）
- `reviews/` — 交付评审与复核记录

## 完成条件（已满足）

1. `01`–`06` 全部执行并通过独立复核与对应验证。
2. 测试目录克隆率与重复率同时下降，第二轮消融的故障检出率为 16/16。
3. 维护文档已同步，工作项移入 `.scratch/archive/2026-11/`。

## 维护文档出口

- [docs/development/start-and-checks.md](../../../../docs/development/start-and-checks.md) / [start-and-checks.zh.md](../../../../docs/development/start-and-checks.zh.md)
- [vitest.config.ts](../../../../vitest.config.ts) 与 [.github/workflows/ci.yml](../../../../.github/workflows/ci.yml)
