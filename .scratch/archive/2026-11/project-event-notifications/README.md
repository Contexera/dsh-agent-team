# Member 提醒与 Project 订阅

目标：Project 的 Agent owner 不再只靠 Human 唤醒。Member 可以给自己设提醒，Project 可以通过订阅接收外部事件，从而让 owner 主动推进自己负责的领域。

## 状态

2026-11-04：01–06 全部完成并获 Human 验收，工作项关闭。设计于 2026-11-02 获 Human 认可，2026-11-03 按 PR #77 外部架构评审修订并复核；执行权限、私有存储交接、试运行与去重基线、提醒消费、revision、凭据、输出上限、成功线性化、投递身份、重放、ticket 依赖和单 Host 约束均已落入实现。正式结论已同步到维护文档；本目录只保留设计与实施历史。

## 最近检查

2026-11-04

## 当前进展

- 设计已收敛（2026-11-03）：收尾轮三项规则与凭据方案均经 Human 确认写入 spec；`materials/continuation-check.md` 中已无待明确内容，仅剩实施阶段的执行器验收。
- 最终组合已合入 01–06 与 #43，06 代码 HEAD 为 `6fa9053`。组合全量 158 文件通过、1 跳过，1952 tests 通过、1 跳过；build、typecheck、lint（0 errors / 100 warnings）、core-skills、comments、docs、artifact 与 diff check 全过。浏览器 12/12 通过，共 153 张截图；webhook 编辑、桌面/390×844 地址弹窗及普通 DSH 恢复面已人工检查。
- 04 实现链 `49b3ca6` → `c8d5fdb` 已验收：首轮唯一阻断（新试运行失败未作废旧通过）及 project change flicker、时区/注释表述均已修正；Reeve 复审 7 文件 amend delta，focused 32、全量 154 文件 / 1874 通过 / 1 跳过、typecheck、lint、UI parity、artifact、完整 browser 11/11 与 149 张截图全过，桌面/390×844 及普通 DSH 恢复面已人工核过。task:aa53bbea-29fb-4db1-a869-b4e7d8ae660f 已 accept 并合入组合分支。
- Bug-Check-Fix #43 的 cron 时间窗缺陷由 `068e299` 修复并验收：判据改为日程自身的日内间隔、相邻匹配日跨日间隔与 400 年公历周期，不再读取创建时钟；Reeve 独立 focused 55 与跨月/跨年/Vixie union 探针通过，task:eb696cd4-d7d4-4c87-9d7f-1b76a4703a00 已 accept 并合入组合分支。
- 01–04 与 #43 的组合 HEAD 为 `19fe859`；组合全量 154 文件 / 1879 通过 / 1 跳过，build、lint、UI parity、artifact 与 diff check 全过。未合 master、未 push。
- 01 实现链 `40c4c42` → `28a4b81` → `d9633b9` 已验收：三轮 full-diff 复审、全量检查、独立对抗探针和浏览器两档验收通过；occurrence 精确消费、通知预算/recovery、嵌套 ref、requestId 与消费写失败重投均已覆盖，task:23225f61-02e5-4c42-bd07-4964b9a5245d 已 accept；已进组合分支，未合 master、未 push。
- 02 实现链 `392ff47` → `0da5aa8` → `7c9f248` 已验收：Reeve 逐行读完三笔 diff，首轮 7 组与复审 4 组反例均复跑通过；独立全量检查与浏览器验收通过，task:54d2709b-39b9-45e0-b458-65adb40b2481 已 accept；已进组合分支，未合 master、未 push。
- 01+02 组合 merge 为 `bd28fa8`；Reeve 已解决中央冲突并独立通过 build、全量测试（151 文件 / 1809 通过 / 1 跳过）、typecheck、lint（0 errors）、artifact 与 public-baseline。组合 browser 已 10/10 通过并生成 138 张截图，Member 提醒与编辑弹窗的桌面、390×844 关键截图及普通 Project 恢复面已人工核过。
- 03 实现链 `64f671c` → `c591298` → `1fc2a1f` → `7c4dc6a` → `38cdc14` 已验收：五轮 full-diff 复审、focused 77 tests、全量检查（147 文件 / 1759 通过 / 1 跳过）及八组独立对抗探针通过；覆盖完整 replay intent、accept+clear 同锁、删除四表清理、墓碑/答案丢失恢复与 running intent + 账本 accept 跨重启一致性。task:63249355-a98d-4c2c-8d51-03d77afc66ce 已 accept；空输出成功和 update 保留基线按现行契约确认，首轮误列问题已撤回。
- 01+02+03 组合 merge 为 `1a03e73`；中央冲突保留 Member reminders、采用 03 四表清理并删除无调用者的旧 checkpoint 清理。组合 build 先行通过，随后全量检查为 153 文件 / 1863 通过 / 1 跳过，typecheck、lint（0 errors）、artifact 与 public-baseline 全过；组合 browser 10/10 通过并生成 138 张截图，提醒空态/编辑弹窗及普通 Project 恢复面的桌面与 390×844 关键截图均已人工核过。串行 browser lane 已释放给 Iris。
- 06 真实验收完成：Agent owner 用 `team_subscription create` 自建只读 GitHub CI 订阅，真实 `gh` 读到 `CI failed on master · run 199`（事件 `ci-run:41171647624`），随后第 2 个 turn 被唤醒；33 行持久化 Session 日志保留创建调用、事件 URL、唤醒和响应。实测使用真实 Cordis Host、bash executor、GitHub 数据与 Agent 工具，模型侧为确定性 `ScriptedAdapter`，不冒称真实 LLM 验证。实测另发现并修复 Host 启动后新建 interval 订阅缺少 `dueAt` 而不调度的问题（`6fa9053`）。未注册远端 webhook、未修改 GitHub、未触发 CI。
- 沙箱根目录问题的结论已写回 spec §4.3：Harness 公共接口支持为无 Session 调用指定完整 sandbox policy（自 0.2.1-rc.2 起存在），Host 显式传 Workspace 根目录；真实 Linux + Landlock + bash enforcement 已由 Reeve 独立复跑确认，macOS / Windows / pwsh 真机验证仍留待发布前。
- 不在本工作项范围：owner 把工作分派给 worker。

## 讨论记录

| 轮次 | 结论 |
| --- | --- |
| 1 | 目标从“接 GitHub”改为“owner 不依赖 Human 唤醒”。订阅属于 Project，事件送达全部 owner。 |
| 2 | 定时提醒属于 Agent，每个 Agent 都能给自己设。外部事件属于 Project，只有 owner 能订阅。巡查就是 owner 自己设的循环提醒。 |
| 3 | 拉取和推送都做，统一成“触发方式 + 脚本”。创建时先试运行，通过才生效。Agent owner 建的订阅直接生效。Project 页面增加“订阅”标签页。 |
| 4 | 脚本以快照形式存进账本。webhook 只用地址中的 token 鉴权。Team 工具增加到九个，固定挂载给所有 Member，由 Host 按 Project 校验 owner 身份。 |
| 收尾 | 补充边界情况：webhook 请求头传给脚本、定时与推送双通道、不能提权、事件不解析 mention、各项数量和频率上限、Member 和 Project 状态变化的处理。 |
| 评审（2026-11-03） | PR #77 外部架构评审提出三个 P0：①“不提权=Member bash 权限”不成立（tools.allow 可去 bash，Team 工具强制保留；Session 策略与部署默认不必相同）；②私有存储四类混谈，缺崩溃交接协议（当前 durable domain 只有 operations 一张表）；③更新试运行会吞掉未发布的新事件，webhook-only 试运行输入未定义。已逐条复核：三个 P0 与绝大多数引用成立，spec 按核实结果修订；评审自身夸大的条目（“Task 提醒三条都不成立”——送达方式其实可复用、“HTTP 路由只属 GitHub adapter”——路由是通用能力）未采纳。 |
| 收尾（2026-11-03） | 重新基线只追加不替换；自动重试固定接收时版本、人工重放默认当前版本；重置地址保留已接受投递、旧地址新请求 404；已接受事件写入账本，待发布队列降为派生调度状态（消除 §4.1 与 §4.4 矛盾）；凭据全局注册 + 订阅引用（最多 8 项，创建/更新校验已配置），不设按 Project 清单——沙箱只管写入，脚本可直读凭据存储文件，清单不构成边界。设计收敛。 |

## 材料

- `materials/holon-webhook-ingress.md`、`materials/dsh-superagent-event-design.md`：Human 提供的其他项目设计整理。
- `materials/harness-webhook.md`：Harness 现有的 webhook、schedule、jobs、shell 和沙箱能力调查。
- `materials/continuation-check.md`：本轮源码核查、尚未明确的规则及讨论建议。

## 完成条件

- 01–06 全部完成，并且每一项都能单独端到端验证。
- 实际验证：Agent owner 自己建立一个 GitHub CI 订阅，并因此被唤醒去处理问题。

## 正式文档出口

见 `spec.md` §9。维护文档已承载现行行为；本工作项按 `.scratch/AGENTS.md` 归档至 `archive/2026-11/project-event-notifications/`。
