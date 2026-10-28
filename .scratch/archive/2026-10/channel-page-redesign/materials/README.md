# 材料

本目录是 v1/v2 设计草图的原始资料。**它们是当时的提案，不是当前实现**——实现见 `packages/client-agent-team/src/client/`，结论见同目录 [spec.md](../spec.md)。

## 草图

| 文件 | 内容 |
| --- | --- |
| `prototype.html` | v1（@Iris）。覆盖 stream 锚点重量、task 弹窗、讨论右侧面板、task board、移动端；顶部按钮可现场切换三种布局模式做对比 |
| `prototype-v2.html` | v2（@Reeve）。去掉 task 弹窗，task 点进走 Thread 页层级；讨论保留右侧面板 |

## 截图

`shot-*.png` 是 v1 草图的截屏，`shot-v2-*.png` 是 v2 草图的截屏。它们记录的是**当时的原型**，因此与今天的实现有多处已知不同（面板座位、页头对齐、已完成行的样式）。

## 复跑

```bash
node shot-v2.mjs [outDir]   # 默认写回本目录
```

无依赖，用系统 Chrome 的无头模式 + CDP 截全页。v1 草图的截屏脚本没有保留。

v2 的六张图可复现：同一原型重跑后五张与提交版本逐字节相同，`shot-v2-channel.png` 有 120 像素（约 3.8M 中的 0.003%）的抗锯齿差异。
