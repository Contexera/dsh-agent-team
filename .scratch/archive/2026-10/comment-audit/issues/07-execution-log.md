# 07 — 执行记录（2026-10-15）

**Status:** complete

## 结果

| 项 | 数值 |
| --- | --- |
| 删除注释行 | 1145 |
| 附带删除的空行（避免双空行） | 22 |
| 修改文件 | 94 |
| 保留的注释块 | 95 |
| 新增行 | 6（4 处文档改写 + 2 处 doc 重排） |
| 代码行改动 | 0 |

分桶（删除行数）：`agent-team/src` 521、`agent-team/tests` 310、`client/src` 92、`client/tests` 91、`tool` 85、`scripts` 83、docs/README 4。

保留的 95 块按判据分布：外部强制事实 48、公开类型契约 41、文档指针 2、工具指令 2、Remote 方法契约 1、约束型 1。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | 1125 passed / 1 skipped（与基线一致） |
| `npm run lint` | exit 0（仅 4 条既有 warning，与本次无关） |
| `check:docs` | OK |
| 删除行全部为整行注释 | 是（1145/1145，脚本逐行校验） |
| 保留块与删除集无重叠 | 是（0/95） |
| 无孤儿块标记（`/**` 无 `*/`） | 是（0） |
| suppression 未被误删 | 是（`oxlint-disable`、`@ts-expect-error` 全在） |

## 过程中的三次修正

1. **首次删除把区间合并，吞掉了中间代码行**（69 行，如 `const TEAM_BOUNDARY_KINDS`）。加逐行校验后发现，改为只取"极大连续整行注释段"。
2. **极大连续段仍会吞掉相邻的保留块**：`index.ts` 那条 dsh 0.1.7 的外部行为注释被误删。回滚，改成以**单个注释块**为单位删除，逐块判保留。
3. **全局折叠空行误伤了 4 处 HEAD 原有的双空行**。回滚，改成仅在"删掉注释后会出现双空行"时额外删掉紧邻的一个空行。

三次都是先回滚再改规则，最终版本经过逐行闸门校验。

## 遗留

- 3 处空 `catch` 块因注释被删而失去解释（`attachments.ts:207`、`index.ts:787`、`navigation.ts:70`），列入 ticket 06 的 MUST KILL。
- `attachments.ts:205` 的 `scanAttachmentCache` 空 catch 现在无任何说明，是最需要处理的一处。
