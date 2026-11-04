# SVG Avatar Assets

状态：archived — 讨论完成、方案已定但 Human 决定暂不推进实施（2026-09-01）

最后核对：2026-09-01

## 结论快照

视觉方向已获 Human 确认：12 张预设候选 = 6 张 DiceBear Identicon（CC0 1.0，v3 预览那组 fg/bg 配色）+ 6 张 Bottts Neutral（克制表情变体，配色对齐现有默认头像 hsl 42%/46%，"free for personal and commercial use"，需单独记录条款）。avatar 字段设计为可选：不选保持现有 initial+色相兜底，不随机分配。

实施（Host 字段、Client picker、资产 vendor、custom 上传）整体暂停，未改动任何生产代码。重启时从 [`research.md`](research.md) 的"Addendum: candidate set evolution"一节接续。

## 目录内容

- [`research.md`](research.md)：许可证、来源、视觉适配、技术取舍调查与候选集演变全过程。
- `final-twelve-preview.png`：Human 确认的最终 12 张对比预览（含 24/28px 明暗检查与 creation picker 模拟）。
- `palette-iteration-muted.png` / `palette-iteration-vivid.png`：中途两版配色迭代（过素 / 过亮，均被否）。
- `3plus3-candidate-preview.png` / `six-additional-cameo-rings.png`：更早的候选集探索。

## 重启条件

Human 明确恢复实施；届时按 research.md 中已确认的视觉与默认行为结论另立 active 目录或 ticket，将稳定结论迁入正式文档后再动代码。
