# Team Member 本地工具限制

日期：2026-10-23
状态：本轮完成，2026-10-23 归档；用户接受当前限制

## 目标与约束

每个 Member 默认仅使用所选 Team preset 提供的工具和显式保留的 `working_directory`。`tools.allow` 只能缩减该范围，七个 Team 工具继续保留。用户不允许修改 Harness，并已确认本轮保留“只拦截未声明工具、不拦截其他插件 prompt”的边界；本轮沿用公开接口和现有成员能力管理，不新增通用策略框架或依赖。

## 实现

1. 在 setup 挂载 preset 后，从其父 scope 视图保存实际工具定义。该视图同时继承 Host 工具，因此排除与 Host 全局解析相同的定义，仅显式保留 `working_directory`。每次能力编辑沿用最初保存的定义。
2. 无论是否配置 `tools.allow` 都安装现有 `tools.restrict`。能力配置提及范围外工具时继续忽略并报告 warning。
3. 通过 Member scope 的公开 `system-prompt/assemble` 过滤工具列表，只返回获准定义的 schema。允许的名字被其他定义替换时拒绝组装。
4. 通过 `tools.guard` 拦截范围外和同名替换后的直接、嵌套调用。仅检查确切 Member，不改变子 Agent own 工具机制。
5. 不因其他插件提示贡献而拒绝激活或对话。experimental Team 的 `team:policy` 和必需 `team:identity` 仍可进入 Member 上下文；提示隔离未解决，不能宣称完整兼容。
6. 复用现有 turn boundary 更新、失败恢复与 scope disposer；不新增持久状态或 UI。

## 验收

- Host 全局工具不能进入默认 Member，也不能通过能力配置授权。
- `agent/created` 迟到工具从真实模型请求中移除，直接和嵌套执行均拒绝，request header 与 adapter 收到的工具一致。
- 同名替换在能力编辑后仍拒绝，不把替换定义重新纳入授权。
- 在 Member 激活前或激活后挂载真实官方 Team service 和工具插件，Member 都能只使用声明的工具完成回合，官方工具调用被拒绝，普通 Agent 保留官方能力；官方插件保持启用时 Member 暂停/恢复后继续对话。
- 既有暂停、恢复、Host restart、能力更新失败恢复及普通 Session 用例继续通过。
- 工具策略和成员生命周期相关测试、类型检查、Host 构建与文档检查通过；本次无 UI 改动，不运行浏览器或看图。

## 限制与后续

该方案不构成任意插件之间的完整隔离。其他组装中间件可在 Team 过滤器之后改变结果；任意插件提示及上下文不由 Team 接管。官方必需身份提示在请求前会由 Harness 恢复，当前不隔离它；不能用拒绝运行掩盖这项限制。完整双 Team profile 共存尚未认证。

原上游封闭请求策略与完整双 Team 共存 tickets 不在本轮实施范围，归档时已关闭并移除。更广泛插件适配审查与优化需另开工作项；调研材料中的测试补充、working_directory 归属调整和上游方案均未实施，也不作为本轮剩余任务。
