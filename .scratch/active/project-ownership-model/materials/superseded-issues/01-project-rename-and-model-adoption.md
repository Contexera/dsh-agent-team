# 01 — Channel 改名为 Project，旧 ledger 无损可读

**What to build:** 升级后，Human 与 Agent 在所有界面、Remote、tool 文案与新写入的 ref 中看到的都是 Project（`project:<uuid>`），而行为与升级前完全一致：同一份旧 ledger 在新版本中 replay 出相同的 Thread、Task、Claim、Attention 与未读，Agent 能看到的项目不减少，历史正文里的 `channel:` ref 仍可点击。本批不改变任何校验规则，因此不写规则版本标记。这是一次全仓机械改名，按 expand–contract 进行，不是 tracer bullet。

**Blocked by:** None — can start immediately

**Status:** ready

- [ ] 解码时把 `channel:` ref、`channelRef` 字段与 `team/channel-{created,updated,archived}` kind 归一化为 Project 形式；存储字节不改写；ref 解析永久接受 `channel:` 输入
- [ ] 代码、Remote、Typert 生成物、tool 文案、Client 用语全部改为 Project；新写入使用 `project:` ref
- [ ] 一组旧 ledger fixture（含旧 membership、`@all`、Human 邀请确认、已 accept/close 的 Task、离开 Workspace 的 Member）replay 后投影与旧版本逐项一致；可见 Project 集合与旧可见 Channel 集合相同
- [ ] replay 后立即在新版本上再提交一次读写，幂等重试与 collision 行为不变
- [ ] 领域文档、双语对与 `CHANGELOG.md` 改用 Project 术语；Workspace 描述改为“共享工作目录与授权域”

## 验收方式

用真实 home 的 `agent_team.sqlite` 副本在 dev profile 启动：所有项目可见、Thread 与未读与升级前一致、旧消息里的 `channel:` ref 能跳转；新写入的记录使用 `project:` ref。`npm run test:browser` 通过。
