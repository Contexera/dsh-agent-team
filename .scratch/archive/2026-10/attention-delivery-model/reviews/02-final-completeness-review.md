# Review 02 — 最终完成度复核

**结论：阻塞，工作项重新打开。**

| 项目 | 内容 |
| --- | --- |
| 复核对象 | `attention-delivery-model` 的归档状态与当前 `HEAD`（`575747c`） |
| 复核日期 | 2026-10-28 |
| 复核范围 | 5 张票据的验收条件、`DESIGN.md` 的 9 条验收测试缝、真实 dev-profile 账本重放、模型可见文案、试用指标脚本 |
| 方法 | 只读检查；运行全量测试与门禁；复制真实账本到 `/tmp` 重放；用内存探针定位差异。未修改仓库代码 |
| 归档结论 | 归档 README 称「5 张 tickets 全部完成，仅剩人工试用」。本次复核认为该结论高估完成度 |

## 一、结论摘要

1. **领域模型主体已落地。** Thread 与 Main stream 的普通更新均由 Attention 决定；owner threshold 已删除；Main stream Attention、默认关注、来源字段和多数 Agent 指导均已实现。
2. **当前构建无法重放真实 dev-profile 账本。** `new AgentTeamLedger(...)` 在 sequence 5 抛 `invalid Thread read projection`，Host 会因此启动失败。该问题由 Attention `source` 字段的追加修复引入；在 `7558dfd`（source 字段之前）上同一账本可以完整重放。
3. **模型可见文案与试用指标仍按旧模型。** `team_thread`、`team_message` 的 tool description 和 `team-domain-model` core skill 仍称 Main stream 只有 owner 收到普通未读；`scripts/team-trial-metrics.ts` 仍按「Main 只通知 owner、Thread 回复跳过 owner」统计。
4. **两张票据仍有未闭合的验收条件。** 02.6 的失败重试测试从未注入失败；05.3 的显式 follow 结果未说明历史内容仍可读取。归档票据均勾选为完成，与事实不符。

## 二、blocker — 真实账本无法重放

### 现象

对 `/home/yu/.dsh/storages/agent_team.sqlite` 的只读副本执行当前构建的构造重放：

```text
Error: invalid Thread read projection
    at AgentTeamLedger.validateLegacyThreadReadSnapshot
    at AgentTeamLedger.validateOperation
    at AgentTeamLedger.validateRecords
    at AgentTeamLedger.replay
    at new AgentTeamLedger
```

账本共 25,525 条操作，首条 `2026-08-21T03:52:33Z`，末条 `2026-10-28T08:27:43Z`。失败点是 sequence 5 的 `team/thread-read`（2026-08-21），属于 source 字段出现之前的 legacy 快照形状。

复现方式（只读副本，不接触原账本）：

```bash
mkdir -p /tmp/ledger-probe
cp ~/.dsh/storages/agent_team.sqlite* /tmp/ledger-probe/
node --import tsx scripts/team-trial-metrics.ts /tmp/ledger-probe/agent_team.sqlite
```

该命令在当前 `HEAD`（`575747c`）抛 `invalid Thread read projection`；在 `7558dfd` 的 `ledger.ts` 上对同一副本执行则完整通过。

### 证据

- 同一账本在 `7558dfd` 的 `ledger.ts` 上重放通过。
- 当前 `HEAD` 在 `23ed8ee`（引入 source 字段）与 `3fb6bed`（修复 source 推导）之后；归档 review 01 的比较基准停在 `7558dfd`，因此没有覆盖到这条回归。
- 当前 `HEAD` 上，快照与当前推导的完整字段比对只有一处差异：

```text
.attention.source    存储值 = undefined    当前推导 = "mention"
```

- 修复探针同时做两处调整后，25,525 条操作全部重放通过：
  1. legacy 快照比较忽略 `attention.source`；
  2. `team/thread-read` / `team/main-stream-read` 的 source 继承既有 Attention 行。

### 根因

`source` 是后加的字段，现有修复只覆盖了 `inbox` 中的 Attention 行：

1. `repairLegacyAttentionSource` 只修补 `operation.data.inbox.attention.set` 与 `mainAttention.set`，**不修补 legacy Thread read 快照自带的 `data.attention` 字段**；而 `validateLegacyThreadReadSnapshot` 会把该字段与当前推导一起比较。
2. `legacyAttentionSourceOf` 没有 `team/thread-read` 与 `team/main-stream-read` 分支，落到默认值 `self`。这两类操作只推进已有 Attention 行的读取水位，并不建立关注；它们应继承该行已有的 source（本账本中为 `mention`），而不是写成 `self`。

即使只修快照比较，receipt 形状的读取仍会在后续 sequence 失败，差异同样是 `self` 与 `mention`。因此两处都必须修。

### 为什么测试没有发现

`legacy-main-attention.spec.ts` 覆盖了 owner grant、Claim、reopen 和 marker-only Main read，但没有覆盖「rules version 1 的 mention 建立 Attention → legacy Thread read 快照 → 当前构建重开」这一真实形状。全量测试 1,418 条全部通过，说明现有 fixture 不足以代表真实账本。

### 影响

- Host 在启动重放阶段失败，dev-profile 人工试用无法进行；归档 README 的「仅剩人工试用」不成立。
- 这是回归，不是用户账本损坏：同一文件在 source 字段引入前可正常打开。

### 修复建议

1. `validateLegacyThreadReadSnapshot` 比较时从两侧剥离 `attention.source`。该快照形状冻结于 source 字段之前，剥离与「后加字段不参与旧形状比较」的既有原则一致。
2. `legacyAttentionSourceOf` 为 `team/thread-read` 与 `team/main-stream-read` 返回已有投影行的 source；找不到行时才回退 `self`。
3. 增加回归用例：v1 mention 建立 Attention → 写入 legacy Thread read 快照 → 用当前构建重开账本，断言重放成功且 source 为 `mention`。
4. 修复后用 `scripts/team-trial-metrics.ts` 对真实账本副本再跑一次，作为独立验收。

## 三、major — 模型可见文案仍教 owner-only 投递

| 位置 | 当前表述 | 问题 |
| --- | --- | --- |
| `packages/tool-agent-team/src/index.ts:475` | `team_thread` 描述：Main stream read 回应 “an owner's unread and the mentions of every Member” | 非 owner follower 的普通未读被排除在描述之外 |
| `packages/tool-agent-team/src/index.ts:817` | `team_message` 描述：“An owner holding unread Main stream, or any Member holding a mention, reads it first” | 任何 Main Attention 覆盖的未读都应先读，不只是 owner |
| `packages/agent-team/core-skills/team-domain-model/SKILL.md:44-45` | Main stream message → “the Project's other owners”；New discussion → “other owners” | 应改为 Attention 覆盖该 Main stream 的读者 |

这些文本直接进入模型上下文，是本工作项「让 Agent 理解并管理 Attention」的验收对象。当前内容会让 Agent 继续按旧模型推理，例如只 @ owner、误判 `main_unread_required` 的触发者。

修复建议：统一改为 Attention 语义，并在 render/description 测试中断言关键子句；不要只改 CHANGELOG。

## 四、major — 试用指标脚本仍按旧投递模型统计

`scripts/team-trial-metrics.ts`：

- `:105` 对 `team/main-message-posted` 和 discussion `team/thread-started` 只遍历 `owners`，漏掉非 owner 的 Main Attention follower。
- `:108-110` 对 `team/thread-replied` 跳过 `owners`，仍假设 owner 走 threshold；新模型下 owner follower 也应计入 immediate。
- `:176` 的限制说明仍写 “threshold-qualified ordinary facts are excluded”，threshold 已不存在。

影响：剩余验收正是 dev-profile 试用，而该脚本是试用指标工具；当前统计会同时少算 owner 的 Thread 普通更新和非 owner 的 Main 普通更新。

修复建议：按 Main Attention 行 + 派生 Human 行统计 Main 收件人；Thread 回复按全部 follower 统计；更新限制说明；用「非 owner Main follower」和「owner Thread follower」两个 fixture 锁定。

## 五、minor — 票据验收条件未真正闭合

### 02.6 失败重试测试没有注入失败

`packages/agent-team/tests/post-commit-delivery.spec.ts:152` 的用例名为「retries a failed wake over ordinary Thread unread alone」，但 `:162` 在操作开始前就设置了 `state.fail = false`。唯一真正注入失败的用例是更早的 mention 路径（`wakeSeam` 默认 `fail: true`）。因此「无 marker 的普通未读失败后重试」仍未被验证。

### 05.3 显式 follow 缺少「更早内容可读」

`packages/tool-agent-team/src/index.ts:393` 的 follow 结果只说明后续普通更新会打断，没有说明更早内容仍可通过读取与 history 获取。归档票据将该项勾为完成。

### 05 的 status 措辞仍未区分查询与变更

`team_attention status` 对一个从未 follow 的流仍使用 `Ordinary updates will no longer interrupt you…`，描述了一次没有发生的变化。归档 review 01 已记录该 nit，并延后到 `agent-tools-context-rendering`；本次复核确认仍在。

## 六、文档事实错误

`CHANGELOG.md:22` 称 Attention `source` “is excluded from replay validation”。实际实现会在修复后严格比较该字段；本 blocker 正是比较结果不一致导致的。应改为「存储中可选；旧记录缺失时按写入它的操作推导后再参与校验」。

`docs/architecture/host-authority.md:18` 的 “keeps the field out of validation” 有同样歧义，建议与实现对齐。

## 七、需要确认的设计偏离

以下两项与已确认的 DESIGN 表述不完全一致，代码和文档已经自洽，但需要明确接受或修改：

1. **Human 不能 unfollow Main stream。** DESIGN 与票据 03 写的是「任何 Member 都能 follow/unfollow Main stream」，实现中 Human 的 Attention 由 Project 创建派生，unfollow 会被直接拒绝（`ledger.ts:1786` 附近）。理由成立（派生状态无法结束，不能记录空操作），但这是对原验收条件的收窄。
2. **离开 Workspace 与归档 Project 不收回 Main Attention。** `docs/team-collaboration/attention-and-messaging.md:55` 已明确写出这一不对称：Thread Attention 会被清理，Main Attention 保留，成员重新加入后会看到离开期间的消息。需要确认这是期望行为，而不是遗漏。

## 八、按 DESIGN 的验收测试缝对照

| # | 测试缝 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | 普通投递不受 owner 身份影响 | 达成 | `inbox-delivery.ts` 无 `owns`，无 threshold |
| 2 | Main stream 对称 follow/unfollow | 部分 | Agent 对称；Human 不能 unfollow |
| 3 | 默认 Attention 只建 Main，不批量订阅 Thread | 达成 | owner grant 仅在缺失时建行 |
| 4 | unfollow 后 @/reply/责任/reminder 仍到达 | 达成 | marker 路径独立 |
| 5 | active Claim 禁止 unfollow | 达成（Thread） | Main stream 无 Task，不适用 |
| 6 | 身份撤销不隐式删除 Attention | 达成 | `project-owner-removed` 保留行 |
| 7 | Host 投递仍有界、可去重 | 达成 | `signature` / `delivered` 分离，有测试 |
| 8 | Agent 指导与领域语义一致 | 部分 | source 已渲染；tool description 与 core skill 仍旧 |
| 9 | 持久化与重放覆盖迁移 | 未达成 | 合成用例通过；真实账本失败 |

## 九、验证记录

| 检查 | 结果 |
| --- | --- |
| `npx vitest run` | 122 files passed / 1 skipped；1,418 tests passed / 1 skipped；exit 0 |
| `npm run typecheck`（单独运行） | 通过，0 error |
| `npm run check:docs` | 通过：28 maintained documents、28 双语对、360 links |
| `npm run check:core-skills` | 通过：3 skills，`team-domain-model` 7,829/7,850 字符 |
| `node --import tsx scripts/check-team-trial-metrics.ts` | 通过，但 fixture 仍按旧投递模型，不能发现指标偏差 |
| 真实账本重放（`/tmp` 只读副本） | 失败：`invalid Thread read projection` |
| 真实账本在 `7558dfd` 上重放 | 通过 |
| 探针修复后重放当前构建 | 通过：25,525 条操作 |

补充：`npm run typecheck` 与全量测试并发运行时曾出现 `typert` 相关瞬时错误并仍返回 0；单独运行通过。复核结论以单独运行为准，但该并发行为本身值得在检查文档中说明。

## 十、未验证范围

- 未启动完整 Host 与 Web UI；重放失败已能证明构造阶段会拒绝该账本，但没有观察 `pnpm dsh --profile web-dev` 的实际界面表现。
- 未运行 `npm run test:browser`。本工作项改动了 Client 的 Main stream standing 字段（`owner` → `following`），试用前应补跑。
- 未用真实模型验证修改后的指导文案是否减少误用；这属于 `agent-tools-context-rendering` 的验证范围。
- 未修改仓库代码；所有探针均在 `/tmp` 中完成，工作树在复核前干净。

## 十一、建议处理顺序

1. 修 blocker：legacy 快照 source 比较 + read 操作 source 继承 + 真实形状回归用例。
2. 修模型可见文案：`team_thread`、`team_message`、`team-domain-model` core skill。
3. 修试用指标脚本并补两项 fixture。
4. 补票据 02.6、05.3 的测试与文案；修 `CHANGELOG` / `host-authority` 的 source 校验表述。
5. 明确 Human unfollow 与离开 Workspace 的语义，统一文档。
6. 全量测试、`test:browser`、真实账本重放。
7. dev profile 人工试用，完成后重新归档。
