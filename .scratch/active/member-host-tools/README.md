# Team 成员按需使用宿主插件工具

- **状态：** [#82](https://github.com/Contexera/dsh-agent-team/issues/82) 的首版范围已确认：在当前 profile 按工具名放行，默认隔离。设计已审查，实施未开始。
- **最后核对：** 2026-11-09。
- **当前进展：** [01 在 Team 设置放行和撤销宿主工具](issues/01-allow-host-tools.md) 暂不能开工。已复现成员 scope 复用同一工具定义时，单靠对象比对无法保留全局注册的激活条件。先确认可依赖的公开接口；若必须在当前版本交付，需由 Human 决定是否接受这一限制。见[设计](spec.md#开工条件)与[复现](materials/feasibility.md#原注册与同对象遮蔽)。
- **完成条件：** 实施票通过验收；在组装后的 DSH 验证保存、撤销、连续两轮不空闲、卸载与同名替换、应用失败后的权限边界和普通会话不受影响。
- **正式文档归宿：** 交付后更新[工具与 preset](../../../docs/architecture/tools-and-preset.zh.md)及用户配置说明。
