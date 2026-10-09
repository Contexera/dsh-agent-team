# 02 — 成员之间的长时执行互不阻塞

**What to build:** A 正在运行、等待配置应用或等待外部操作时，用户仍能管理 B；同一 Member 的操作顺序与停止行为明确，关闭 Host 不依赖一个永不结束的回合。
**Blocked by:** 01 — 成员配置保存与生效一致
**Status:** complete

- [x] 复现 A 的配置编辑等待回合结束时 B 的暂停也被阻塞的现状，再验证 B 可独立完成。
- [x] 账本仍只有一个有序写入者；按 Member 隔离长时执行不削弱全局身份、权限和请求幂等约束。
- [x] 明确同一 Member 的编辑、停止、归档、移除与 Session 转换的顺序；停止是否中止待应用配置是显式取舍，不靠调用碰巧先后决定。
- [x] 任意转换失败后，当前期望状态与未完成效果仍可确定；旧 Session 或旧配置的异步结果不能覆盖新一代结果。
- [x] 处理取消、Session disposal、Host 关闭与回合结束的每个等待出口；无遗留监听者、等待任务或新的模型请求。
- [x] 日志能区分等待该 Member 的回合、等待外部执行和实际失败，并记录关联 Member / Session 与等待时长。
- [x] 定向验证跨 Member 并发、同 Member 竞争、故障后重试和关闭路径；同步生命周期维护文档。

## 完成记录（2026-10-09，尖端 `07083c48`，树 `eab0126afc217248ac807aa1f2e73f071a6d9435`）

四片：`6cbd0285` 按 Member 拆生命周期链（新增请求按 requestId 串行，Member id 尚未存在）；`fc6af976` 同 Member 提交序与并发新增的证据；`4bb66b58` 关闭与取消的等待出口；`07083c48` 等待类日志与 host-authority 双语同步。

**判据 3 的取舍（定稿口径）**：① 同一 Member 内按提交序执行；② 停止在该操作拿到链槽时取消在途回合；排在停靠的配置编辑之后时，它先到达那个 turn 边界（编辑生效）再停止；③ 停止从不清除、不中止已提交的配置——先编辑则边界生效后停止，先停止则返回 `deferred:no-live-handle`；两种顺序结束后存储意图都在下一次 activation 生效。账本的单一有序写入者不在 Host 的链上（ledger 自带提交队列），因此按 Member 拆链不削弱判据 2。

**装置更正（重要，撤销一条旧结论）**：早期探针适配器忽略了 `options.signal`，据此得出的「停止等到回合边界、不取消在途回合」**作废**。适配器遵守 signal 后，A 的回合停在模型调用且门未放行时 `suspendMember(A)` 11ms 落定、`streamAborted=true`、availability=`suspended`；Vera 独立复现同一结论。真实语义是停止取消在途回合（dispose 先 `abort`，再 `machine.cancel({kind:'disposed'})` 等收敛）。副产品：装置修正后「同 Member 仍串行」从被混淆变为有效证据——单条 stop 11ms 即落定，主用例里 A 自己的 stop 仍 pending 只可能由排在 A 的停靠编辑之后解释。

**判据 4**（失败后状态可确定、陈旧结果不覆盖新结果）由既有测试覆盖，本票未改代码：`member-tool-policy.spec.ts:498` 陈旧重试不回滚更新的已接受配置、`:533` 应用失败保留旧面后重试完成、`:606` 诊断加重试清除、`:568`/`:596` deferred 与 already-applied 的确定性；`member-lifecycle.spec.ts:538`/`:566`/`:593`/`:626`/`:661` 覆盖转换失败、重试与启动收敛。

**判据 6**（等待类日志）：`stage 'wait-turn'` 只在真的等待了回合边界时记录（编辑的边界等待、转换的 idle 等待），`stage 'wait-external'` 记录 Agent 释放 Session 写路径的三处（`disposeMemberSession`、`retireMemberGeneration` 的 dispose、`workspaceRegistry.archiveSession`），都带 Member handle、Session id 与 `waited <n>ms`；失败仍是各自原有的 warn 行（`stage=apply`、activation failed），同一关联组下可区分。

**判据 7**：定向验证＝跨 Member 并发（B 的 suspend 不被 A 停靠的编辑阻塞）、同 Member 竞争（提交序）、停止两序、并发重复新增幂等（第二次请求返回同一 receipt）、不同 Member 并行新增、Host 关闭排空、取消出口、等待类日志，共 8 个用例集中在 `member-lifecycle.spec.ts` 的 isolation describe。维护文档＝`docs/architecture/host-authority.md` 与其 `.zh.md`：队列段改为「同一 Member 按提交序串行、不同 Member 从不排在彼此等待之后」，并补上按 Member 链、停止取消在途回合、关闭释放等待、等待类日志与 `deferred:no-live-handle` 的两种顺序。

**有意不测的出口**：`session/disposed` 是防御性监听器，在链设计下从链外不可达（源码注释已说明），只文档化。关闭出口的测试先红后绿：修复前该用例报 `expected 'stalled' to be 'disposed'`（观测到 `stalled`），修复后整用例 141ms 绿；用例在竞速结束后主动放行门，避免 afterEach 的 10s hook 超时卡住套件。

**闸门（最终树 `eab0126a…`）**：typecheck ✓；`npm test` 1001 通过 / 1 跳过（1002）；lint 0 error、3 条既有 warning（`context-continuity-host.spec.ts:375`/`:409`、`vendor/storage-sqlite/index.ts:161`）；`npm run build` ✓；`npm run test:browser` 6/6；`npm run check:docs` ✓（28 文档、34 对 outline、最长块 host-authority.md 597/597、.zh.md 538/541，未抬上限）。
