# Thread 聊天气泡 + 「有人@我」标记

## 状态

**已实现，待在装有 Harness 检出的环境跑测试** — 代码改动完成，`check:docs` / `check:boundaries` / `check:versions` / `check:core-skills` 通过；`typecheck` / `vitest` / `test:browser` 因缺少 `../deepseek-harness` 同级检出而无法在本机运行。

## 最后核对日期

2026-10-07

## 当前前沿

- 已完成：代码勘察、需求决策（`spec.md`）、单文件 HTML 原型、原型评审（徽标两轮调整后定稿于气泡内部右上角）。
- 已完成：`TeamMessage` 气泡 DOM + `data-side` / `data-mentions-me`；`conversation.module.css` 气泡与徽标样式；`zh`/`en` 的 `mentionsMe`；`TeamThreadPage` / `TeamChannelPage` 接线；`TeamRunDivider` 增加 `side`；`team-formatters.ts` 新增 `HUMAN_MEMBER_ID` 与 `mentionsHuman`。
- 已完成：测试补充（气泡分侧、徽标显隐、徽标在气泡内、折叠控件在气泡内；`mentionsHuman` 与 Host 身份一致）。
- 已完成：`docs/frontend-design/components.md` 与 `.zh.md` 双语更新；`CHANGELOG.md` 新增 Unreleased 条目。
- 阻塞：本机没有 `../deepseek-harness` 检出，`npm run typecheck`、`vitest`、`npm run test:browser` 无法执行（见下）。
- 下一步：在具备 Harness 检出的环境跑 `npm run typecheck && vitest run`，再跑 `npm run test:browser`，按桌面与 390×844 截图核对气泡与徽标。

## 完成条件

- Thread 页时间线以气泡呈现，同一发送者连续发言合为一个视觉组。
- 一条消息的 `mentions` 含 `member:human` 时，该气泡带「有人@我」标记，且该标记不改变气泡的左右归属。
- Activity / 日期分隔 / 未读分界保持非气泡形态。
- 明暗主题、390×844、键盘可达、`npm run test:browser` 通过。

## 未能执行的验证（需要你在具备 Harness 检出的环境补跑）

本仓库的 `vitest.config.ts` 与 `tsconfig` 路径门面都指向同级 `../deepseek-harness` 检出，本机不存在该目录，因此以下命令在启动阶段即失败（非本次改动引入）：

- `npm run typecheck`
- `npx vitest run`
- `npm run test:browser`

本机已执行并通过的替代性静态验证：所有改动文件用 TypeScript 解析器解析无语法错误；CSS 花括号配平；`css.*` 类名与 `t?.('<key>')` 文案键全部能解析到定义；`check:docs`、`check:boundaries`、`check:versions`、`check:core-skills` 全绿。

## 正式文档出口

已落地：

- `docs/frontend-design/components.md`（`TeamMessage` 气泡契约 + 「有人@我」标记契约）与 `.zh.md`。
- `CHANGELOG.md` 的 Unreleased 条目。

`.scratch/active/thread-chat-bubbles/` 在测试通过并确认后归档到 `.scratch/archive/2026-10/`。

## 目录

- [`spec.md`](spec.md) — 已确认的需求决策快照
- [`prototype/bubbles.html`](prototype/bubbles.html) — 视觉原型，浏览器直接打开
