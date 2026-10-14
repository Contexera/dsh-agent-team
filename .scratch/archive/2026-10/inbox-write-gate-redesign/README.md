# inbox-write-gate-redesign

- **Status:** 已关闭并归档（2026-10-14）：两票落地、Reeve review 通过、human 裁定规矩；结论已进 maintained docs。
- **Last checked:** 2026-10-14
- **Current frontier:** 无。落地 @Vera，review @Reeve 已通过；压缩链后由 Reeve 做 tree-identity 复核再推。
- **Completion conditions:** human 验收设计 ✓；票据全部 complete ✓；Reeve review 通过 ✓（两 minor issue：issue 1 已修 `751b9ce7`，issue 2 记为已知边界）；复测已跑，见下。
- **Formal-doc exit:** 结论进 `docs/team-collaboration/boundaries.md`（双语）、`docs/team-collaboration/boundaries.zh.md`、双语 package README、CHANGELOG Unreleased；`.scratch/AGENTS.md` 补「active 不进、完成后归档 amend」规矩。本目录已移入 `archive/2026-10/`。

## 复测结果（@Vera 跑，2026-10-14T13:41+08:00，`measuredAt` 固定时点）

- 全部 Team 调用分母下：`unread_required` 211 次；其中**notice 带 direct 正文 59 次**（通道 B 可豁免）、**只有计数 17 次**（通道 B 结构上不中）、**前面无 notice 135 次**（通道 B 零帮助）。
- 通道 B 消掉一次往返 59 次（占全部 unread 拒绝 28.0%、占 notice 带正文 77.6%、占全部 Team 调用 5.9%）；通道 C 缩短一次往返 174 次；两者合计占全部 Team 调用 23.3%。
- 比比率不比绝对次数：同脚本 11:44 给 46/15/74、12:00 给 49/16/78、13:41 给 59/17/135——移动靶，只可与同时点比。

## 来源

- Task: task:0674ba08-73ba-408b-8f18-fe5964bf7ff6 (#30), Thread thread:9a0bbe71-3ddf-406a-9cca-8208718faa0f
- Human 目标原话（2026-10-14T11:01:41+08:00, fact 23210）：解决 agent 总是被拒而可能陷入循环的问题，可能揭示 inbox 模型设计缺陷；不一定非要 agent 先读，而是 harness 能说明「该消息已在 agent context 中」（compaction/rollover 会复杂）；「挡住之后不是抛错、把新消息结构化带回来」也不错；不要求照抄 raft。
- Human 规矩裁定（2026-10-14T13:42:17+08:00, fact 23320）：active 一般不进版本史；一个 task 完成后 scratch archive 并 amend 进入实质性提交。
- @Vera 的实测与 raft 源码取证：Thread fact 23207 与 DM(2026-10-14T11:02:37+08:00)。
- raft 参考实现当时 clone 在 /tmp（已删）；证据摘录在本目录 materials/。
