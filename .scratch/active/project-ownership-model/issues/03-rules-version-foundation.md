# 03 — 规则版本机制

**What to build:** ledger 能记录“从哪条记录开始换了一套校验规则”，replay 时每条记录按它写入时的规则校验。本票只建机制并把现行规则整理为版本 1 的 replay 校验器，用户看不到变化；规则版本 2 的标记在 06 完成前不写入真实 ledger。

**Blocked by:** 02

**Status:** complete

- [x] 新增 `team/rules-version-adopted`（Host actor，`{ version }`）；无标记的 ledger 段为版本 1
- [x] 标记单调递增、每个版本至多一条；重复、倒退、非 Host 写入、或版本高于本构建实现的版本时加载失败（“早于该版本的写入”由写入顺序保证，回放无法区分，不在回放中校验）
- [x] Host 启动顺序：`initialize()` → `sweepWorkspaceParticipations`（会写 leave）→ 换代收尾 → 激活 / converge。标记在 `initialize()` 自己排队的任务里追加，因此早于之后所有写入（含启动恢复和中途插队的 Remote 调用）；全新 ledger 在 `team/initialized` 后立即写。当前实现版本为 1，不写任何标记
- [x] 规则版本成为 Projection 上的事实（`rulesVersion`），校验与写路径都从这里取。现行规则暂不搬到独立模块：还没有任何规则分叉，提前拆分属于投机结构；04–06 第一条按版本分叉的规则落地时，再把旧分支集中为 replay-only 校验
- [x] 历史 accept 缺 `acceptedClaimRefs`：原有测试已覆盖回放与静默语义，本票在其后追加版本 2 标记再回放，结果不变
