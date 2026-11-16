# 02 — Runner lane 列表与结构化反馈

**What to deliver:** 让 browser runner 自己列出可用 lane，并在 targeted/full 运行中报告契约、测试、阶段、耗时、截图和 artifact 路径。
**Blocked by:** 01
**Status:** complete
**Required context:** [spec.md](../spec.md) D5–D6、[`scripts/run-browser-test.mjs`](../../../../scripts/run-browser-test.mjs)、[`scripts/e2e/support.ts`](../../../../scripts/e2e/support.ts)、[`scripts/browser-evidence.mjs`](../../../../scripts/browser-evidence.mjs)、[`packages/agent-team/tests/browser-evidence.spec.ts`](../../../../packages/agent-team/tests/browser-evidence.spec.ts)、[`docs/development/e2e-lanes.md`](../../../../docs/development/e2e-lanes.md)（由 issue 01 维护）
**Background:** [materials/current-audit.md](../materials/current-audit.md) §2、§5
**Boundaries:** 不改变浏览器隔离语义；不默认并行化场景；不把 summary 变成第二份 lane 行为 authority（`contract` 从单一维护来源读取）；保留全量和 targeted 的截图门禁差异。

- [x] 增加 `--list`（`node scripts/run-browser-test.mjs --list` 免构建快查，以及 `npm run test:browser -- --list`），列出当前实际可匹配的 lane 与单一来源的 `contract`。
- [x] 运行开始时打印 selected lane、契约和 targeted/full 模式。
- [x] 记录外层 Runner（`preflight`、`staging`、`vitest`、`evidence`、`cleanup`）各阶段耗时；场景内通过 `support.ts`/Vitest 报告记录 `Harness/Web 启动`、`页面行为`、`Host projection` 子阶段。
- [x] 成功时输出测试数、截图数、artifact 路径和是否仍需完整 acceptance。
- [x] 失败时标明外层阶段与场景子阶段（环境预检、staging、Harness/Web 启动、页面行为、Host projection、evidence 或 cleanup）。
- [x] 提供 JSON summary 文件或等价机器可读输出，并保留易读 stdout。
- [x] 在 `packages/agent-team/tests/`（参照 `browser-evidence.spec.ts`）为 lane 过滤、alias、无匹配 lane、summary 输出和证据门禁补充有意义的脚本测试。

**Evidence to return:** `--list` 输出、成功 summary、失败 summary、脚本测试和 browser 环境未验证说明。
