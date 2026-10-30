# Review 02 — 修复复核与新增使用统计审查

**Conclusion:** Changes needed
**Work item:** `.scratch/active/team-performance-optimization`
**Ticket:** Whole work item（01–03）
**Compared:** HEAD `f4de5a01c0edb8626a4d6ada5b6d2cc1ba4a5c1f` 上的未提交性能改动，包括全部未跟踪的 `scripts/team-performance/` 和性能文档
**Commits:** 本轮未创建提交
**Reviewed:** 2026-10-30 19:08–19:20 UTC+8

## Findings

### P2 — 恢复后的 Member 仍被使用统计报告为 suspended

**Location:** `scripts/team-performance/team-live-usage.ts:119–128,146–154`。

**Evidence:** 新脚本依次处理 `member-added`、`member-updated`、`member-archived`、`member-suspended`、`member-removed`，遗漏 `team/member-resumed`。而该操作在 `packages/agent-team/src/types/operations.ts:63–65` 明确携带恢复后的完整 Member。

本轮用真实 `sqliteHarness` 和 `AgentTeamLedger` 创建临时 SQLite，依次执行 `addMember → suspendMember → resumeMember`。关闭写入端后，通过 `team-live-usage.ts <database> --json` 读取。未接触用户真实 profile。

```json
{
  "expected": { "memberState": "enabled", "enabled": 1, "suspended": 0 },
  "actual": { "current": 1, "enabled": 0, "byState": { "suspended": 1 } },
  "operations": {
    "team/initialized": 1,
    "team/member-added": 1,
    "team/member-resumed": 1,
    "team/member-suspended": 1,
    "team/rules-version-adopted": 1
  }
}
```

**Impact:** 有过暂停和恢复、之后没有其他覆盖 Member 快照的操作时，脚本低估 enabled Member 数，并把其 Thread Attention 从 `enabledMembers` 统计中排除。新文档和工作项使用该统计描述日常协作规模，因此相关数字需要修正后重新生成。这不证明当前真实 profile 的具体数字必然有误，但证明脚本不能可靠计算这类历史。

**Basis:** 新性能文档承诺统计真实 profile 的 Member 和 Thread Attention；ticket 01/03 要求测量结果与输入事实一致。源码与真实 ledger 的当前状态是事实依据。

**Suggested fix:** 把 `team/member-resumed` 纳入 Member 状态更新；增加添加、暂停、恢复、归档和移除序列的自动测试，并断言 enabled Member 及 enabled follower 计数。修复后重新生成用于工作项结论的真实 profile 统计。

## 上轮发现的复核

| 问题 | 结果 | 本轮证据 |
| --- | --- | --- |
| 大批次后小批次插队 | 已修正 | `pendingNotification` 存在时继续排入同一 Member 链；语义探针观察到 8 个 sequence 12 后接 sequence 13 |
| 空测量和零基线误判为通过 | 已修正 | CLI 对照：10→10 退出 0；10→20、10→无样本、0→20 均退出 1 |
| 相对 Harness checkout 记录 unknown | 已修正 | `DSH_HARNESS_DIR=deepseek-harness` 实跑正确记录 `687f282e8625c6b8d11ff58211a90524be2e4317` |
| 延迟 invariant 与文档不一致 | 已修正 | Host authority 双语文档与注释均区分同步 reject 和异步 error 日志；相关测试通过 |
| Where to start 缺入口 | 已修正 | 两种语言均新增性能测量导航；`npm test` 中的 docs gate 通过 |

移除每次通知入队/完成时聚合全部链的 `notificationEffectTail`，评测改为观察 `notificationEffectTails`，未恢复新的长期事实缓存。该调整没有改变 ledger 权威。

## Acceptance criteria

| 条件 | 结果 | 证据 |
| --- | --- | --- |
| 01.1–01.6 基准场景、采样、标识、产物与默认关闭 | 有实现，部分复跑 | 复跑 Host boot；脚本和文档包含其余场景，未重跑完整基线 |
| 01.7 比较器与回归门槛 | Met（本轮四组边界） | 正常、回归、空测量、零基线结果均符合预期 |
| 01.8 clean commit 矩阵 | Not verified | 本次修改仍未提交，不能把工作树样本记作 clean commit 证据 |
| 02.1–02.5 单次派生复用与 running 去重 | 保留实现，现有回归通过 | Ledger read set、plan 复用、undelivered 重试条件保持；Host/Inbox 25 测试通过 |
| 02.6 text/covered/undelivered/attempt 与旧路径逐项一致 | Partial | 混合批次顺序修复已验证；仍未提供完整旧新等价测试 |
| 02.7 recovery/generation/失败隔离 | Partial | 失败重试、shutdown、invariant 和 mixed-batch 探针通过；没有专项验证全部 generation 交错 |
| 02.8 Host/ledger/delivery/tool 回归 | Met（自动化） | 全量 1540 passed，1 skipped |
| 03.1 固定规模矩阵 | Not verified 本轮 | 默认矩阵已改为日常 1–4 follower、8 人边界和 32 人压力；本轮未重跑 |
| 03.2–03.7 各阶段、规模和计数 | 有实现，非完整验收 | 未重跑所有场景；新增 usage 存在本报告发现 |
| 03.8 语义探针 | Met（现有覆盖） | 五项均通过，顺序场景现为大→小批次 |
| 03.9 最终交付检查 | Partial | tests/typecheck 通过；本轮未跑 build/artifact/Browser |
| 03.10–03.11 限制记录及比较 | 部分满足 | 已如实保留未完成范围；比较器四组边界通过 |

工作项自己的现有复审记录仍明确保留 clean commit 对照、完整 Agent tool 读写闭环、Browser 全量复核等未完成项。这些不能因为旧的五项缺陷已修复就自动标成完成。归档前须如实处理剩余范围，不能用降低测试门槛替代验证。

## Checks run

| 命令或检查 | 结果 |
| --- | --- |
| `git diff --check HEAD` | 退出 0 |
| `npx vitest run packages/agent-team/tests/post-commit-delivery.spec.ts packages/agent-team/tests/inbox-delivery.spec.ts` | 2 文件，25 测试通过 |
| `DSH_BENCH_TEAM=1 npm run bench:team:semantics` | 退出 0，五项通过；shutdown 后执行数 0，mixed-batch 保序 |
| `node artifacts/team-perf/review-2026-10-30/compare-check.mjs` | 四组 CLI 边界符合预期，详见上表 |
| `DSH_BENCH_TEAM=1 DSH_HARNESS_DIR=deepseek-harness DSH_BENCH_SAMPLES=1 DSH_BENCH_WARMUPS=0 DSH_BENCH_SCENARIOS=host-boot npm run bench:team` | 退出 0；Harness commit 正确 |
| `node --import tsx artifacts/team-perf/review-final-2026-10-30/usage-state.ts` | 退出 0，成功采集反例；报告 enabled 0，对照 ledger enabled 1。这是缺陷复现，不是行为通过 |
| `npm test` | 退出 0；135 文件通过，1 跳过；1540 测试通过，1 跳过；前置文档、边界等检查通过 |
| `npm run typecheck` | 退出 0；三个包通过 |
| 受审源码审查前后 SHA-256 | 一致，无并发改写证据 |

## Unverified scope and residual risk

- 本轮未运行 build、artifact、Browser、完整矩阵。已经确认新增脚本缺陷，不能满足用户“没问题才归档提交”的条件。
- 不把上一次 Browser 全量 9/10、失败项单独重跑通过描述为全量验收通过。
- 本轮未读取真实 profile，不修改其数据库；没有沿用未经本轮验证的 enabled Member 数。
- 未创建分支、归档、提交或推送。没有修改实现、tickets 或 README；只创建本报告和忽略目录中的复现证据。

## Review record

- Spec sources：工作项 README、`issues/01-performance-baseline-and-observability.md`、`02-notification-read-set.md`、`03-scale-acceptance-and-regression-matrix.md`、现有 `reviews/01-team-performance-optimization-recheck.md`。
- Standards sources：根 AGENTS、`.scratch/AGENTS.md`、`docs/AGENTS.md`、`docs/development/start-and-checks.md`。
- Uncommitted and untracked changes included：是，Host/ledger/通知测试、7 个性能脚本、bench npm 入口、Host authority 双语说明和性能文档索引。没有将其他已提交工作纳入本次修改。
- HEAD：`f4de5a01c0edb8626a4d6ada5b6d2cc1ba4a5c1f`。
- 关键 SHA-256：
  - `index.ts`：`66d2fd64db2fa80cd383173042f7bac42dd7f7d68612bcb3e24286c4daa7efe0`
  - `ledger.ts`：`f28505c2122a93e8e0a166998e0e110a02df4b33233bf50aafb16ecee51394e9`
  - `team-live-usage.ts`：`e16c98d660b81723639805117f7cc2c3f329f1ebe7888770b9de9c3945759e41`
  - `compare-team-performance.mjs`：`8a69a6370ccf3c2cab66995baf93167515fffa503d1e2ce46a6ae3a38c851d98`
- 临时证据目录：`artifacts/team-perf/review-final-2026-10-30/`，包含 `usage-state.ts`、`usage-state-result.json`、`tests.log`、`typecheck.log`。本报告保存关键复现步骤和结果，临时 SQLite 不进入归档。
