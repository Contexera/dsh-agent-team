# PR #83 当前接入点核对

核对日期：2026-11-10。设计固定于 PR head `6e3e212`；Team 工作树基线 `e797f10`；相邻 Harness 为发布标签 `dsh-v0.2.2-rc.1`、提交 `66491b05`。以下是源码核对，不是已完成的组合验收，也不解除原注册识别的开工前置。

## 已确认的首版范围

按当前 [spec](../spec.md) 保留 profile 统一外部工具名单。成员自己的白名单只收窄原有工具，不限制已放行的外部工具。[Issue #82](https://github.com/Contexera/dsh-agent-team/issues/82) 原维护者回复提出的是「插件声明、成员再次收窄」的候选方向；交付文档和后续公开回复需要明确首版最终采用的区别，不能把候选描述当成已经实现的契约。

按名授权以及同名更换提供方的后果，必须进入用户说明；不猜插件来源、不新增安装管理器。验证补上 Team 组、preset、Member 自身作用域，分别检查现有工具基线与新增外部授权。

## 成员策略与开轮

- [MemberRuntime](../../../../packages/agent-team/src/member-runtime.ts#L110-L158) 捕获 preset 视角的定义，白名单只能收窄；guard 按名称和定义对象比较。profile 外部放行不能直接塞进现有成员 allow 字段。
- [基线捕获](../../../../packages/agent-team/src/member-runtime.ts#L130-L144) 用 preset 视角与全局视角的对象差异识别自有工具，不能据此证明定义实际注册于 preset。Team 组继承的注册需要独立负例；这是需核对的已有识别边界，不是新名单已经解决的问题。
- [激活路径](../../../../packages/agent-team/src/index.ts#L2937-L2964) 在挂载 preset 后应用策略，并且能安装精确 Session 的观察者及 `agent/pre-step` 拒绝钩子。创建、恢复和换代均经过该入口。
- 现有 [策略重装](../../../../packages/agent-team/src/member-runtime.ts#L172-L205) 先撤旧限制，失败时恢复旧名单。新增外部授权撤销不能复用含旧授权的回退，须将基线和当轮外部授权分开。
- 现有 [等待边界](../../../../packages/agent-team/src/member-runtime.ts#L216-L239) 等待非 running；这不等于每轮开头。发布版 [Agent loop](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L326-L347) 在解析工具前写 `turn/start`，并可在不经过 idle 的情况下[连续开轮](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L420-L432)。
- [Session 观察者](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/session/src/index.ts#L400-L418) 同步进入，但异常被容纳、返回 Promise 不等待。因此同步读当轮配置并换限制可用此时点；错误不能靠抛出阻止请求，须由 `agent/pre-step` 拒绝。该钩子本身[在工具解析之后](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L283-L316)，不能在那里决定本步骤的工具名单。

## 设置读写与 UI

- [Host 行配置](../../../../packages/agent-team/src/host-row-settings.ts) 集中声明 volatile 字段。继续使用 profile 配置，不向 Team 账本添加名单。
- [现有配置组](../../../../packages/client-agent-team/src/client/team-config.ts#L120-L125) 按字段路径写入并传预期版本，避免复述兄弟配置。外部工具整份列表应写自己的字段，清空明确保存空数组，不用 unset 恢复下层授权。
- 发布版 [SettingsForms.write](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/settings/settings/src/index.ts#L378-L423) 在配置编辑事务里检查版本、验证 volatile 路径。保存结果不代表每个成员已换工具策略。
- [ConfigForm.mutate](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-settings/src/client/config-form.ts#L129-L155) 把所有非 ok 响应收为 false，恢复读取，但丢失具体原因。下层 [Settings Remote](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/settings-controller/src/index.ts#L257-L267) 已区分 `settings/conflict` 与 `settings/rejected`。新编辑器需要保留该区别、最新已保存值及旧草稿，不得拿自动重试把撤销覆盖掉。
- 当前 [TeamSettingsSection](../../../../packages/client-agent-team/src/client/TeamSettingsSection.tsx#L284-L299) 在 Human 身份读取失败时提前返回。外部工具配置应独立渲染，确保名字／头像读取故障不阻止移除授权。

## 后续验证重点

1. 原注册准入与条件：同对象、不同对象、组／preset／Member 作用域；无步骤准入与嵌套调用。
2. 精确开轮：同轮保留旧名单，下一轮首请求使用新名单，连续两轮无 idle；迟到注册与步骤准备后的卸载、同对象重注册。
3. 失败收紧：已撤销授权不被旧策略恢复；基线也无法确认则零模型请求，后续正常开轮重试。
4. 真实设置与组装 Web：独立目录／名单／身份读取状态、两页面版本冲突、草稿保留、明确清空，以及普通 Session、其他 profile 不受影响。
5. 真实插件：核对 Member Agent、cwd 与资源归属；未识别 Issue #82 的插件，不能宣称其具体兼容性。
