# 05 — 完成 RC 认证并声明新区间

**What to build:** 用户可以把候选 Team bundle 安装到 DSH 0.2.2-rc.1，既有 Member 历史可升级打开，声明的版本区间、CI 和维护文档都由通过的认证证据支撑。
**Blocked by:** 01, 02, 03, 04
**Status:** in-progress

- [x] 在独立、不可变的 RC Harness 检出中完成 Typert 稳定性、typecheck、完整测试、lint、build、pack、artifact 和 diff 检查。
- [x] 完整浏览器认证通过：普通 DSH → Team → 普通 DSH、Member 创建与恢复、Remote、slot 接管、设置、桌面和窄屏均正常，普通 Session 无 Team 工具或提示词。
- [x] 上一认证线写下的 Member Session（含至少一次换代）全部打开并记录检查数量与结果；当前已发布 Team bundle 在候选 DSH 上的可用性也有明确结论。
- [x] 空目录安装解析为单一 DSH 代际，无嵌套旧包和 peer 冲突；真实发布布局可启动、Team Host 真的挂上。（「在真实 profile 布局里创建 Member」未单独实测——要走认证的 Web/WS RPC，curl 够不到；这一项由候选 bundle 的 13 条浏览器旅程覆盖，记「未测量」不记 0。）
- [ ] 认证通过后，engines、全部 DSH peer、CI 基线、README 和兼容文档原子移动到 `>=0.2.2-rc.1 <0.2.3`，版本一致性与发布布局检查通过。（engines / 49 peers / `DSH_HARNESS_TAG` / README 双语 / compat 文档 §6「当前基线」段已在 `121611c4` 随源码迁移一起落地——不抬 facades 与区间就无法在 rc.1 上编译测试；`check:versions` 16 处一致、`check:docs` 双语 29 对全过。**独立验收 17:18 判绿，前置条件已满足，但仍缺两件**：compat 文档双语的 `### DSH 0.2.2-rc.1` 认证历史段——按独立验收证据第 3 条它必须点名发布版本，所以跟发布动作同批落地，草稿已写在 `materials/2026-11-05-rc1-certification.md` §6；以及版本点 0.2.6 → 下一版 + release 段 + tag + 推送 + 发布，等 Human 口令。树未推送、npm 上 0.2.6 仍带旧区间，所以提前移动没有用户可见后果。）
- [x] 工作项记录最终证据与剩余风险；没有未经授权的发布、推送或 Harness 修改。
