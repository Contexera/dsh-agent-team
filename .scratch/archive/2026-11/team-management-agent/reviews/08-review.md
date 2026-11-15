# 08 independent review — 2026-11-15 Reeve

## 首轮范围与独立检查

逐 hunk 读完 `c48a721..7b850a4` 的一笔提交（14 文件，+197/−22）：两份内置 skill 及其 references、真实 bundled-root 发现测试、静态门禁注释、中英维护文档与 CHANGELOG。范围与票面一致，未新增 UI、Member 工具或巡视能力。

在 guide08 对固定 `7b850a4` 独立执行：

- `npm run typecheck`：exit 0。
- `manager-skills.spec.ts`：1 文件、5 用例通过；真实 root 发现 `team-management-guide` 与 `team-operations`。
- `npm run check:core-skills`：core 4 / manager 2；7 references、8 相对链接通过；guide 7745/7850、operations 7834/7850。
- `npm run check:docs`、`npm run check:comments`：exit 0。
- `npm run lint`：0 error、110 个既有 warning。

## 首轮结论：不通过

静态与装载机制成立，但内容契约有两处会引导错误恢复：

1. `team-operations/references/failure-recovery.md` 把 archived grantee 的下一步写成 `resume`；本版 archive 没有 restore 入口，`resume` 只接受 suspended。
2. 同表把「manager replaced mid-write」一律解释成未写入。只有进入账本临界区时被重授权拒绝的排队写入能这样判定；撤权前已接收的写入可以完成，未知结果仍须 read back 或同 requestId/参数 replay。

一并要求对齐两处非阻断但失真的引导：Task accountable 可以是 Human 或 Agent Member；需要读 repo 时应按 `team_overview` 的 checkout 自行进入并读指令，而非只有 Human 指出路径才可读。

修正要求已发 Task #157 Thread。最终 verdict 等修正提交与复跑；上述绿灯不代替内容验收，更不代表 Human 已实际阅读或使用。

## 实施者内容评审与待补例子

Tome 交付时报告已按票面逐项检查，并在自审中修正私有资产绝对禁止、重复记忆/skill 教程和九工具含糊表述。仍需真实使用后补充的例子：多 owner 共担一个 Project、跨 Project/Workspace 复用同一 Member、一次真实「激活失败 → 修模型 → recover」端到端记录。不得为补齐示例编造 Human 结论或真实输出。

## 修正后结论（2026-11-15）

**通过。** 逐 hunk 复核 `7303255`，四处文字均与现行契约及已确认产品原则一致：archived 不再指向 resume；manager 替换区分临界区拒绝与已接收写入；Task accountable 包含 Human；repo 在需要时按 overview 的 checkout 自行读取。

独立复跑 `check:core-skills`（guide 7841/7850、operations 7843/7850，7 references／8 链接）、`check:docs` 与 manager-skills 5/5，全部 exit 0。最终全量门禁和浏览器车道在整合 HEAD 统一执行。Human 实际阅读/使用、真实模型是否按 skill 作出合适判断仍未验证，不写成通过。
