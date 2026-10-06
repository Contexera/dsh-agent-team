# Ledger 存储、通知与交付

[English](storage-and-delivery.md) | 中文

## Team ledger 存储路由
`agent_team` 域经根 `cordis.patch.yml` 的公开组合路由到 SQLite 后端：插入自有包名下的后端行 `@wowyuarm/dsh-agent-team/sqlite-backend`（介质为 `$DSH_HOME/storages/agent_team.sqlite`），并以顶层覆写行把 `storage-domain` 配置为 `backend: json` 加 `routes: { agent_team: sqlite }`。其余域保持 JSON 默认路由。

- 覆写必须是顶层行而非 insert 列表项：insert 只追加新行，重复 id 会让装配失败。`packages/agent-team/tests/shipping.spec.ts` 用生产解析器（`loadOverlayPatches` + `applyEntryPatches`）模拟「Web bundle 层 + 本 bundle 层」叠加来锁住这一接线。
- 该后端是 vendored fork（MIT，上游 `dsh-storage-sqlite` 0.1.5-rc.2，见 `packages/agent-team/src/vendor/storage-sqlite/`），而非对上游包的依赖：DSH Desktop generation 安装器会删掉 `@deepseek-ai/*` 拷贝，而没有任何已发布 host closure 提供上游包，因此 loader 行若指名它会阻断启动（GitHub issue #28）。fork 保留上游 `sqlite` backend 名与 config 形状，既有介质无需迁移；上游包只保留为 devDependency，用作字节兼容 fixture 参照。三个检查锁住这一面：`packages/agent-team/tests/storage-sqlite-compat.spec.ts` 在真实 ledger descriptor 下证明双向可读，`shipping.spec.ts` 把全部可达运行时根钉在 host closure 内，`node scripts/verify-desktop-strip-boot.mjs` 对删包后的 generation 重放一次真实 Loader 启动。每次 DSH 兼容认证都要把 fork 与上游文件对一遍 diff。
- 路由切换创建新的空 SQLite 介质；旧 `agent_team.json` 不被读取也不迁移，由使用者自行搬移或删除。
- `preview` 与 `preview:ui` 使用手写最小 overlay，不挂载该后端，仍走 JSON 默认路由。

基准只测存储层写入路径，不含账本校验成本（那部分与后端无关）；负载为接近观测均值 ~3.4 KB 的确定性操作文档：

```sh
DSH_BENCH_STORAGE=1 npx vitest run packages/agent-team/tests/storage-bench.spec.ts
```

JSON 整文件重写的单次写成本随历史增长——1k→10k 约 2.7 倍——而 SQLite 稳定在逐语句 fsync 下限附近。启动侧仍是全量 `loadAll()` 加全量重放；后续 checkpoint/log 方向见 [storage architecture archive](../../.scratch/archive/2026-08/agent-team-storage-architecture/)。

## 多页面通知回归
`npm run test:browser` 包含同一 BrowserContext 中的四个页面，随后再验证独立 BrowserContext。检查 Channel 实际渲染、跨页消息、关闭页面、退出 Team，以及浏览器发起的 Member 查询是否在 3 秒回归阈值内完成。该阈值只针对固定小数据集，不是生产延迟保证。完整流程还验证主动断网后无需新提交即可恢复。截图保留在 `artifacts/browser/`，包含桌面和 390×844 多页面视图。

定向执行：`npm run test:browser -- -t "four same-origin"`。传输改动验收前仍需运行完整套件。这些检查不代表跨页草稿、导航存储、私有未读同步或隐藏页自动已读已通过验证；它们需要单独评估。

## 交付前核对
- 改动没有偷偷加入 shipped DSH defaults。
- package README、manifest、导出和可见行为保持一致。
- Remote 变更已经重新生成，不存在手写 artifact。
- Client 改动有真实 composition 或 browser 证据，而不只有组件单测。
- 测试和 lint 命令实际执行过，汇报时只写真实结果。
- `git diff --check <base>..HEAD` 在交付区间上通过。
- Live preview、UI preview 与 browser replay 没有隐式模式切换；需要模型的检查明确选择 live 或 replay。
- 没有 API key、profile 凭据、临时 overlay、临时 Harness 测试或浏览器产物被提交。
