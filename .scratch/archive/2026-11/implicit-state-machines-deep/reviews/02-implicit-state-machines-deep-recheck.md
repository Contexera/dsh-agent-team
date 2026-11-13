# Review 02 — implicit-state-machines-deep（复审）

**Conclusion:** Pass
**Work item:** `.scratch/archive/2026-11/implicit-state-machines-deep/`
**Ticket:** Whole work item（复审 Review 01 的两个 finding）
**Compared:** 当前工作区；上游基线 `8767607a`
**Commits:** None
**Reviewed:** 2026-11-13

## Findings

No confirmed findings.

Review 01 的两个 finding 均已修复：

- 主对话发送尝试现在随请求保存引用的展示快照；目标不在重开后的当前页时，横幅仍显示原作者和摘要，取消引用与重试沿用同一次尝试。
- follower 读取带同一打开内的序号和写后 floor；关注确认会让旧读取失效，并立即重新读取 Host 的 follower 集合，不再等待订阅唤醒。

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| 13-1 扣住主消息回执后导航返回仍只落一条，且原引用在重试前可见 | Met | `team-main-stream.client.spec.tsx` 以 25 条消息覆盖旧页引用、导航返回、失败重试、取消引用；重试请求与首次请求一致。 |
| 10-2 A→B→A 的旧读/写不覆盖新 A，写后读取不被更早读取覆盖 | Met | `team-human-attention.client.spec.tsx` 覆盖旧 controller 读取晚于写后确认，以及确认写入后不依赖订阅即可刷新转交候选。 |

## Checks run

| Command or check | Result |
| --- | --- |
| `DSH_HARNESS_DIR=deepseek-harness-rc2 npm test` | 通过：207 个文件通过、1 个跳过；2,683 项通过、1 项跳过。 |
| `DSH_HARNESS_DIR=deepseek-harness-rc2 npm run typecheck` | 通过。 |
| `PATH=/tmp/review-bin:$PATH npm run lint -- --quiet` | 通过。 |
| `PATH=/tmp/review-bin:$PATH CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" DSH_HARNESS_DIR=deepseek-harness-rc2 npm run test:browser -- team-journey.e2e.ts` | 通过：26 个文件、28 个场景；人工查看了引用横幅、关注控件和转交对话框的桌面与窄屏截图。 |
| `git diff --check` / `git diff --cached --check` | 通过。 |

## Unverified scope and residual risk

- 浏览器套件没有直接构造“被引用消息在更早页、导航返回后重试”的流程；该交错由 jsdom 回归覆盖，浏览器场景覆盖同页引用横幅和重试。
- 当前验证使用临时 `deepseek-harness-rc2` worktree；日常相邻 Harness checkout 仍是 rc.1，不参与本次认证结果。

## Review record

- Spec sources: Review 01、work-item README、issues 10、13。
- Standards sources: 根 `AGENTS.md`、`.scratch/AGENTS.md`、`docs/development/start-and-checks.md`。
- Uncommitted and untracked changes included: yes；复审范围包含当前工作区全部实现、测试、维护文档和归档记录。
