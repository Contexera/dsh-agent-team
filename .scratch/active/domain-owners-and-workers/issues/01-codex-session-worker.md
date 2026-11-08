# 01 — 从成员 Session 派出 Codex Worker

**What to build:** Human 可以在 Team 设置开启实验性 Worker；目标 Project 的 Agent owner 可以不建 Thread，指定 Project 后在成员 Session 委派一次本机 Codex。启动先返回执行编号，后台结束后只通知发起 Session。
**Blocked by:** None — can start immediately
**Status:** ready

- [ ] 设置默认关闭，打开后明确展示本机 CLI 会按配置的原生权限执行；可启用 Codex 并用它作默认。普通 DSH Session 的工具和加载行为不变。
- [ ] 工具对 Team 成员统一可见；未启用、未指定有效 Project、非目标 Project owner、请求未启用的引擎均在启动原生进程前拒绝。未安装和打开失败有可理解的错误。
- [ ] 同一次发起请求重送不会多开进程；Host 在启动前记录可追踪的执行编号。接纳后发起者能继续对话；完成或失败只向原 Session 报告一次，不建 Task、不发 Main，离线不补投。
- [ ] Team 自有 OAR provider 通过 Harness 管理执行。使用明确的原生权限和清理规则，遵守现有环境清理约定；实际发布组合验证成功和打开失败后没有残留进程。不改 Harness 仓库或普通 DSH 配置。
- [ ] 发起者可指定已准备的工作目录；实验配置允许真实文件修改，不加 checkout 锁，不自动创建 worktree。用隔离目录验证一个小改动。
- [ ] 常驻引导和工具说明让 owner 能写自包含任务，并说明启动后可以继续、无需轮询。完成可重复的受控验证和已安装 Codex 的原生验收。
