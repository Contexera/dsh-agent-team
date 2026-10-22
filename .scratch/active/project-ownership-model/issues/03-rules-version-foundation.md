# 03 — 规则版本机制

**What to build:** ledger 能记录“从哪条记录开始换了一套校验规则”，replay 时每条记录按它写入时的规则校验。本票只建机制并把现行规则整理为版本 1 的 replay 校验器，用户看不到变化；规则版本 2 的标记在 06 完成前不写入真实 ledger。

**Blocked by:** 02

**Status:** ready

- [ ] 新增 `team/rules-version-adopted`（Host actor，`{ version }`）；无标记的 ledger 段为版本 1
- [ ] 标记单调递增、每个版本至多一条；重复、倒退或晚于该版本段内其他写入时加载失败
- [ ] 查清 Host 挂载与启动恢复的写入顺序，保证标记早于启动恢复期间的生命周期 effect；全新 ledger 在 `team/initialized` 后立即写当前版本
- [ ] 现行 inbox delta 校验规则集中为版本 1 校验器；写路径只调用当前版本
- [ ] 补一个测试：历史 accept 缺 `acceptedClaimRefs` 时的唤醒语义在新机制下不变
