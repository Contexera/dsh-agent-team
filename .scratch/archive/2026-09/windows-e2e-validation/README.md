# Windows 原生环境 e2e 排查（#7 修复回归 + Windows 路径语义面）

**状态：** complete — archived 2026-09-06（Human 于 thread:cb7e5eca 拍板归档）；结论以 [`validation/report.md`](validation/report.md) 为准。
**最后核对：** 2026-09-06（含晚间 F11 追加）。

**当前前沿：**
- 三层清单全部执行完毕：第一层 4/4 PASS；第二层路径语义面通过（长路径 home 有一处 F10 失败边界）；第三层 typecheck PASS、npm test 25/28 文件（6 个失败全部归因 F7/F8）、浏览器旅程 1/1 PASS、真实模型 turn SKIP（无 key）。
- 发现 F1–F10 已连同错误原文、最小复现与 WSL 对照写入 findings.md 与报告；#8 冒号类别已真实环境复现（0 字节 payload + ADS），保留名/尾点在 Win11 26100 不复现。
- **F11（晚间追加，已修复并 CI 验证）：suspend→resume 卡 `unavailable` 根因定位并修复** —— Harness JSONL 后端 win32 durable-mkdir staging 与 list() 遍历的竞态。插件侧修复已推送 fix 分支（`5fb2c1a` fix + `a37bfdc` test）：resumeMember 跳过 racy 全树 list、activateMember/接入 ENOENT 有界重试、CI 断言携带 diagnostic；Windows 真机 red→green + 全量 ×2 全绿；CI run 34030051849 **windows ✓ + linux ✓（该分支 windows 首次通过）**。Harness 侧根修（list walkers 过滤 staging 前缀）待上游，见 findings.md F11。
- 测试脚本、junction shim、resume-race driver 与证据在 Windows 侧 `C:\Users\wowyuarm\src\dsh-win-test\`（不在本仓内）。

**结束条件：** 已满足——报告交付；issue 草稿内嵌报告（F2/F3/F6/F7/F8/F10 为可立 issue 项，#8 复现证据可直接回帖；F11 为新候选 issue，根因与修哪一层建议已备齐）。

**正式文档出口：** 不回写 docs/（只测不修）；`docs/development/README.md` 的候选修订点（F1 环境卫生项、F2 packageManager 事实修正）已列入报告建议段，待团队决策。
