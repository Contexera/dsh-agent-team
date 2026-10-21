# 02 — checkpoint 投影自持化（v2 不变）

**What to build:** Team 的 context 投影（checkpoint ref 铸造 `context-checkpoint-<sha256>` / `team-boundary-<sha256>`、Team message/attention/claim 边界锚点、换代的 pending intent 追踪、rollover guard 的重校验、崩溃恢复读的 fold 状态）由本仓自足代码提供，零 cc import。旧会话录下的事件在新 fold 下仍正确解码（含 legacy 工具名 `new_context`、`team_thread` 时代的 attention 对）。
**Blocked by:** None — can start immediately（与 01 并行，但在 04 删除 cc 前两者都必须就位）
**Status:** complete

**Outcome (2026-10-21):** 已落地。投影自足、零 cc import；最终 `stateVersion` 为 3（删掉 boundary/`seenTopics`/`lastTurnEndSeq`），旧日志解码保留，`context-projection-legacy.spec.ts` 钉住版本号。

- [x] 恢复 `2b8d3eef` 时代自足的投影实现为底，对齐现役 `context-projection.ts` 的公开面（`checkpointRefFor`/`boundaryRefFor`/`checkpointByRef`/fold 定义注册）
- [x] **自持 codec**：现役 `context-projection.ts:49` 从 `context-continuity-host.ts` 取 `TEAM_CONTEXT_CODEC`，而 04 要删该文件——本票必须把 codec 收进本仓（只读解码 + byte-identical 写形），否则 02 不可独立完成
- [x] 现役 `context-projection.spec.ts` 全绿（必要时把 cc 类型的 import 换成本仓等价类型，断言不变）
- [x] legacy 解码测试在：旧事件（`new_context` rollover、`team_thread` 版 attention）cold-fold 仍解析出 pending intent 与 boundary
- [x] 投影注册键、codec、ref 形状与现役逐字节一致（历史 durable 日志可读回）
- [x] checkpointRef 回退的消费方（restorable 判定）随 04 删除时，投影侧对应裁剪
