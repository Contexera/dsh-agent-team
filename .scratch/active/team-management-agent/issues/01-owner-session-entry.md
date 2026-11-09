# 01 — 打开并恢复团队管理会话

**What to build:** Human 在 Team 侧栏的 Workspace 选择器上方打开「团队管理」，在 Team mode 内使用 DSH 对话和问题卡。入口在没有 Workspace 时也可用。Host 在 DSH home 的专用目录启动管理会话，以隔离的 `team-owner` preset 运行：独立 persona、bash/pwsh、文件读写与搜索、jobs、skill、web 和 `ask_user_question`，保留全局 `working_directory`，使用 `danger-full-access`。本 ticket 不含专用管理工具。
**Blocked by:** None — can start immediately
**Status:** ready

- [ ] 首次打开创建一条会话；并发打开、刷新页面和重启后从 Host 解析到同一条。浏览器只保存入口位置，当前 Session id 由 Host 私下持久登记。
- [ ] 「新开对话」仅替换所见的当前 id；两页同时发起不会连续换两条。新会话可用且登记持久化后才切换，旧会话停止、历史和专用目录保留。启动或登记失败可重试，原登记不丢失。
- [ ] 新会话标题为「团队管理」，普通列表显示在 Ungrouped；Team 入口固定同名。归档或确认已不存在后再次打开会创建新会话；暂时读不到、格式或加载失败给出诊断，不当作丢失。
- [ ] 按实际工具面验证 preset 隔离：管理会话有上述工具与 Harness checkout 指令加载能力，默认模型可对话，不含九个 Team 工具或成员上下文插件；普通 Session 与 `team-member` 的组装不变；从现有成员创建入口传 `team-owner` 在写账本前被拒绝。重启不重复记录相同 sandbox mode。
- [ ] 验证未开始首轮的管理会话也不能被普通 preset picker、暂存选择或直接切换调用改挂；普通会话的 preset 切换仍正常。
- [ ] 在已组装的 Web profile 用可控模型验证问题卡的展示和答案回传，含普通 DSH 对话与 Team 中嵌入的 DSH 对话共用组件的路径。
- [ ] 组件检查覆盖选中态、加载/失败/重试和离开期间的晚到结果；`npm run test:browser` 走「无 Workspace → 打开 → 提问 → 新开/重载 → 还原普通 DSH 会话」，检查键盘、焦点、桌面和 390×844。
- [ ] 更新 preset、会话恢复与术语的维护文档和相关包 README；现有九个协作工具仍只在 `team-member`。

会话与导航细节见 [设计](../spec.md)。
