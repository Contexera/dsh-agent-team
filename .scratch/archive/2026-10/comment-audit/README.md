# 注释审查（全量）

> 本工作项是 `dsh-agent-team` 一次全量注释审视的容器：判据、证据、删除执行与重构建议都归这里。它不定义当前产品行为；行为以 `packages/` 源码和测试为准。

**状态**：**已完成（2026-10-19）**——删除、A/B 档重构、C 档类型化全部实施并合入 master。
**最近核对**：2026-10-19 17:00
**当前前沿**：无。

**决策快照**：见同目录 [`spec.md`](spec.md)（判据、基线、范围决定、已知干扰）。

**完成条件**
- [x] 生产代码（Host 包）不成立的注释已删，`npm test` + `typecheck` 全绿
- [x] 生产代码（Client 与 tool 包）同上
- [x] 测试文件同上
- [x] `scripts/` 同上
- [x] 约束型注释（5 处 `do not remove`）逐条证明或清除
- [x] 140 条 `MUST KILL` 整理成清单交 Human
- [x] A 档 12 条 + B 档 B1–B5 实施完毕（B 表 84 行中 80 行实施，4 行经复核驳回，理由见 `refactoring-candidates.md`）
- [x] C 档：6 条实施，4 条经复核跳过（前提不成立或收益不足），`tools.allow` 决定保留

**正式文档出口**
- 约束型注释涉及的同一说法已从 `docs/architecture/host-authority.md` 双语对与 `packages/agent-team/README.md` 双语对移除
- 重构改动公开契约后，同两处文档的 "live selection ref" 措辞已更新为 "live selection swap on the mounted provider"（双语对同步）
- 其余结论只是"注释不该留"，无文档改动

## 结果

### 注释删除（已合入 master `1db10e49`）

| 项 | 数值 |
| --- | --- |
| 删除注释行 | 1145 |
| 附带删除的空行 | 22 |
| 修改文件 | 94 |
| 保留的注释块 | 95 |
| 代码行改动 | 0 |

分桶（删除行数）：`agent-team/src` 521、`agent-team/tests` 310、`client/src` 92、`client/tests` 91、`tool` 85、`scripts` 83、docs/README 4。

保留的 95 块按判据分布：外部强制事实 48、公开类型契约 41、文档指针 2、工具指令 2、Remote 方法契约 1、约束型 1。

### 重构实施（已合入 master `23385f99`）

单 commit `19f8f79c`，99 文件 +2208/−1582。

| 项 | 数值 |
| --- | --- |
| A 档缺陷 | 12/12 |
| B 档改名 / 抽函数 | 表格 84 行中 80 行实施（原估 ~95），4 行经复核驳回 |
| C 档公开类型 | 6 条实施，4 条跳过（C1.3、C1.5、C2.2、C2.4） |
| 复审后补漏 | 9 项（含 1 个 `AUDIT_ONLY_KINDS` 死代码、1 个 `undetermined` 字段漂移回归） |

逐条明细、驳回理由与 C 档跳过理由见 [`refactoring-candidates.md`](refactoring-candidates.md) 开头。

## 验证

### 注释删除（基线，master `1db10e49`）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | 1125 passed / 1 skipped（与基线一致） |
| `npm run lint` | exit 0（仅 4 条既有 warning） |
| `check:docs` | OK |
| 删除行全部为整行注释 | 是（1145/1145） |
| 保留块与删除集无重叠 | 是（0/95） |
| 无孤儿块标记 | 是（0） |
| suppression 未被误删 | 是 |

### 重构实施（合入 master `23385f99`）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | 1142 passed / 1 skipped（连续三次复跑一致） |
| `npm run test:browser` | 6 passed |
| `npm run lint` | 3 条既有 warning，无新增 |

## 材料

过程材料（24 份 `comment-sicko` 原始报告、分片清单、机械校验与删除计划的中间 JSON）已按 [`../AGENTS.md`](../AGENTS.md) 的生命周期规则删除：它们是可重新生成的中间产物，结论已全部固化进 [`refactoring-candidates.md`](refactoring-candidates.md) 与 `issues/`。

**报告是输入不是结论**：当年的 `verified.json` 只证明"这条建议指向的行当前确实是注释"，不证明"这条注释该删"。

## 遗留

- 无。C 档 6 条已实施，4 条经复核跳过（理由见 `refactoring-candidates.md`）；`tools.allow` 决定保留——Remote 写入路径是真实消费方。
- 原来 3 处失去解释的空 `catch` 已随 A11 处理：`attachments.ts` 抽 `readCacheEntry`、`navigation.ts` 抽 `persistLocallyBestEffort`、`index.ts` 的 `syncHumanHandle` 那处是死代码（optional chaining 已覆盖），已删。

## 已知边界

- 报告生成于 2026-10-14 20:50–23:24；校验按**当前**文件内容重做，过期行号已剔除。
- 判据来自 `no-comments` skill 的封闭清单；本工作项不重新定义该判据。
- 执行过程中三次因删除规则不精确而回滚重做（详见 `issues/07-execution-log.md`）。
