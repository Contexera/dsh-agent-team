# Ledger 存储、通知与交付

[English](storage-and-delivery.md) | 中文

## Team ledger 存储路由
Team Host 为 `agent_team` 和 `agent_team_subscriptions` 自己持有 SQLite backend 与 `DomainFacility`，介质为 `$DSH_HOME/storages/agent_team.sqlite`。无关的域保持 Host 的默认路由。这里刻意不使用 `storage-domain` route override：开关 bundle 时修改该全局行会重建无关的 storage consumers，并可能让 Session controller 启动两次，造成 file-upload resolver 重复注册。

订阅单元写入 v5 格式，打开 v1–v4 时不改版本。首次实际修改会在同一事务升级版本，启动后的后台任务也可能发起该修改。ledger 单元的版本独立。升级前停止所有共用数据库的 Host 并备份。订阅单元升级后，旧构建会拒绝打开；回退须恢复备份，备份之后的写入会丢失。

- 后端随 bundle 一起发布（`@contexera/dsh-agent-team/sqlite-backend`，MIT，上游 `dsh-storage-sqlite` 0.2.2-rc.1，见 `packages/agent-team/src/vendor/storage-sqlite/`），而非对上游包的依赖。DSH Desktop generation 安装器会删掉 `@deepseek-ai/*` 拷贝，而没有任何已发布 host closure 提供上游包，因此 loader 行若指名它会阻断启动（GitHub issue #28）。fork 保留上游 `sqlite` backend 名与 config 形状，既有介质无需迁移；上游包只保留为 devDependency，用作字节兼容 fixture 参照。
- 兼容性由三项检查覆盖：`packages/agent-team/tests/storage-sqlite-compat.spec.ts` 在真实 ledger descriptor 下证明双向可读，`shipping.spec.ts` 把全部可达运行时根钉在 host closure 内，`node scripts/verify-desktop-strip-boot.mjs` 对删包后的 generation 重放一次真实 Loader 启动。每次 DSH 兼容认证都要把 fork 与上游文件对一遍 diff。
- 首次打开创建新的空 SQLite 介质；旧 `agent_team.json` 不被读取也不迁移。
- 两条预览命令都在临时 home 中挂载 bundle，不使用操作者的数据库。

用 `DSH_BENCH_STORAGE=1 npx vitest run packages/agent-team/tests/storage-bench.spec.ts` 测量后端写入，不包含 ledger 校验。启动仍会加载并重放整个 ledger。端到端的 ledger 测量见 [Team 性能评测](team-performance.zh.md)。

## 重放不过的 ledger
Host 在构造自己的 ledger 时就重放并校验它：序号不等于它在表中的位置、previous-operation 链接断裂、operation id 或 request id 重复、首条记录不是 `team/initialized`，都会在那里抛出并指名记录；`agent-team ledger expected sequence 27968, found 27967` 是序号重复，不是缺口。

如果重放抛出错误，Host 配置行无法激活。伴随插件 `contexera-agent-team-invariant` 会等待 `agentTeam` 服务，Harness loader 会报告未激活的条目。如果重放成功且此后没有提交，伴随插件挂载时会沿用这次校验结果。

激活后，伴随插件会合并一批提交，在响应的 I/O 轮次之后重放一次。发现不一致时先记错误日志，之后的提交会继续抛出该错误，直到重放通过。

工具在那个状态下报 `Agent Team Host is unavailable`——正常启动窗口里也报同一句，因为工具只 inject `tools`，调用时才解析 `agentTeam`，而 Host 要等所需的服务就绪才会激活。只有 boot 日志能区分两者，工具报错本身不行。

## 多页面通知回归
`npm run test:browser` 包含同一 BrowserContext 中的四个页面，随后再验证独立 BrowserContext。检查 Project 实际渲染、跨页消息、关闭页面、退出 Team，以及浏览器发起的 Member 查询是否在 3 秒回归阈值内完成。该阈值只针对固定小数据集，不是生产延迟保证。Inbox lane 另行验证断网后无需再次提交即可恢复。截图保留在 `artifacts/browser/`，包含桌面和 390×844 多页面视图。

定向执行：`npm run test:browser -- team-timeline-and-shell -t "four same-origin"`。传输改动验收前仍需运行完整套件。这些检查不代表跨页草稿、导航存储、私有未读同步或隐藏页自动已读已通过验证；它们需要单独评估。

## 交付前核对
- 改动没有偷偷加入 shipped DSH defaults。
- package README、manifest、导出和可见行为保持一致。
- Remote 变更已经重新生成，不存在手写 artifact。
- Client 改动有真实 composition 或 browser 证据，而不只有组件单测。
- 测试和 lint 命令实际执行过，汇报时只写真实结果。
- `git diff --check <base>..HEAD` 在交付区间上通过。
- Live preview、UI preview 与 browser replay 没有隐式模式切换；需要模型的检查明确选择 live 或 replay。
- 没有 API key、profile 凭据、临时 overlay、临时 Harness 测试或浏览器产物被提交。
