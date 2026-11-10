# 06 — 接入 Claude Code 并验证默认和显式选择

**What to build:** Human 可启用本机 Claude Code 并选默认；owner 可在单次委派中覆盖默认值。Codex 与 Claude Code 都可发起、同轮追加指令、停止、按编号只读查诊断，并按同样的规则回传。
**Blocked by:** 05 — 已验收（`d421d42`，已合回主树）；04 已在 `032e10f` 验收。
**Status:** complete — 已实现范围于 2026-11-10 经 Reeve 独立验收；Claude steer 以能力阻塞关闭，保持未勾选、不开放，不计为通过。主交付 `2b22c59`，验收补修与完整门禁见 [独立复核](../materials/06-independent-review.md)。Task #142 task:0e069f47-daad-4531-8096-9728512c013e，Thread thread:a6d0bcd1-7f9f-45da-bff4-d4646e1109a3。原生证据见 [06 预检](../materials/06-claude-precheck.md)：Claude Code 2.1.319／OAR 0.95.1 在工具结果产生后写入（哪怕只晚 20ms）可能排成新一轮，`accepted` 不等于同轮送达。

**解除 05 的 Codex-only gate 的条件（2026-11-10 Reeve 定）：可验证地阻止指令落到下一轮**——写入前拿到与写入原子化的原生判据，或可控执行边界。**换回执文案不构成解除理由**：即使回执只写「工具执行中提交」，晚到消息另开一轮仍违背本票要求。若公开接口守不住，本票按能力阻塞交付（Claude 的 steer 不开放），不把「通常在工具执行中可用」写成已交付。Aster 已核：OAR 0.95.1 的公开接口没有这样的边界（`steer` 不登记 inputId、`withdraw` 撤不回已写出的输入、`cancel_async_message` 无实现），因此 Claude 的 steer 保持不开放，本票按能力阻塞交付；其余三条不受影响。

- [x] 只启用 Claude Code 时可直接发起；两个引擎都启用时，无显式选择使用默认，显式选择使用指定引擎；不可用时不自动切换。使用本机原生登录及明确的非交互权限。`2b22c59` 交付，独立原生探针验证。

**Human 2026-11-09：两个 CLI 的沙箱权限都应是全部权限（等同 `danger-full-access`），不要求操作者配置。** 落地现状：Codex 的设置行默认值已从 `workspace-write` 改为 `danger-full-access`（`DEFAULT_WORKER_SANDBOX`），OAR 0.95.1 自身也是 YOLO 默认（`claude --dangerously-skip-permissions`、codex `approvalPolicy never` 且 sandbox 默认关闭），因此 Claude 侧不应再加任何权限字段；票 06 验收时要证明 Claude 在未配置任何权限的情况下能以全权限跑完，而不是要求填 `sandbox`。
- [x] 使用发布的 Claude Code CLI 验证正常、失败、超时、停止回传、真实文件修改和进程退出后的原生会话读取。按原 session ID、目录与配置位置只读查询，不恢复会话；错误目录或记录缺失时不扩大搜索。两种引擎按绑定 Thread／Task 或仅 Project 的规则回传状态、结果和可用诊断；并行执行不串结果或历史。独立验收探针全绿并正常退出；明确 401 验证无凭据失败，死端口重试不冒充认证失败。
- [ ] 使用发布的 Claude Code CLI 实测：工具运行中提交 steer，工具返回后的同一轮下一次模型调用收到指令，只产生一个终态。指令临近结束或停止时，不得排到下一轮、启动额外执行或投到另一 Worker；无法确认同轮送达时不得报成功。Claude steer 与 Codex steer 一样是首版必验项。
  - **本条不是「回执如实」就算过。** 晚到指令另开一轮本身就违背「不得排到下一轮」，所以「报告未确认」只是不撒谎，不是满足本条。只有可验证地阻止它落到下一轮，本条才能勾选；否则本条记为本票的能力阻塞，Claude 的 steer 保持不开放。
- [x] 用完整组合验证订阅触发后 owner 派 Worker、继续回应 Human、结果回原 Thread；同时覆盖临时执行、只停其中一次和普通 DSH 恢复。按仓库要求完成浏览器验收，并更新已交付的维护文档和包 README。新增真实工具回放的组合场景通过；完整浏览器 18/18、178 张截图，独立核查桌面／390×844。

**验收要求（2026-11-09 Human 决定）**：Claude 必须按全权限、零配置运行。OAR 在没有 `--permission-mode` 时自动 `--dangerously-skip-permissions`，所以 Team 侧应保持 `launchArgs` 为空，并用测试钉住"不传权限模式"（一旦有人加了 `--permission-mode`，验收即失败）。
