# 07 delivery record — 2026-11-14 Reeve

Tars 端到端实现，交付在 `feat/manager-memory-skills`（worktree `/data/repos/dsh-agent-team-mgmt07`，tip `fae0032`，1 个提交、31 文件 +876/−141），未推。我独立核验后合回 `feat/team-manager-session`（worktree `/data/repos/dsh-agent-team-mgmt02`，合并提交 `6a48f19`）。

## 我核了什么、怎么核的

1. **合回前在 `fae0032` 独立复跑**：串行 `vitest run --no-file-parallelism` 215 文件通过 / 2773 通过、1 跳过；`npm run typecheck` exit 0；`node scripts/sync-paths.mjs --check` OK；`npm run check:core-skills` OK（core 4、manager 0，即 manager 内置根允许空）。不采信交付者自报。
2. **共享抽取的护栏（本次最重的一条）**：`git show --stat fae0032` 里 `member-context.spec.ts`、`member-context-integration.spec.ts` **都不在变更清单**；`member-context.ts` 的 diff 是把渲染逻辑改为委托 `private-memory.ts`，措辞常量（`# Member memory` 标题、BEGIN/END、四段固定句、可见范围句）逐字保留——与我本会话注入的 `<team-member-private-memory>` 块原文一致。Member 行为未变的证据是「断言一行未改且全绿」，不是「看起来没变」。
3. **合并本身**：`git merge-tree --write-tree HEAD fae0032` 与我的暂存树比对，差异恰好等于三个冲突文件（自动合并留标记 vs 手工解决），说明自动部分没有被我顺手改掉；`git diff --cached` 与 `fae0032^..fae0032` 的路径集在 04 后续提交造成的差异之外一致，没有卷入别人的 WIP。
4. **冲突解决按既定裁定**：`cordis.patch.yml` 保留 `manager-context` row 在 04 注释之上 + 五个工具 `only`；`shipping.spec.ts` 注释合并、五工具正则保留；`CHANGELOG.md` 保留 04 三条 Added（含改写后的 `only` 句）与 07 三条。
5. **合并树全门禁**：`npm run build` exit 0；`npm test` 216 文件 / 2787 测试通过、1 跳过，exit 0（含 generate:typert、check:facades、check:docs、check:core-skills、check:boundaries、check:versions、check:comments）；`npm run typecheck` exit 0。

## 票面逐条怎么落的

1. **独立入口**：新增 `manager-context.ts`（`@contexera/dsh-agent-team/manager-context`）挂进 `team-manager` preset，pre-step 里经 `host.managerMemoryForAgent(agent)` 判定当前管理 Agent，不经 `memberForAgent`；三态与 Member 同构（baseline / 旧副本提示 / 缺失或超限说明），digest + `textDigest` 去重，重放不重复注入。
2. **同一处权威渲染**：16 KiB 上限、转义、gauge、超限警告、路径块抽到 `private-memory.ts`（103 行），措辞由两边各传，共享模块里没有 if-else 特例。
3. **两处 skills 根**：`manager-session.ts` 扫随包只读 `packages/agent-team/manager-skills/`（排前）与可写 `$DSH_HOME/agent-team/manager/skills/`；同名内置优先、增删下一轮可见、Member 与普通 Session 看不到；`check:core-skills` 同时校验两个根。
4. **同一份目录跨会话**：新开对话、归档后重开、Host 重启三条用例断言读同一个根。
5. **新公开子路径的生成面**：`exports` 与 `scripts/sync-paths.mjs` 同步改后生成 facades，`tsconfig*.json` 未手改；Typert 产物未手改。

## 承重缝的判别性验证（我做）

- `manager-context.spec.ts` / `manager-context-integration.spec.ts` / `manager-skills.spec.ts` 三个新 spec 各自覆盖渲染边界、真 Host pre-step、两根发现与隔离；它们在 `fae0032` 与合并树上都跑过。
- Member 侧护栏的判别性由「断言未改 + 全绿」承担；若将来有人改坏 Member 措辞，这三个 spec 与 `member-context*.spec.ts` 会同时红。

## 未验证

- dev profile 人工验收（真实模型 + Human 账号）：步骤见 07 线程 30730，共 7 步（入门问答、记习惯、写 note、装 skill、新开对话、重启仍在）。
- `manager-skills/` 目前只有一份说明 README；两份内置 skill 内容归 08。
- 双平台 CI 未跑（本地提交，未推）。
