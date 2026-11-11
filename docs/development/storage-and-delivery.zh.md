# Ledger 存储、通知与交付

[English](storage-and-delivery.md) | 中文

## Team ledger 存储路由
Team Host 为 `agent_team` 和 `agent_team_subscriptions` 自己持有 SQLite backend 与 `DomainFacility`，介质为 `$DSH_HOME/storages/agent_team.sqlite`。无关的域保持 Host 的默认路由。这里刻意不使用 `storage-domain` route override：开关 bundle 时修改该全局行会重建无关的 storage consumers，并可能让 Session controller 启动两次，造成 file-upload resolver 重复注册。

订阅单元写入 v5 格式，打开 v1–v4 时不改版本。首次实际修改会在同一事务升级版本，启动后的后台任务也可能发起该修改。ledger 单元的版本独立。升级前停止所有共用数据库的 Host 并备份。订阅单元升级后，旧构建会拒绝打开；回退须恢复备份，备份之后的写入会丢失。

- 该后端是 vendored fork（MIT，上游 `dsh-storage-sqlite` 0.1.5-rc.2，见 `packages/agent-team/src/vendor/storage-sqlite/`），而非对上游包的依赖。DSH Desktop generation 安装器会删掉 `@deepseek-ai/*` 拷贝，而没有任何已发布 host closure 提供上游包，因此 loader 行若指名它会阻断启动（GitHub issue #28）。fork 保留上游 `sqlite` backend 名与 config 形状，既有介质无需迁移；上游包只保留为 devDependency，用作字节兼容 fixture 参照。三个检查锁住这一面：`packages/agent-team/tests/storage-sqlite-compat.spec.ts` 在真实 ledger descriptor 下证明双向可读，`shipping.spec.ts` 把全部可达运行时根钉在 host closure 内，`node scripts/verify-desktop-strip-boot.mjs` 对删包后的 generation 重放一次真实 Loader 启动。每次 DSH 兼容认证都要把 fork 与上游文件对一遍 diff。
- 首次打开创建新的空 SQLite 介质；旧 `agent_team.json` 不被读取也不迁移，由使用者自行搬移或删除。
- `preview` 与 `preview:ui` 使用手写最小 overlay，不挂载该后端，仍走 JSON 默认路由。

基准只测存储层写入路径，不含账本校验成本（那部分与后端无关）；负载为接近观测均值 ~3.4 KB 的确定性操作文档：

```sh
DSH_BENCH_STORAGE=1 npx vitest run packages/agent-team/tests/storage-bench.spec.ts
```

JSON 整文件重写的单次写成本随历史增长——1k→10k 约 2.7 倍——而 SQLite 稳定在逐语句 fsync 下限附近。启动侧仍是全量 `loadAll()` 加全量重放；后续 checkpoint/log 方向见 [storage architecture archive](../../.scratch/archive/2026-08/agent-team-storage-architecture/)。

## 重放不过的 ledger
Host 在构造自己的 ledger 时就重放并校验它：序号不等于它在表中的位置、previous-operation 链接断裂、operation id 或 request id 重复、首条记录不是 `team/initialized`，都会在那里抛出并指名记录；`agent-team ledger expected sequence 27968, found 27967` 是序号重复，不是缺口。

这一步抛出就是一条「没激活」的入口：Host 行失败，它的伴随行 `contexera-agent-team-invariant` 等待一个再也等不到的 `agentTeam` 服务，Harness loader 会警告哪些条目没激活。伴随行采用构造函数给出的结论、不再重放一次，只在 ledger 状态移动时才重跑完整重放；激活之后，同样的重放在每次提交后运行，出现分歧时按 error 记日志，并在后续提交上继续抛出，直到一次重放干净通过。

工具在那个状态下报 `Agent Team Host is unavailable`——正常启动窗口里也报同一句，因为工具只 inject `tools`，调用时才解析 `agentTeam`，而 Host 要等自己那九个服务齐了才 apply。只有 boot 日志能区分两者，工具报错本身不行。

## 多页面通知回归
`npm run test:browser` 包含同一 BrowserContext 中的四个页面，随后再验证独立 BrowserContext。检查 Project 实际渲染、跨页消息、关闭页面、退出 Team，以及浏览器发起的 Member 查询是否在 3 秒回归阈值内完成。该阈值只针对固定小数据集，不是生产延迟保证。完整流程还验证主动断网后无需新提交即可恢复。截图保留在 `artifacts/browser/`，包含桌面和 390×844 多页面视图。

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
