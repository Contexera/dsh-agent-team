# Review 02 — test-system-overhaul 复核

**结论：** 通过
**复核对象：** [Review 01](01-test-system-overhaul.md) 的 3 项 finding，以及归档前的完整交付
**复核日期：** 2026-11-14

## 处理结果

### P1 — 生命周期测试与并行 project 竞争共享 `/tmp`：已修复

- `RealHarnessOptions` 与 `TeamMemberHostOptions` 增加 `tempParent`，harness 可以在调用方提供的父目录下分配自己的 root。
- `harness-lifecycle.spec.ts` 的两个清理用例改为各自创建只属于该用例的父目录，并在断言 `readdir(parent)` 为空后删除父目录；不再扫描全局 `dsh-agent-team-*` 前缀。
- 验证：`npx vitest run --project integration packages/agent-team/tests/harness-lifecycle.spec.ts` → 7 passed；完整 `npx vitest run` 连续两次均 208 passed / 1 skipped。

### P1 — scratch 证据固定在一个不同的交付点：已修复

- `materials/03-round2-ablation.md` 的基线改为 `57f762f9` → 本记录所在的提交，并区分实验环境（rc.1、未构建 `lib/`）与交付复验（rc.2、完整工作树）。
- 新增 §5 记录交付时的实际门禁结果，不再沿用旧的“全部通过”描述。

### P2 — 真实 Host/Client 测试没有全部进入 integration：已修复

- `vitest.config.ts` 的 `integrationSpecs` 按“是否导入并启动 `harness()`、`sqliteHarness()`、`realHarness()`、`mountTeamMemberHost()`、`runtimeWithTeam()` / `createClientBench()`”重新建立完整清单，共 92 个文件。
- 对 209 个 spec 做机械比对：unit 114 + integration 92 + 长场景 3 = 209，无遗漏、无重复、无跨 project 交集。
- `unit` 现在只剩不启动真实 Host/Client 运行时的测试；`npx vitest run --project unit` → 114 files / 1758 tests passed。

### 补充修复 — 附件重启用例的缓存清理竞态

把 `attachments.spec.ts` 移入 integration 后，首次完整运行暴露出一个真实竞态：Host 重启会异步执行启动 GC，可能清掉同文件前一个用例留在共享缓存里的过期条目，而该用例断言整个缓存前后完全相等。

- 断言改为“重试没有新增缓存条目”，与用例要证明的“重放收敛到同一条目”一致；不再把无关的 GC 结果当成失败。
- 验证：该文件单独连续运行 3 次通过，之后完整套件连续 2 次通过。

## 复核时的检查

| 检查 | 结果 |
| --- | --- |
| `npm test` | 208 passed / 1 skipped（209 files），2683 passed / 1 skipped（benchmark 由 `DSH_BENCH_STORAGE=1` 显式启用） |
| `npx vitest run --project unit` | 114 files / 1758 tests passed（7.6s） |
| `npx vitest run --project integration` | 92 files / 874 tests passed（17.3s） |
| `npx vitest run --project integration packages/agent-team/tests/harness-lifecycle.spec.ts` | 7 tests passed |
| `npm run typecheck` | Passed |
| `npm run check:docs` | Passed |
| `npm run check:artifact` | Passed（458 artifact files，133 relative imports） |
| `node scripts/audit-ui-parity.mjs` | Passed（0 errors，2 existing warnings） |
| `npm run lint` | Exit 0；0 errors，83 warnings（基线 95，本次交付减少 12） |
| `npm run test:browser`（`CHROME_PATH` 指向本机 Chrome） | 26 files / 28 tests passed，195 张截图证据通过 |
| `rg "vi\.setConfig" packages` | 0 |
| 完整套件后 `/tmp` 下 `dsh-agent-team-*` / `dsh-team-*` 目录 | 0 |
| `../deepseek-harness` 工作区 | 无新增改动 |
| `git diff --check` | Passed |

## 未验证范围

- 只在 macOS arm64 上运行；Windows lane 的历史超时注释保留，但没有在本机复现。
- `jscpd` 指标使用临时配置扫描测试目录（见 `materials/02` §4.2），不是仓库默认的 `npm run duplication`。
- 浏览器验收使用本机 `/Applications/Google Chrome.app`，没有在 CI 中运行。
