# Team Client 前端设计文档

[English](README.md) | 中文

修改界面前，先查 [Client 与 Remote](../architecture/client-and-remote.zh.md) 确认挂载和数据边界，再按下表找设计约定。针对性验证从 [浏览器用例目录](../development/e2e-lanes.zh.md) 选场景。

本页记录长期适用的设计约定。实际行为以源码和测试为准。

| 页面 | 负责内容 |
| --- | --- |
| [principles-and-language.zh.md](principles-and-language.zh.md) | 复用优先的设计原则与 DSH 设计语言对齐 |
| [layout-and-typography.zh.md](layout-and-typography.zh.md) | 布局骨架、排版体系，以及颜色与身份 |
| [components.zh.md](components.zh.md) | 每个 Team 组件一份合同：消息、消息块、ref、计数胶囊、花名册、资料页、失败态与 Thread 顶层栏 |
| [thread-and-composer.zh.md](thread-and-composer.zh.md) | 时间线滚动、composer 与 mention、Thread/Task 入口行，以及状态胶囊与弹层 |
| [侧栏浏览器](sidebar-browser.zh.md) | Workspace 选择器、侧栏入口、跨 Workspace 的收件箱与任务看板 |
| [refresh-copy-accessibility.zh.md](refresh-copy-accessibility.zh.md) | 数据刷新语义、文案与本地化、可访问性基线，以及体系如何演进 |
