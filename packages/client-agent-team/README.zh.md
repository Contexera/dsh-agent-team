# @contexera/dsh-agent-team/client

[English](README.md) | 中文

可选的 Agent Team Web Client。它通过公开的 Client slots 和 typed Host Remote 接口提供 Team mode，不在浏览器侧维护 Team 数据或未读状态。

## Human 工作流

进入 Team mode 后默认打开 Channels。Human 导航路径是 Workspace → Channel → Thread；Task 是 Thread 上可选的卡片/header overlay，不是导航层级。Channel 顶层消息默认创建 taskless Thread；Human composer 提供默认关闭的「作为任务」控件，可原子创建 Task；taskless Thread 之后也可由 Human 通过 durable Host mutation promotion。promotion 成功后 Client 重读 Host projection，不乐观地自行合成 Task。taskless Thread 保留 reply、follow、mention、Inbox、read 和 history，只有存在 Task 后才展示 status、Claims 与 Task resolution 控件。Client 不显示、不进入、也不轮询 Human Inbox。打开 Thread 会调用 Host 的 `readThread`，然后展示公开 Thread 时间线、分页历史、存在时的 Claims，以及处于错误状态且仍有 active Claim 的 Agent 风险。当前 Thread UI 不展示关注/取消关注按钮，也不展示 Human 的关注/取消关注观察。Human 消息按字面文本渲染，Agent 消息使用 Harness 共享的 Markdown 原语渲染；时间线打开时定位到最后一条消息，仅在读者停留在底部时跟随新消息，前插更早历史时保持视口稳定。读取全部自动化：有界批次的剩余未读由 Client 自动续读清零（不存在手动已读/继续阅读控件），Thread 打开期间到达的更新无论滚动位置一律持久确认——滚离底部的读者只会看到无读取语义的「↓ N 条新更新」纯跳转提示。消息正文中的已知 branded Task ref 会在原位置显示为可点击的 `Task #N`，Agent Markdown 内同样如此（整段恰好是一个 ref 的行内代码也会渲染为链接），并可解析到所属 Channel 与 Thread，支持跨频道跳转；模型常见的双冒号/大写拼写会先归一化为规范 ref 再查询。代码块和混合内容的行内代码保留原文；未知 ref 不提供导航。

侧栏行自带控件：行级 ⋯ 菜单打开对应编辑器——`updateChannel` 修改频道名称/说明；`updateMember` 编辑 Agent 名称/说明，并可为该成员固定可选的 provider/model（缺省即清除覆盖、回到 Host 默认继承；对活跃成员改模型会原地更新 live model selection，保持 Agent 与 Session 身份不变，后续请求使用新选择）。模型选择经与会话无关的 `llm.models` RPC 读取 Host 目录。点击 Agent 卡片会在 Team 模式内临时显示该成员的会话，不会丢掉下层已选中的 Channel 或 Thread。两种行菜单都带 danger「归档」入口：`archiveMember` 与 `archiveChannel` 经破坏性确认弹窗（明确说明"暂无恢复入口"）后把实体从所有面收起（持久数据保留、活跃 Claim 释放）；归档行随 workspace 刷新消失，mention 候选、成员选择器与频道成员列表都排除已归档成员。本轮不做侧栏归档列表与恢复入口。

Client 使用以下 Host 接口：

- `readThread`：确认一个 Thread 的未读批次。
- `threadHistory`：读取更早事实，不改变已读状态。
- `promoteThread`：原子地为 taskless Thread 附加真实 Task，并记录结构化 `promote` Task activity。
- `resolveTaskRefs`：将已知 branded Task ref 解析为展示编号及所属 Channel/Thread，供导航使用。
- `updateChannel`：提交频道名称/说明的展示事实修改。
- `archiveChannel`：把频道从所有面收起，事实保留（暂无恢复入口）。
- `updateMember`：提交 Agent 名称/说明编辑，以及可选的成员级模型覆盖。
- `archiveMember`：把 Agent 从所有面收起，会话日志与私有记忆保留（暂无恢复入口）。
Host Remote 仍提供 `threadObservations` 和 `changeAttention`；当前 Human Thread 界面不渲染这些控制或观察。`changes` 是按 scope 订阅的流式 Remote，通过 Harness `ctx.remote.$stream()` 消费。每个页面内同 scope 共享一个逻辑订阅，Harness 将其复用到该页面的共享 WebSocket，因此多个 Team 页面不会因通知长期占用普通 HTTP 连接。每次开场或重连基线都触发重新读取 Host，包括版本未变化的情况；最后一个订阅者离开时取消该 scope。打开 Thread 时并行完成首次读取，允许基线到达后补读，但私有已读确认不会形成共享通知循环。scope 与恢复契约见[架构文档](../../docs/architecture/host-authority.zh.md)。

浏览器持久化 Team mode、当前 Workspace，以及最后选中的 Channel 或 Thread，返回 Team 时会恢复之前的位置。Attention、未读数量、revision、observations 和 Thread facts 始终由 Host 管理。持久化操作提交或拒绝后，Client 会重新读取 Host 投影。

## 组合边界

这个 package 通过 Harness 的公开 slot API 提供 Team workspace、conversation 和 footer slots。它不修改 Harness 源码、不替换 shipped stores，也不读取 operation ledger。面向模型的 Team tools 和 guidance 仍只在 `team-member` preset 中启用。

## 开发检查

在仓库根目录运行：

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
npm run preview:ui
```

`test:browser` 运行无凭据且确定性的组装 Team 旅程。`preview:ui` 加载隔离的 Host fixture，并禁用模型 streaming。只有需要真实 Agent 交互时才使用根目录的 `npm run preview`，该命令要求有效凭据。
