# Member 提醒与 Project 订阅

目标：Project 的 Agent owner 不再只靠 Human 唤醒。Member 可以给自己设提醒，Project 可以通过订阅接收外部事件，从而让 owner 主动推进自己负责的领域。

## 状态

设计已收敛，`spec.md` 已经 Human 认可（2026-11-02）。tickets 已拆分，尚未开始实施。

## 最近检查

2026-11-02

## 当前进展

- 可以开始：01（Member 提醒）、02（定时订阅主流程）。
- 等待前置任务：03 等 02；04 等 03；05 等 02；06 等 01、02、05。
- 02 开始前，需要先验证一件事：Host 不在任何 Session 内调用 shell 时，沙箱的工作区根目录如何确定（见 `spec.md` §4.3）。
- 不在本工作项范围：owner 把工作分派给 worker。

## 讨论记录

| 轮次 | 结论 |
| --- | --- |
| 1 | 目标从“接 GitHub”改为“owner 不依赖 Human 唤醒”。订阅属于 Project，事件送达全部 owner。 |
| 2 | 定时提醒属于 Agent，每个 Agent 都能给自己设。外部事件属于 Project，只有 owner 能订阅。巡查就是 owner 自己设的循环提醒。 |
| 3 | 拉取和推送都做，统一成“触发方式 + 脚本”。创建时先试运行，通过才生效。Agent owner 建的订阅直接生效。Project 页面增加“订阅”标签页。 |
| 4 | 脚本以快照形式存进账本。webhook 只用地址中的 token 鉴权。Team 工具增加到九个，固定挂载给所有 Member，由 Host 按 Project 校验 owner 身份。 |
| 收尾 | 补充边界情况：webhook 请求头传给脚本、定时与推送双通道、不能提权、事件不解析 mention、各项数量和频率上限、Member 和 Project 状态变化的处理。 |

## 材料

- `materials/holon-webhook-ingress.md`、`materials/dsh-superagent-event-design.md`：Human 提供的其他项目设计整理。
- `materials/harness-webhook.md`：Harness 现有的 webhook、schedule、jobs、shell 和沙箱能力调查。

## 完成条件

- 01–06 全部完成，并且每一项都能单独端到端验证。
- 实际验证：Agent owner 自己建立一个 GitHub CI 订阅，并因此被唤醒去处理问题。

## 正式文档出口

见 `spec.md` §9。工作项完成后，按 `.scratch/AGENTS.md` 移入 `archive/YYYY-MM/`。
