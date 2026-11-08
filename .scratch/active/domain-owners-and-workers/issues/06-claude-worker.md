# 06 — 接入 Claude Code 并验证默认和显式选择

**What to build:** Human 可启用本机 Claude Code 并选默认；owner 可在单次委派中覆盖默认值。Codex 与 Claude Code 都可发起、同轮追加指令、停止、按编号只读查诊断，并按同样的规则回传。
**Blocked by:** 04 — 按执行编号只读查看 Codex 失败；05 — 给正在执行的 Codex 补充指令
**Status:** pending

- [ ] 只启用 Claude Code 时可直接发起；两个引擎都启用时，无显式选择使用默认，显式选择使用指定引擎；不可用时不自动切换。使用本机原生登录及明确的非交互权限。
- [ ] 使用发布的 Claude Code CLI 验证正常、失败、超时、停止回传、真实文件修改和进程退出后的原生会话读取。按原 session ID、目录与配置位置只读查询，不恢复会话；错误目录或记录缺失时不扩大搜索。两种引擎按绑定 Thread／Task 或仅 Project 的规则回传状态、结果和可用诊断；并行执行不串结果或历史。
- [ ] 使用发布的 Claude Code CLI 实测：工具运行中提交 steer，工具返回后的同一轮下一次模型调用收到指令，只产生一个终态。指令临近结束或停止时，不得排到下一轮、启动额外执行或投到另一 Worker；无法确认同轮送达时不得报成功。Claude steer 与 Codex steer 一样是首版必验项。
- [ ] 用完整组合验证订阅触发后 owner 派 Worker、继续回应 Human、结果回原 Thread；同时覆盖临时执行、只停其中一次和普通 DSH 恢复。按仓库要求完成浏览器验收，并更新已交付的维护文档和包 README。
