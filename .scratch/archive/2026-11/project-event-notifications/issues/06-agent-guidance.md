# 06 — Agent 使用指引

**What to build:** 新创建的 Agent owner 不需要 Human 解释，就知道要为自己负责的领域建立提醒和订阅，并能照着技能文档写出可用的脚本。
**Blocked by:** 01, 02, 05
**Status:** complete

- [x] 新增核心技能 `project-subscriptions`，内容包括输出契约、调试方法、三个示例脚本（main 分支 CI 失败、带 bug 标签的新 issue、PR review 请求）、注意事项（只做查询、需要密钥时在订阅里声明 credential 引用由 Host 注入而不写进脚本、不把凭据或原始请求输出到 stdout 和 stderr）、webhook 注册步骤和签名校验示例。
- [x] 在 persona 中增加一句：owner 应主动为自己负责的领域建立提醒和订阅。
- [x] 通过 `npm run check:core-skills` 检查。
- [x] 实际验证：在一个 Project 里让 Agent owner 自己建立一个 GitHub CI 订阅，确认它能被事件唤醒；把 Session 日志作为证据。
