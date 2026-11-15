# claim-panel-ux — Claim 面板与 Thread/Channel 顶层栏走查（human 2026-09-13/14 需求）

- **状态**：已完成并归档（2026-09-19）。human 2026-09-19 16:35 验收「问题不大，一行预览就行」，16:36 批准归档并删除一次性产物。
- **交付提交**：`feat: rework the Thread header band and Claim panel`（8 文件，+200/−47）；归档材料作为同一笔提交的一部分落下（本地 amend，未重开归档提交）。
- **正式文档出口**：`docs/frontend-design/components.md` + `.zh.md` 的顶层栏 / Claim 面板小节、`CHANGELOG.md` Unreleased —— 归档时已落地，本目录不再改动。
- **最后核实**：2026-09-19。提交前门禁全绿（`npm test` 711 passed / 53 files、`npm run test:browser` 4 passed、`node scripts/audit-ui-parity.mjs` exit 0、`npm run check:docs` OK、`npm run lint` 0 error（2 条既有 warning）、`npm run typecheck` 通过）；归档时再用 `recipes/verify.e2e.ts` 复跑一次交付态，数值与提交前一致（见下）。

## 需求与结论

human 原话（2026-09-14）：展开态信息多、层级不明确；线更多、层次不清晰显得乱。

**实测推翻了「两区顶边线与页头底边叠线」的初判**：基线量测显示带内只有每区各自的分隔、没有重复叠线（基线带内带边框元素：展开 3 / 折叠 2 / 窄屏展开 3）。真因是**顶层栏过高（展开态 426px，占 960px 视口 44%）+ 分区之间没有呼吸**。所以改的不是「删线」，而是压高度、给分区留间距，顺带把带内分隔线收到 0。

| 指标 | 改前（基线实测） | 交付态（归档时复跑） |
|---|---|---|
| 顶层栏高度，1440 展开 | 426px | **360px** |
| 顶层栏高度，390 展开 | 540px | **390px** |
| 带内带边框元素数（展开 / 折叠 / 窄屏展开） | 3 / 2 / 3 | **0 / 0 / 0** |
| 风险行行数（桌面 / 窄屏） | 2 / 4 行 | **1 / 1 行** |
| claim 行高（桌面 / 窄屏） | 44 / 48px | **44 / 44px** |
| claim 行网格 | 5 轨（身份、状态、方向各占轨） | **3 轨全占满**：`14px 783px 33px`（窄屏 `14px 213px 33px`） |
| taskless Thread 开篇 | 页头高度随正文长度变化 | 开篇压 1 行：长开篇与短开篇页头同为 **114px**（窄屏 144px） |

交付态三态：1440 展开 360px、1440 折叠 224px、390 展开 390px；窄屏 `documentElement.scrollWidth` = 390（无横向溢出）。

走查中还删掉一处重复表达：human 指出 handle 旁的绿色 `.claimLive` 点与行首 presence 点是同一件事（已删）。

## 目录内容

```
claim-panel-ux/
├── README.md      # 本文件（归档收口记录）
├── validation/    # 人工确认的代表图 + 每张图的验收点与复跑命令
└── recipes/       # 复跑配方（非验收门禁）
```

### validation/

见 [validation/README.md](validation/README.md)。三张代表图分别对应：改前/改后首屏对照、交付态三态、taskless 一行开篇。

### recipes/

`run-local.mjs` 是通用启动器，其余 5 支是当时跑过的量测配方：

| 配方 | 量什么 |
|---|---|
| `measure.e2e.ts` | 走查首轮的基线量测：顶层栏高度、带内带边框元素、风险行行数、claim 行盒模型与列宽、页面横向溢出 |
| `preview.e2e.ts` | 注入候选设计（CSS + 实现要做的 DOM 改写）后的改前/改后对照图与数值 |
| `verify.e2e.ts` | 交付态复核（不注入任何 CSS）：把真实实现放进同一 fixture，看它是否落在预览承诺的位置 |
| `column.e2e.ts` | 顶层栏两侧与对话列的对齐关系、列宽改为铺满表面后的数值 |
| `taskless.e2e.ts` | taskless Thread 的页头高度是否随开篇正文长度变化 |

用法与前提：

```bash
node .scratch/archive/2026-09/claim-panel-ux/recipes/run-local.mjs verify.e2e.ts final
```

- 启动器替换配方里的 `__TEAM_ROOT__` / `__OVERLAY__` / `__HOME__` / `__CHROME__` / `__LABEL__` / `__OUT__` 占位符，把配方复制进相邻 Harness checkout 的 `apps/web/tests/` 跑完再删；配方 import 该处的 `scaffold.ts` 与 `support.ts`，因此不能就地运行。
- 产物（截图、JSON 探针）写到 Git 忽略的 `.scratch/local/claim-panel-ux/<label>/`，不落进本归档。
- 前提见 `docs/development/environments-and-install.md` § Sandbox and CI environments：本仓依赖已装、`npm run build` 已产出 `lib/`（配方复制 TEAM_ROOT 进临时 profile 时排除 `src/`，直接用构建产物）、相邻 `../deepseek-harness` checkout 可用、`/usr/bin/google-chrome`（可用 `CHROME_PATH` 覆盖）。
- 归档时删掉的一次性产物：中间 JSON（`measure-*` / `preview-*` / `verify-*` / `column-*` / `taskless-*`）、重复截图目录（`shots/`、`shots-baseline-momo/`、`preview-*`、`verify-*`、`taskless-*`、`compare-preview/`）、`run.log`，以及三个一次性启动/截图脚本（`run-measure.mjs`、`run-shots.mjs`、`claim-shots.e2e.ts`）。所以上表的「改前」数值来自归档前那一次 `measure` 运行，中间 JSON 已随一次性产物删除、无法再复核；「交付态」数值可随时用 `verify.e2e.ts` / `taskless.e2e.ts` 重跑。

## 归档说明

本目录是 2026-09-19 归档时的快照：归档状态与当时的术语只代表那时的工作上下文，不覆盖当前实现（以 `packages/` 源码与测试为准）。归档后不再修改。
