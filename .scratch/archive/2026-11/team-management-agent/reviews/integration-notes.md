# 最终整合待核事项

这些是 Reeve 在 2026-11-14 接续 05/06 时发现的整合事项，不改写 04/07 的已接受事实，不阻塞 Tars 的 05/06 实施；完成整合时逐项补证。

## 私有资产 persona 与已确认 D17 不一致

- 已确认意图：`materials/decisions.md` D17、D20 和 spec「整理其他成员的文件」允许管理会话在 Human 要求时，通过 `team_overview` 查实 member ref 对应目录，按相应规则整理该 Member 的私有 memory/notes/skills；禁止 sqlite、Session 日志和删除成员目录。这不是允许把私有内容写到公共位置。
- 当前文字：`9b43187` 的 `cordis.patch.yml` 管理 persona 第 284 行一方面允许已查实的 Member 私有资产，另一方面又说 `never edit a Member's memory, notes, or skills on its behalf`。后一条把 D17 的能力整个禁止了。2026-11-14 22:55 对实施树只读核实，该段仍相同；05/06 由 Tars 独占写入，本次未改源码。
- 整合处理：Reeve 已在 `8d4ba29` 对齐已确认的 D17：只在 Human 当前请求范围内整理查实的私有资产，不扩大到 Host 存储或日志，不删除成员目录，不把资料当授权，不把私有内容搬入公共材料。persona、中英维护文档和 shipping 断言已同步；`shipping.spec.ts` 9 用例与 `check:docs` 通过。Tome 已独立复核通过并复跑 shipping 9/9，确认 sqlite／Session 日志、目录删除与私有内容外泄红线未削弱；不是另加常驻巡视或成员资产整理教程。

## 最终实际使用的环境前提

- 本地 Git 合并、构建、启动新代码、账本版本升级、npm 发布分开处理。授权本地合并不等于授权发布或重启当前 GUI。
- 当前 `web-dev` 链接到创建 checkout；最终合并后仍需核所加载的构建与 Host 启动方式，不用隔离 e2e 冒充现有 GUI 已更新。
- 依据 `docs/development/environments-and-install.md`：同一 `DSH_HOME` 不同时运行两个 Host；仅换 profile 不隔离默认 storage。新账本 rules version 不能交给旧 writer/reader。
- 依据 `docs/release-runbook.md` §2：用 SQLite 在线 backup API，或停止所有相关进程后备份；活跃 WAL 数据库不能只拷主文件。新版本回放只在副本验证。最终启用时列清备份、兼容版本、启动与验证步骤，不在实现阶段对真实账本试写。2026-11-15 已用临时数据库实测当前 Node 的 `node:sqlite` `backup()`；同日 01:59（UTC+8）已对真实账本执行只读在线备份，产物 `/data/dsh/backups/agent_team-pre-manager-20261114T175953Z.sqlite`（104,792,064 bytes），副本 `PRAGMA integrity_check = ok`。未改写真实账本，也未重启或升级运行中的 Host。

## 交付证据的边界

- 04 三个写工具当前参数和顺序以实际源码及 `reviews/04-delivery.md` 为准：`member_create` 不带初始 Project 参数，先建成员，再创建 Project/授 owner；不要把 spec 的早期可选初始 Project 当成已存在接口。
- 相同 requestId **和参数**才是幂等重放；重复自然语言不自动保证重用请求 id。
- 统一工程验证要保留故意激活失败／授予失败后的续做，且不重复创建已提交对象。真实模型的方案与确认判断由 Human 最后实际使用，不伪记自动化为人工。

## 最终统一验证（2026-11-15）

- 验证对象是创建 checkout 的本地 `master` 暂存合并树；`packages/`、维护文档、preset 与构建脚本和已复核功能 tip `92db4ce` 一致，`master` 侧既有 `1c57e5a` CI 变更保留。
- `npm run typecheck`、`npm run build` 通过。第一次在未构建的创建 checkout 直接运行 `npm test`，7 个 manager 文件共 73 用例因 `manager-context` 公开子路径没有 `lib/` 产物而未启动；先完成真实构建后原套全量重跑，218 文件通过、1 跳过，2836 用例通过、1 跳过。没有为这轮环境失败改业务源码。`npm run lint` 为 0 error、110 条既有 warning。
- 使用 `PATH="/opt/memoh/toolkit/node-glibc/bin:$PATH" CHROME_PATH=/usr/bin/chromium npm run test:browser` 跑真实 Chromium 与组装 Web：28 文件、31 场景全部通过，本轮证据目录含 205 张截图。
- 人工查看了管理问答、空管理会话、窄屏抽屉、打开／新建失败，以及管理写入后的桌面与 390×844 项目编辑截图；未见横向溢出、遮挡或不可操作的保存／重试控件。管理入口的键盘焦点和 Enter 打开、失败恢复、普通 Session 还原由通过的场景断言覆盖。
- 最终归档审计为 1 个工作项、0 finding，`git diff --cached --check` 通过。临时 manager worktree 已清理，分支保留；其他有未提交内容的 worktree 未触碰。
- 以上证明合并树的工程与隔离产品路径可用，不证明当前 3082 旧 Host 已加载新代码，也不代替 Human 对真实模型、自然语言方案和确认判断的实际使用。
