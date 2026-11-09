# Team 成员按需使用宿主插件工具

- **状态：** 首版设计已确认，实施未开始。入口是 [#82](https://github.com/Contexera/dsh-agent-team/issues/82)。[设计快照](spec.md)记录放行规则、界面和验收；[调研](materials/feasibility.md)保留版本和验证证据。
- **最后核对：** 2026-11-09。
- **当前待决：** [01 在 Team 设置放行和撤销宿主工具](issues/01-allow-host-tools.md)无前置依赖，待实施。没有待确认的首版设计问题。
- **完成条件：** 实施票通过验收，包括连续两轮中间不空闲、同名替换、插件缺失及卸载。在真实 DSH 组合中验证放行和撤销，普通会话保持原行为；说明提示注入限制。
- **正式文档归宿：** 交付后更新 [Tools and preset](../../../docs/architecture/tools-and-preset.zh.md)及用户配置说明。
