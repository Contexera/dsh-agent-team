# PR #83：原注册识别的最小上游前置

> 文中链接的探针脚本位于 Git 忽略的 `artifacts/` 目录，未随仓库分发；这里保留路径作为来源记录。

最后核对：2026-11-10。设计为 PR #83 的 `6e3e212`；Harness 源码为 `dsh-v0.2.2-rc.1`（`66491b05`）。本文是待讨论的接口要求，不是现有 API，也不是修改 Harness 的授权。

## 复核结论与证据边界

Codex Worker 编写了注册准入探针（`artifacts/pr83-admission-codex-20261110/probe.mjs`），Reeve 阅读全部探针并独立执行 `node --check` 和运行命令，78 项断言通过。这里的通过包含“成功复现候选对象比对 guard 的缺陷”，不代表 PR #83 已实现或已通过验收。

实跑使用本机已安装／链接的 Cordis `4.1.0`、DSH `0.2.2-rc.1` 构建，以及 Team 的既有 MemberRuntime 构建。Agent 是最小身份对象；真实 ToolsService、scope 链、Native executor、声明组装和嵌套 pipeline 被调用，没有完整 Team Session、Web、第三方插件、认证／sandbox 流程或连续回合验收。探针没有改写注册表实现；基线检查单独调用了当前 MemberRuntime 的私有实现方法，不把该方法当成公开接入点。

| 对照 | 独立复跑结果 |
| --- | --- |
| 只有原全局注册，`when:false` | 不声明，不可直接或嵌套执行，工具体不运行。 |
| 只有原全局注册，条件允许 | 直接／嵌套执行使用同一个调用 Agent；缺少当步准入时条件工具不可执行。 |
| 执行前策略拒绝 | 真实 pipeline 阻止直接／嵌套调用，工具体不运行。 |
| Team 组、preset、Member 三种同对象遮蔽 | 候选 identity-only guard 均放行直接／嵌套调用，原全局假条件不再约束执行。 |
| 三种不同对象遮蔽 | 同一候选 guard 均拒绝。 |
| 准备步骤后注销并用同一对象重注册 | 旧步骤不可调用；新步骤能使用替换后的原全局注册。 |
| 基线识别 | Team 组继承的不同对象工具被误当作 preset 自有；preset 中与全局共用对象的自有注册被排除。 |

没有读取或改动真实 Team 数据、Host 配置、凭据，没有安装依赖或重新构建。共享 Team HEAD 在研究期间从 `0745cc6` 推进到 `1c98558`，本次涉及的 MemberRuntime 源码未变；不能把共享 HEAD 变化归为本项交付。

## 为什么现有查询不够

[ToolsService](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/index.ts#L199-L296) 内部知道选中了哪个 registration，并在当步查询时检查注册对象仍是原对象。公开查询却只返回 definition。一个 definition 可以注册在多个作用域，各次注册的条件和生命周期可以不同。

因此“返回同一个 definition”不等于“准入的是原全局 registration”。执行前后的事件也没有补充注册所属作用域。不能通过再次执行条件、伪造另一个 Agent、临时修改作用域限制来推断，也不拦截注册调用来另建权威。

## 所需最小信息

由 ToolsService 自己提供只读的注册归属，不建立 Team 来源注册表。以下命名只作示意，不锁定上游方法名：

```text
RegistrationView = {
  definition: ToolDefinition,
  origin: { kind: 'global' } | { kind: 'scoped', scope: ScopeKey }
}
```

需要覆盖两种读取语境，而不是只加一个脱离准入的标签：

1. **当前注册目录查询。** 查询某个作用域当前选中的注册，返回 definition 与真实 origin；遵循现有继承、遮蔽和限制规则，不为展示或基线识别执行 `when`。Team 用 preset 作用域查询，并只保留 origin 明确属于该 preset 的注册；共享 `working_directory` 按现有基线规则独立处理。
2. **当步准入查询。** 输入精确调用 Agent 与名称，返回 `resolve()` 捕获且仍准入的同一 registration 的 definition/origin。必须沿用当前注销、替换、限制及 dispose 的失效检查；不同 Agent、未准入或已失效的注册均无结果。不能重新评估 `when`，不能用当前同名注册代替当步原注册。

两种语境可以合在与现有 `get(name, scope, toolSet?)` 类似的一个公开入口中，也可以分别放在注册服务和 ResolvedToolSet 上；上游拥有最终 API 形态。Team 的执行 guard 必须使用当步语境，目录查询不能独自成为执行授权。

不需要稳定插件 ID、跨重启的注册身份、暴露 `when` 或私有 registration 对象，也不要求新执行器。现有内部注册身份检查继续承担步骤内替换保护；按名字授权和跨步骤／重启同名换提供方的风险仍按既定设计向用户说明。

## 判别性验收

- 三个作用域分别验证同名、同对象注册：目录能辨别 origin，外部授权不接纳 scoped 注册；preset 自有与 Team 组继承不能混同。
- 原全局条件为假、条件异常、权限拒绝、缺少准入和不同 Agent 均不能取得执行权。
- 原注册在准入后卸载／重注册，即使 definition 对象不变，旧准入查询也失效；新步骤使用新注册。
- 执行前异步策略期间注册变化仍受最终 pipeline 查询约束；直接和嵌套调用共享同一个准入。
- 查询与清理不额外执行条件、不复制定义、不延长原注册生命周期、不改变普通 Session 的选择语义。

## 当前决定与下一步

原注册识别前置未满足，[原实施票](../issues/01-allow-host-tools.md) 继续 pending。Human 已明确不能补上游接口，因此本文只保留技术缺口与证据，不作为当前交付路线。

正在调查另一种授权对象：明确允许工具名称，由 DSH 为 Member 选择并准入实际注册，不再声称锁定原宿主注册。这是替代设计，不是原方案已实现；须单独验证原有工具优先级、Member 白名单、同名遮蔽以及声明／执行两面的差别，未收敛前不改产品。
