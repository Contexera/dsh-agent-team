# PR #83：额外名称许可的替代语义

核对日期：2026-11-10。Human 已明确不补上游接口，并要求调查其他实现方式。本文最初记录候选方案；19:05 Human 已确认按该核心目标实施，当前契约以修订后的 [spec](../spec.md) 为准。下文实验事实保留，不把原型当生产验收。

## 独立核验

Reeve 阅读 Codex 的完整[对照原型](../../../../artifacts/pr83-name-grant-codex-20261110/probe.mjs)，修正了一个正例的前置：测试声称 Member 禁用了基线工具，但原先仍把该名称列在 `memberAllow` 中。改为空名单后，重新执行语法检查和完整原型，142 项断言通过。通过包含既有缺陷与候选语义差异的复现，不是生产验收。

原型调用真实 ToolsService、三层 scope 链、Native executor、声明组装与嵌套 pipeline；Agent/Session 是最小模拟身份。使用 Cordis `4.1.0`、DSH `0.2.2-rc.1` 的已安装／链接构建。Team 既有 MemberRuntime 的私有基线方法只用来复现当前分类，不能作为新公开接口；候选 guard 和 restriction 是隔离原型，不是已接入完整 MemberRuntime。

## 可成立的授权对象

profile 明确许可一个名称。DSH 为每个 Member 解析实际注册，按其自己的条件生成当步准入；Team 只核对名称许可、调用 Member 与该步骤仍有效的准入。

- 同对象、不同对象的 Team 组／preset／Member 同名注册均遵循 DSH 近层优先规则。
- 所选近层注册自己的 `when:false` 阻止声明和直接／嵌套执行。更远的全局注册条件不约束另一条独立注册。
- 实际 pipeline 的执行前拒绝、同一调用身份、嵌套 parent token、步骤内原注册被注销／替换后的失效均保留。
- 外部调用缺少步骤准入，或其他 Agent 复用这份准入，均不能执行。

这不再宣称锁定“原宿主全局注册”，因此消除了该项授权对注册归属查询的依赖。

## 必须明确改变的优先级

“profile 许可给所有 Member 增权，但原 preset 禁用项永远优先”依赖精确识别 preset 自有名称。当前分类会漏掉与全局共用对象的 preset 注册，又会把 Team 组继承的不同对象工具收入基线；名称 guard 不能使这个分类突然可靠。

本次可继续评估的候选是：**profile 名单作为额外名称许可，高于 Member 白名单；Team 必需工具与 `working_directory` 不作为普通增权名称处理。** 例如 Member 只允许 `read`，profile 再许可 `bash`，该 Member 就获得 `bash` 的名称许可，仍受 DSH 准入和权限约束。这是权限契约变更，不是原方案自动兼容。

原型确实覆盖了 profile 重新允许一个 Member 禁用的基线名称，以及同对象 preset 名称。保留名称测试只验证“没有基线 binding 时不能靠 profile 恢复 `team_worker`”；它不是完整 Host Worker 开关的组合测试，不能据此宣称该真实开关路径已验收。

## 仍有的边界

| 路径 | 声明 | 执行 |
| --- | --- | --- |
| 继承的全局工具，空名单／撤销 | 不声明 | 拒绝 |
| Member 自有 scope 的非基线工具，空名单／撤销 | 仍可能声明 | 拒绝 |
| 已许可名称且通过当步准入 | 按 DSH 解析声明 | 按 DSH 解析执行 |

`tools.restrict` 不过滤 Member 自有 scope 的注册，执行 guard 不等于声明过滤。原型保留当前基线算法的行为，未修复其分类缺陷，也没有重做插件隔离。

首次迟到注册的全局名称还需要刷新物化后的限制名单；仅更改 guard 看不到的名称不会自动出现在模型请求中。原型未实现或验收连续回合边界、撤销失败收紧、设置事务、UI、真实插件的 Session/cwd/资源兼容、异步审批或 sandbox 链路。

## 当前进展

已向 Human 说明两项变化：授权跟随 DSH 实际解析的名称；profile 明确许可可重新允许 Member 白名单未包含的同名能力。19:05 Human 确认“注册的 tools 被 preset 过滤，白名单开启后 Member 可以使用”即满足核心诉求，并要求 Team 设置读取可选目录；修订 spec 和实施票已解除原注册来源前置，进入实施。
