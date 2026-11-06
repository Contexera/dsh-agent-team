# DSH 原生会话的压缩行为（对照用，11-06 核）

## 参数（`packages/compaction/compaction-basic`）

- **触发**：`thresholdRatio` 默认 **0.8**；实际阈值 = `min(窗口 × 0.8, 窗口 − 请求 maxTokens − headroomTokens)`。
  - hy4free（窗口 96 万、请求 maxTokens 64K）⇒ **~76.8 万**；deepseek-v4.1-flash（窗口 100 万、maxTokens 384K）⇒ **~55 万**。
- **摘要预算**：`maxTokens` 默认 = `headroomTokens` = **65,536**；Team 预设原钉 **16,384**，11-06 起改为 **32,768**（本 work item 的预算调整）。
- **保留尾巴**：`retainRatio` 默认 0.16（最近 16% 逐字保留）；Team 的 admission 走 `context-overflow` 分支，保留 0（几乎全量摘要）。
- **摘要目标**：`summarizeWithLlm` 的 `configured ?? latest ?? agentTarget`；`latest` = 最后成功的请求头。**原生默认就是当前路由模型**，只有静态的 `summarizationProvider/Model` 覆盖。
- **重试**：`compactionRetries` 默认 1、`maxOverflowRetries` 默认 1。

## 三条失败路径（同一引擎）

1. **每步前的压力压缩**（`agent/pre-step`，`trigger='pressure'`）：失败只 `logger.warn` 并**继续本轮**——请求照发。
2. **切换模型**（`agent/request` prepend 里的 `compactPressure(..., requireBelowThreshold=true)`）：失败抛 `MODEL_SWITCH_COMPACTION_FAILED`（"Cannot switch to …; the previous request model is preserved"）——**原生也有同一个死锁**，但只挡这一次切换；旧模型上的普通轮次照常。
3. **真溢出**（`agent/request-error`，provider 报 `CONTEXT_WINDOW_EXCEEDED`）：用 `trigger='context-overflow'` 恢复，最多 `maxOverflowRetries` 次；仍失败就 warn 并保留原始溢出错误——该轮失败。

## 和 Team 的差别

| | 原生 DSH 会话 | 成员会话（Team） |
| --- | --- | --- |
| 触发 | 模型窗口 × 0.8（或窗口 − 输出 − headroom） | Team 的固定预算：默认 256K，现 300K |
| 摘要预算 | 65,536（默认） | 32,768（预设；11-05 前是 16,384） |
| 摘要目标 | 当前路由（最后成功请求头） | 同左（本 work item 要改） |
| 压缩失败 | 压力路径吞掉继续；切换被拒；溢出重试后保留原错误 | **admission fail-closed：每轮在发请求前失败** |
| hy4free 26.5 万 | 不触发（阈值 ~76.8 万） | 触发（>256K/300K），失败即锁 |

## 结论

原生的「摘要写不出来」不会让会话每轮提前失败；是 Team 的固定预算 + 16K 上限 + fail-closed 把一次摘要失败放大成成员不可用。修复只改成员引擎，**原生行为不变**（不碰 Harness）。
