# 04 — 七工具契约清单与 Q3 证据（SCOPE 主项）

**What to build:** SCOPE「只读审查清单」的逐工具落地：七个 Team 工具逐一对照 schema → execute → structured result → render → tests → maintained docs，标出共享 helper 与私有 renderer 的真实边界、相同概念的不同命名、输出省略后是否仍指出完整事实的读取入口，以及全部输出预算。产出 Q3（本轮是否允许窄修 schema/action）的证据：哪些问题已确认、有无语料/测试证据、建议窄修还是记录不动。

**Blocked by:** None — can start immediately

**Status:** complete（2026-10-29 交付，见 `materials/2026-10-29-seven-tools-contract-inventory.md`；2026-10-29 编号调整：原 05 与本票互换，使编号符合「blocker 在前」——规则收敛票（现 05）阻塞在 02 上，排在后）

- [x] 七张逐工具契约表（schema 参数/默认值/Workspace 推断、execute→Host operation、structured result、render、拒绝路径、测试、正式文档）
- [x] 共享 helper 与私有 renderer 边界（`rejectionLines`/`nextWriteLine`/`taskStanding`/`boundedSubject`/`factLine` 共享；每个工具一个 `render`；`main-stream.ts` 一组共享）
- [x] 输出预算总表（inbox 50/100、board finished 5/100、Thread read 批次 20、Main read 页 20、history/view 20/100、subject 80、gist 120、通知正文 8K）
- [x] 相同概念命名一致性核对（token 交接句、`Not committed`、ref 格式、读取入口指引）
- [x] Q3 证据：已确认的 schema/action/result 问题分级（窄修候选 / 有意的非对称 / 框架限制记录）
- [x] 未覆盖边界写明（通知文本待 `team-performance-optimization` 定型；Client/Remote 不在本票；模型评测未重跑）
