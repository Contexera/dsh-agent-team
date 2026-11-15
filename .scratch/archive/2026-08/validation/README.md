# UI 里程碑证据（2026-08）

这是 2026-08 多个 UI 工作项共享的代表性浏览器截图。它不是独立工作项，也不定义当前 UI 行为；当前契约以 `packages/client-agent-team/src/client/`、测试和 `docs/frontend-design/` 为准。

- **复跑命令：** `npm run test:browser`（相邻 `../deepseek-harness` checkout、`/usr/bin/google-chrome`、无凭据的确定性 fixture）。
- **证据说明：** [browser/README.md](browser/README.md) 列出每张图证明的验收点。

这些图是人工确认的里程碑证据，不是像素级视觉回归基线。日常测试输出写入 Git 忽略的 `artifacts/browser/`；只有能说明验收结论的少量代表图才进入本目录。
