# 团队管理会话

- **状态：** 2026-11-13 设计复核把入口 Workspace 归属收敛为 [D26](materials/decisions.md#当前决策)：默认 Workspace → 第一个现有 Workspace → 普通空状态；不再建专用 Workspace。票已按新契约重排为 01–08，实施未开始；01、02 各经过一次 fresh-context rehearsal，补齐 rules version、更新请求/Remote、Activity kind、长度边界、Client 入口路径、owner 专用工具策略和导航目的地后判 ready。01 会把账本 rules version 从 7 升到 8，发布时按现有升级说明处理。起点是 [issue #64](https://github.com/Contexera/dsh-agent-team/issues/64) 下「由一个 Agent 创建与管理全局 Agents」的提议；Human 将它定为常驻的团队管理入口。
- **最后核对：** 2026-11-13。
- **仓库根与基线：** 仓库根：本仓库；相邻 Harness checkout：与 Team 仓库同级的 `deepseek-harness`。设计对照 Team 0.2.8（`4a233446`）与 DSH 0.2.2-rc.2（`ddac9676`）；实施前按 rc.2 复核或更新 checkout。
- **当前进度：** [01 owner 责任字段](issues/01-owner-responsibility.md) 和 [02 会话入口](issues/02-owner-session-entry.md) 可开始。[03 读取](issues/03-owner-reads-team.md) 等待 01、02；[04 建立责任](issues/04-staff-a-project.md) 等待 03；[05 调整成员](issues/05-adjust-a-member.md) 等待 03；[06 调整 Project](issues/06-adjust-a-project.md) 等待 01、03；[07 记忆与私有 skills](issues/07-owner-memory-and-skills.md) 等待 02；[08 内置 skills](issues/08-owner-guide-skills.md) 等待 04–07。01、02 已做 rehearsal 并补齐缺口；04 转 `ready` 前再做一次。
- **完成条件：** 01–08 各自通过验收；真实 Web 组装验证入口、提问卡、冷恢复和归档替换；管理写入能解释拒绝、部分成功和撤权；dev profile 验收组建、调整、引导、记忆与 skills 场景。
- **验收 owner：** 默认由 lead reviewer 逐票验收；Human 负责最终产品验收（入口形态、引导质量、团队落地效果）。逐票评审不替代 Human 的最终验收。
- **正式文档归宿：** 术语与产品定位 → [领域模型](../../../docs/domain-model.md) 和[项目 README](../../../README.md)；权限、工具与恢复 → [Host 权威](../../../docs/architecture/host-authority.md)、[工具与 preset](../../../docs/architecture/tools-and-preset.md)、[Workspace 和 Session](../../../docs/architecture/workspace-session-storage.md)及 [协作契约](../../../docs/team-collaboration/)；管理会话记忆与 skills → [记忆与上下文](../../../docs/team-collaboration/memory-and-context.md)。

## 阅读顺序

先读 [设计快照](spec.md) 和本 README；决策沿革与已取代方案见[决策记录](materials/decisions.md)。依据材料：[定位与责任原则](materials/product-principles.md)、[产品与现状](materials/facts.md)、[Harness 能力](materials/harness-support.md)、[领域用语](materials/vocabulary.md)、[流程、prompt/context 与 skills 参考](materials/flows-and-guidance.md)。

派发时给 worker 仓库根、票、本 README 和票中列出的 binding 参考；不要让它从整份历史里重新推导产品决策。
