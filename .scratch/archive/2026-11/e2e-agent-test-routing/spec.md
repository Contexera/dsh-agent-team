# E2E 测试选择、Agent 反馈与文档入口规格

- **基线提交：** `bc06d0d2` (`master`, 2026-11-16)
- **工作项：** [README.md](README.md)
- **Binding references:** 根 [`AGENTS.md`](../../../AGENTS.md)、[`docs/development/start-and-checks.md`](../../../docs/development/start-and-checks.md)、[`docs/development/generated-and-seams.md`](../../../docs/development/generated-and-seams.md)、[`scripts/run-browser-test.mjs`](../../../scripts/run-browser-test.mjs)、[`scripts/e2e/`](../../../scripts/e2e/)
- **Background evidence:** [materials/current-audit.md](materials/current-audit.md)

## 一、问题定义

当前测试体系已经具备 Vitest 分层、Host/Client 测试底座、单 lane 过滤和真实浏览器截图门禁，但 Agent 仍需要跨多个文件自行拼出测试选择规则：

- 根 `AGENTS.md` 没有按改动接缝路由测试的短规则；
- `start-and-checks` 只给出两个 lane 示例；
- `scripts/README.md` 保留了已删除 lane 的目录描述；
- 当前没有维护的“功能 → lane → 低层测试 → 证据”索引；
- Runner 结束时主要输出截图数量，不报告 lane 契约、阶段、耗时和失败归属；
- 一个 `team-journey` 测试承载大量局部 UI 断言，失败定位成本高；
- 浏览器验收不在常规 CI 中执行，缺少 Chrome 时 Agent 只能得到环境错误。

因此，Agent 可以开始执行，但不能稳定完成“选择检查 → 定位失败 → 修复 → 复跑 → 汇报未验证范围”的闭环。

## 二、设计目标

### D1 — 根入口只负责稳定路由

根 `AGENTS.md` 增加一个短的 Test selection 小节，说明：

- Host、Ledger、Remote、权限、持久化、订阅和 Worker 状态优先运行 targeted Vitest；
- Client 状态机、DOM 交互和错误文案优先运行 Client spec；
- slot、preset、bundle、Remote activation、普通 DSH 恢复、真实键盘、真实布局和多页面订阅运行对应 browser lane；
- 完整跨表面流程、发布前验收或 browser runner/support 改动运行完整 `npm run test:browser`；
- targeted lane 是开发反馈，完整 browser acceptance 是 assembled Web 改动的交付门；
- Chrome（默认 `/usr/bin/google-chrome` 或通过 `CHROME_PATH` 指定）、Harness 或其他环境缺失时必须明确报告未验证范围；
- 验证汇报列出改动表面、应运行的检查、实际运行的检查和未运行的检查及原因。

根入口不复制完整 lane 表，也不削弱现有自验标准、授权边界、不得强推或不得未经授权合并的规则。

### D2 — 维护文档保存唯一的人类 lane 契约

新增中英文 `docs/development/e2e-lanes`，每条 lane 至少记录：

- 当前文件和命令名；
- 只有真实 Web/Harness 能证明的契约；
- 对应的 Host、integration 或 Client 测试；
- 哪类改动触发 targeted lane；
- 必须检查的 DOM、键盘、布局、恢复和截图证据；
- 该 lane 不负责证明的内容；
- 测试数量、截图目录和已知成本。

当前 source/tests 是行为 authority；lane 文档只做路由和验收说明，并同步登记在 `docs/README.md` / `.zh.md`、`docs/development/README.md` / `.zh.md` 以及 `scripts/check-docs.mjs` 的 `BLOCK_CHARACTER_CEILINGS`。文件重命名、拆分或合并时必须同步更新 lane 文档和脚本目录说明。

### D3 — 测试选择按风险分层

```text
Host / Ledger / Remote 状态
  → targeted Vitest

Client 状态机 / DOM / 文案
  → targeted Client spec

slot / preset / bundle / ordinary DSH / 浏览器几何 / 多页面
  → 对应 browser lane

跨表面流程 / 发布前组装 / browser runner 或 support 改动
  → 完整 browser acceptance
```

文档必须同时说明“开发过程中先运行什么”和“交付前必须补什么”，避免 Agent 选择完整 E2E 作为所有改动的第一反馈，也避免把 targeted lane 当成完整验收。

### D4 — 当前 lane 的处置

| Lane | 当前处置 | 唯一真实职责 |
| --- | --- | --- |
| `team-journey` | 保留短核心冒烟，拆出局部断言 | 真实进入/退出 Team、基本 mutation、普通 DSH 恢复 |
| `team-inbox-and-recovery` | 保留 | Inbox、离线恢复、附件异常、键盘导航 |
| `team-main-stream-and-board` | 保留表面行为，删除重复创建流程 | Main/Board、Task/Thread 跳转、真实焦点 |
| `team-manager` | 保留 | Manager preset、Session 替换、reload、普通 Session 恢复 |
| `team-settings-and-tools` | 保留 assembled-Web 主流程，下沉低收益局部断言 | Settings 身份配置、extra tool 真实组合 |
| `team-subscriptions` | 保留事件投影，压缩重复状态 | 订阅事件、运行记录、Inbox 投影、窄屏布局 |
| `team-timeline-and-shell` | 保留锚定、多页面、快捷键；移出 bundle toggle | 真实滚动、多页面订阅和快捷键 |
| `team-worker-lifecycle` | 保留代表性 UI，按需运行 | Worker 诊断列表和停止操作 |
| `team-worker-settings-and-thread` | 保留 | Worker 设置、独立 Thread、失败终态 |

禁止为了达到目标秒数直接删除真实接缝断言。每个下沉项必须先有等价的 Host/Client/integration 断言，并保留必要的 assembled-Web 冒烟。

### D5 — Runner 提供结构化反馈

Runner 增加 `--list`，列出当前实际可匹配的 lane（通过 `node scripts/run-browser-test.mjs --list` 可免构建快查，`npm run test:browser -- --list` 亦可用）。为避免成为第二份 lane 行为 authority，`contract` 文本从单一维护来源读取（例如直接解析 `docs/development/e2e-lanes.md` 的 lane 表，或由文档一致性检查校验的共享目录）。成功和失败都应能输出或写出 summary，至少包含：

```text
lane
contract
tests
phase
duration
screenshots
artifact path
environment blocker
```

阶段拆分遵循进程边界，不依赖脆弱的 stdout 文本猜测：

- 外层 Runner（`run-browser-test.mjs`）记录并区分：`preflight`（Harness build 与 `/usr/bin/google-chrome` / `CHROME_PATH` 检查）、`staging`、`vitest`、`evidence`、`cleanup`；
- 场景内（`scripts/e2e/support.ts` 或 Vitest 报告）负责标明失败发生时的子阶段：`Harness/Web 启动`、`页面行为` 或 `Host projection`。

输出必须让 Agent 能直接选择下一次 targeted rerun。

不在第一阶段引入并行共享可变 Scaffold；每个场景继续保持独立 HOME、Workspace、存储和 BrowserContext。安全隔离优先于未经测量的全量并行。

### D6 — 文档一致性由机械检查保护

新增或扩展一个仓内检查，验证：

- 每个实际 `scripts/e2e/*.e2e.ts` 文件在 lane 文档中有条目；
- 文档没有引用不存在的文件；
- Runner alias 的目标 lane 存在，并在文档中标明 alias；
- `scripts/README.md` 不再保留旧 lane 清单；
- 中英文 lane 文档结构一致。

该检查只防止文档漂移，不成为产品行为 authority。

## 三、范围边界

### Included

- 根 `AGENTS.md` 的测试选择入口；
- `docs/development/e2e-lanes.md` 与 `.zh.md`；
- `docs/development/start-and-checks` 的命令和入口链接；
- `scripts/README.md` 的过时 lane 清理；
- E2E 文档一致性检查；
- Runner 的 `--list`、summary 和阶段反馈；
- `team-journey` 的测试边界收缩；
- bundle toggle 下沉；
- Settings 低收益断言下沉；
- 相关低层测试、lane 测试和验收证据。

### Excluded

- 不修改 `../deepseek-harness`；
- 不把 browser E2E 默认加入普通 CI，除非另有明确决策；
- 不为了测试计时并行化共享可变的 Web Scaffold、HOME 或存储；
- 不删除没有等价低层覆盖的回归断言；
- 不把完整 lane 契约复制进根 `AGENTS.md`；
- 不把截图当作像素 snapshot 的唯一产品正确性证明。

## 四、验收条件

1. 新 Agent 只读根 `AGENTS.md` 和 lane 目录，就能从改动接缝选出 targeted check 和最终 check。
2. `scripts/README.md` 不再出现旧的 10-file lane 描述。
3. lane 文档覆盖当前实际文件，`check:docs` 和 E2E 文档一致性检查通过。
4. Runner 的 `--list` 不依赖手写过时清单；summary 能指出 selected lane、测试、阶段、耗时、截图和 artifact 路径。
5. `team-timeline-and-shell` 的 bundle toggle 不再作为 browser 场景运行。
6. `team-journey` 的核心冒烟与局部 UI 验收可以独立定位和复跑。
7. 下沉的每项行为都有可运行的等价低层测试；保留 lane 仍证明真实 assembled Web 接缝。
8. 有 Chrome 的环境完成 targeted lane 和全量 browser acceptance；无 Chrome 的环境把缺口写入验证报告。
9. `npm test`、typecheck、文档检查、E2E 文档一致性检查和适用的 browser checks 通过。

## 五、后续需要记录的开放问题

- Runner summary 使用 stdout、JSON 文件还是两者（以及 json summary 写入 `artifacts/browser/` 还是临时目录）；
- E2E 文档一致性检查是新增 `check:e2e-docs`（并入 `npm test`），还是并入现有 `check:docs`；
- `team-journey` 拆分后的最终测试文件数量和截图预算；
- 有真实 Chrome（含 macOS 通过 `CHROME_PATH`）后，Web Scaffold 启动成本是否仍需要独立优化。
