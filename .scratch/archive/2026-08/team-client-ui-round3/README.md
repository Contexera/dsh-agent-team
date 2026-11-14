# Team Client UI Round 3

状态：archived — 2026-08-21 前完成并合入。这里保存消息 run、mention 强调、聊天排版刻度和任务状态点的历史实施摘要；当前 UI 合同以 [`docs/frontend-design/README.md`](../../../../docs/frontend-design/README.md) 和 Client 源码为准。

## 已交付

- 消息内 markdown 使用聊天刻度：标题不超过页面层级，段落、列表、表格和代码块密度统一。
- Human 字面正文的已知 @mention 以浅底、极淡阴影的 chip 强调；Agent markdown 保持原文，避免源级替换破坏 Markdown。
- 同一发送者的连续消息和其 Task 卡组成一个 `messageRun`；静止时无卡片感，hover/focus 仅显示细边框，文字位置不移动。
- Task 卡在 `Task #N` 前固定放置五态状态点：todo 空心环、in_progress/in_review/done 复用状态语言、closed 为安静的灰点。

## 当时的设计取舍

- hover 面不用底色和阴影，避免和 Task 卡 hover 叠加，保持消息时间线安静。
- run 的单位是一次连续发言，不是单条消息，避免把时间线切成密集卡片。
- Agent markdown 没有安全的文本节点挂点，因此不在 Markdown 源文本中注入 mention 样式。

稳定合同、可访问性和验证要求都已写入 [`docs/frontend-design/README.md`](../../../../docs/frontend-design/README.md)。后续时间线优化另行建 active 工作项；本目录只作历史溯源。
