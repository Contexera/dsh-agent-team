# 05 — 每条规则只放一处

**What to build:** 每步重发的固定文本里，同一条规则只在同一个地方说一次：persona 放跨工具工作流规则，工具 description 放本工具契约，参数 description 只写本参数格式（一句话），core skill 放按需查阅的表格。Attention 后果句收进一张共享短语表。固定文本字符量可度量地下降，且模型调用错误不回退。

**Blocked by:** 02（02 会改 token 规则与恢复句的原文，本票的重排以改后的原文为准）；04（契约清单已交付：其窄修候选会改工具描述，本票排在其后避免返工）

**Status:** pending

- [ ] 分工落地：ref 格式与缩写规则只在 persona 说一次（现在参数描述里 ref 格式重复 7 次、缩写规则 13 次，去重后省约 3.2K 字符，其中 workspace 参数七整段重复约 1.9K）；token 规则只在 persona 与 `missing_write_token` 恢复句；body 文风只在 persona。
- [ ] Attention 后果句收进一张短语表（现在 6 个 render 分支各自手写，只有原因短语共享 `CAUSE_OF_SOURCE`）。
- [ ] 前后对比固定文本字符量（persona + 七个工具 schema，基线 18.7K/33.7K 口径见提案 §1.0 与 2026-10-29 订正）。
- [ ] 用 `team-tools-model-eval` 的 live-eval harness 重跑基础与对抗场景，比较错误调用、恢复轮数与输出量，不得回退。
- [ ] 双语正式文档、core skills、package README 与 `CHANGELOG.md` 同步。
