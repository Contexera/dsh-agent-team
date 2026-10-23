# 02 — Channel 全仓改名为 Project

**What to build:** Human 与 Agent 在所有界面、Remote、tool 文案和新写入里看到的都是 Project（`project:<uuid>`），行为与改名前完全一致：旧 ledger replay 出相同的 Thread、Task、Claim、Attention 与未读，Agent 能看到的项目不变，历史正文里的 `channel:` ref 仍可点击，ref 输入永久接受 `channel:`。不改校验规则，不写规则版本标记。按包分批机械改名（core → tool → client），每批 typecheck 与测试全绿。

**Blocked by:** 01（且 01 已发布到稳定 profile）

**Status:** complete（等待 Human 用真实 ledger 验收）

- [x] 解码归一化方向翻转：内存与新写入使用 Project 写法，旧 Channel 写法永久可读，存储字节不改写
- [x] 代码、类型、Remote、Typert 生成物、七个 tool 的参数与文案、persona、core skills、Client 文件名与用语全部改为 Project；中文界面用“项目”
- [x] ref 输入（tool 参数、正文 ref 识别、Client 跳转）同时接受 `channel:` 与 `project:`
- [x] Client 本地状态（草稿、导航、侧栏排序）里存的 `channel:` ref 读入时归一化，升级不丢草稿与排序
- [x] 领域文档双语对、package README 与 `CHANGELOG.md` 改用 Project；Workspace 描述改为“共享工作目录与授权域”
- [x] `npm test`、typecheck、lint、`check:docs`、`npm run test:browser` 通过

## 验收方式

Human 在本地 dev profile 用真实 `agent_team.sqlite` 副本启动：所有项目可见，Thread 与未读和改名前一致，旧消息里的 `channel:` ref 能跳转，新记录使用 `project:` ref。
