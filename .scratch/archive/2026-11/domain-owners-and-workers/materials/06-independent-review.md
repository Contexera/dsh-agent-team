# 06 — 独立复核与组合验收

2026-11-10，Reeve。主交付 `2b22c59`；这份记录保留验收发现与证据边界，不代替源码、测试或维护文档。

## 复核发现与处置

- Worker 开关在回合边界等待期间，Member 的能力编辑可能已经提交。原实现拿等待前的 Member 快照重新装载工具限制，覆盖更新后的意图；`aeb04d5` 改为边界返回后重读账本，判别性回归验证新的 allow-list 不被还原。
- Claude 读取器起初只跳过目标 prompt 之前的记录，却一直读到文件结尾。用户日后继续同一个原生会话时，旧 Worker 的诊断会混入后续 turn 的模型和失败。`f26ec2d` 在下一条顶层 prompt 结束读取，保留同轮 tool_result、sidechain 和 meta 的正确处理；`463a1d1` 钉住原生继续会话的字符串 prompt。
- owner 引导把个人提醒误写成 owner 专属能力。`8490848` 分开陈述个人提醒与 owner-only 的讨论／Task／订阅权限；`9b78013` 删除误贴到 skills helper 的开关注释。
- 上述主交付与补修均逐个完整读取 diff，而非只采样熟悉的文件。原生锚点、停止／清理、读取安全、默认和显式引擎选择、动态系统提示的注册与换代边界均对照当前测试与接口核验。

## 真实组合的验证方法

新增订阅场景通过官方 Harness Web scaffold 的 replay 接口驱动真实 Agent loop：

1. Human 在设置页启用 Worker 并指定 Codex 可执行路径。
2. 调用订阅调度器的真实 timer 入口发布事件，durable Inbox 唤醒 owner。
3. 模型回放从实际请求解析目标 Thread ref，真实 `team_worker` 执行器发起两条绑定执行；不新增 Team Member。
4. owner 在两条 Worker 运行时回答；Human 读取 Thread 后定向提及 owner，给出唯一标记的待停止 ref。
5. owner 经真实工具只停止目标 Worker；读取原 Thread 验证停止已确认，兄弟执行仍运行，owner 继续回答 Human。
6. 离开 Team 模式后恢复普通 DSH 对话。

模型输出和 Codex app-server 是测试替身；工具声明、执行 guard、Host 授权、原生进程生命周期、订阅发布、通知与 Thread 结算均走真实组合。回放不证明模型会主动作出正确委派判断，也不替代发布版原生 CLI 的行为探针。设置／停止界面的桌面、390×844 和键盘证据仍由完整浏览器套件验证。

## 诊断中排除的假象

- 回放能强制输出模型当次工具表没有声明的工具调用。这样的拒绝说明 guard 正常，不能据此放松生产权限；本次没有为回放改动 guard。
- 订阅通知只命名 Main stream，不自动带入目标 Thread；回放引用必须来自真实 Member 上下文。
- 委派不会自动关注 Thread。后续 Human 回复需要有实际投递对象；测试必须分别维护 Human 与 Member 的读取边界。
- 不能靠 assistant 消息总数推断委派与结算；最终断言读取工具调用参数、每个 Worker 的绑定与终态，以及真实后续答复。

## 原生能力边界

发布版 Claude Code 2.1.319／OAR 0.95.1 的独立探针覆盖正常、明确 API 400／401、超时、停止、并行隔离、零权限配置下真实文件修改及退出后只读查询，已正常退出。详见 [原生验收证据](06-claude-precheck.md)。

Claude 同轮追加指令仍是能力阻塞，生产拒绝 `worker_steer_unsupported` 不变；没有把“回执诚实”或“工具执行中通常能到”算作通过。

## 最终门禁

- `npm run build`、`npm test`、`npm run typecheck`、`npm run lint` 已独立通过。完整测试为 194 文件、2333 用例通过；一条原有存储基准测试跳过。`npm test` 包含 facades、docs、core-skills、boundaries、versions 与 comments 检查，未跳过其中任何门禁。
- lint 为 0 error／111 warnings；既有警告未扩成清理工程。
- 新组合场景单独通过后，完整浏览器套件 18/18 通过，产出 178 张截图。已查看本轮 Claude 设置、窄屏设置、单次停止的桌面／窄屏、诊断的桌面／窄屏和 Thread 窄屏截图；键盘、滚动边界和普通 DSH 恢复由场景断言覆盖。
- `git diff --check HEAD` 通过。验证基线为 `8490848` 的实现与本次组合测试；维护文档同步为 `5f20913`。未 push、未发布、未重启现有 Host；隔离 Web scaffold 的通过不表示当前 3082 GUI 已更新。
- **独立验收结论：通过已实现范围。** Claude steer 按已核实的原生能力阻塞关闭，保留未勾选，不作为通过范围；其余票 06 条件与 01–05 已交付能力完成收口。
