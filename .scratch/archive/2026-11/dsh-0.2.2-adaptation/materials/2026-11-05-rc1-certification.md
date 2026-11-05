# DSH 0.2.2-rc.1 认证证据（执行者读数 + 独立验收读数）

记录日期：2026-11-05。候选宿主：tag `dsh-v0.2.2-rc.1`（commit `66491b05e3`），独立检出 `/home/yu/projects/deepseek-harness-dsh-v0.2.2-rc.1`。候选树：worktree `/home/yu/projects/dsh-agent-team-compat-dsh-v0.2.2-rc.1`，分支 `cert/dsh-0.2.2-rc.1`。

**两个提交**：
- `121611c4` — `feat: move the certified host line to dsh 0.2.2-rc.1`（父提交 master `43c769d3`，39 文件 +645/−240）。
- `299dc0f1` — `fix: adopt the 0.2.2 shell contracts for the settings icon and sidebar`（父 `121611c4`，26 文件 +245/−175）。

工作树里只剩三个 `tsconfig*.json` 未提交：认证环境产物（facades 指向 `../deepseek-harness-dsh-v0.2.2-rc.1`），按约定不入库。

## 1. 交付检查（§3.3 / 票 05 第 1 项）

| 检查 | 结果 |
| --- | --- |
| typert 生成稳定性 | `packages/agent-team/tests/typert-generation.spec.ts` 在全量 test 内（生成后比对，不一致即红） |
| `npm test` | 166 文件通过 / 1 跳过；**2022 用例通过** / 1 跳过 |
| `npm run typecheck` | 四个 project 0 错误 |
| `npm run build` | 绿；三个包 `lib/` 均在，client bundle 1.35 MB CJS |
| `npm run lint` | 102 warnings / 0 errors（与改动前基线逐项相同） |
| `npm pack --dry-run` | 409 文件；tarball 1.33 MB（sha512 尾 `…XKUShpW9FYcqg==`） |
| `check:artifact` | 108 条运行时相对 import 全部落地 |
| `check:facades` / `docs` / `core-skills` / `boundaries` / `versions` / `comments` | 全 OK（versions 16 处一致到 `0.2.2-rc.1`、49 peers；comments agent-team/src 4273/4315、scripts 1622/1622） |
| `git diff --check` | 索引与 HEAD 均干净 |
| 浏览器旅程 | **13/13 通过，157 张截图**（桌面 1440 与窄屏 390×844 两个宽度都有） |

## 2. 浏览器旅程（§3.4 / 票 05 第 2 项）

首轮 13 个文件里 4 个红，逐条归因后全部转绿：

1. **设置页导航图标双重字形**（产品侧）：rc.1 的 `ui-settings-general` 把导航字形包进 `<span class={css.navIcon}>` 并提供官方 `settings.section.icon` 槽位，Team 的 DOM 变通 CSS 只匹配 `[data-…] > svg` 被这层 span 挡住 ⇒ 宿主齿轮与 Team 标记同框。改成官方槽位注册（`TeamSettingsNavIcon.tsx`，id = `team-settings`），删掉 `settings-nav-icon.ts` + module.css + `teamMarkMaskUrl()`。
2. **browsing seat 与宿主条错位 2px**（产品侧）：rc.1 把 `--dsh-sidebar-inline-padding` 从 12 改 8、New Session bar 横向 margin 从固定 2px 改成 `calc(paint-inset + 1px)` = 4px。`.leaveCard` 的 margin 跟着改 4px。
3. **两条窄屏旅程定位器命中两个按钮**（测试侧）：rc.1 页头新增同名的 `data-sidebar-opener`。`support.ts` 加 `openSidebar(page)` 点 `[data-sidebar-opener]`（窄屏侧栏变成 drawer，关闭态 rail 自己的 toggle 不可见）。
4. **同行 third：`team-journey` 里 `[data-sidebar-collapsed]` 的第一个 `div` 子元素**（测试侧）：rc.1 的 AppFrame 在 drawer 模式先渲染 `drawerMask`，`position: absolute; inset: 0` 宽 390。新增 `visibleSidebarWidth(page)` 量「折叠后还盖住视口多宽」，三处断言都换成它。

同一轮 journey 还暴露两处 rc.1 契约导致的可见回归（都已修、都已记 CHANGELOG Fixed）：

- **`.toggleOn` 按下态描边消失**：rc.1 的 outline 变体把描边从布局边框改成读 `--dsh-button-outline-color` 的 inset shadow（ui-primitives README 把该变量写成功能样式的正式契约），原写法改 `border-color` 在新宿主上改不动描边。证据：journey 的 action band `outlineColors` 等式（修前红在 `expected [ 'rgb(151, 157, 166)', …(1) ] to include 'rgba(0, 0, 0, 0.12)'`），度量改成读 inset shadow 颜色后断言「恰好 border-l3 + ghost-active-border 两种」。
- **`.messageCard` 隐藏时仍吃掉点击**：隐藏只置 `opacity: 0`，卡片带 `z-index: 2` 仍在 hit-test。窄屏下讨论面板的「关闭讨论」被 feed 里一条消息的 `引用这条消息` 截住（journey 第 933 行 `subtree intercepts pointer events`）。修法：两个媒体分支都在隐藏态加 `pointer-events: none`、揭示态 `auto`（touch 分支本来就有，hover 分支补齐）。

另有两处 journey 结构性适配（rc.1 的 drawer 取代了窄屏 56px 导轨，`sidebar.workspaces` 的 `wide` 在 drawer 模式恒为 true）：rail 那一整套断言（标签、未读点、hover hint、当前页填充）搬到**桌面折叠** lane；窄屏改为断言 drawer 里的 Inbox 卡；inbox 结尾的「收起后 rail 图标戴当前页填充」并进桌面 rail 那段。

## 3. 升级与安装（§3.5 / §3.6，独立验收读数）

**§3.5 已在终树上由独立验收重做一轮**（`EVIDENCE-certification-299dc0f1.md`，tarball `contexera-dsh-agent-team-0.2.6.tgz` 409 文件 / **1,329,317 字节** / sha512 `XFmjbYXHiWcw2…HLeZxNc+Pb9ew==`）：扁平安装 661 包、`@deepseek-ai/*` 333 个其中 **322 个 0.2.2-rc.1、0 个 0.2.1-rc.\***、单一 `dsh-agent`、无 ERESOLVE 无 peer 警告；真实 profile 布局符号链接 0 条、宿主 `0.2.2-rc.1`（`c59d10a`）、Client 组装 74 条含 Team、8 个 inject 全在、Team Client 模块 1,346,218 字节、账本 `agent_team|1` + `agent_team_subscriptions|4`；`comm` 证明 **tarball ⊆ 树**（树多出的 385 个是 docs/tests/scripts）。早一轮（`121611c4` 的 tarball，1,332,034 字节、Client 模块 1,349,358 字节）结论相同，差异全在 Client 产物尺寸。环境坑：webhook ingress 默认绑 `127.0.0.1:3081`，与在跑的 `dsh web`（3080）冲突，必须设 `DSH_TEAM_WEBHOOK_PORT=0`。

**§3.6 前半（既有历史升级）零新增拒绝）**：767 个会话逐条 `open(read)`，755 通过、12 拒绝；对照组（同脚本、同一份副本、0.2.1-rc.2 树）720 通过、47 拒绝 ⇒ **新增拒绝 0**，候选比认证线多接受 35 条，原因全部是 `subagent/descriptor version 2`（rc.1 把 v0 审计的 descriptor 版本放宽到 1/2/3）。那 12 条在对照线上同样拒绝、错误文案逐字相同，是早于这条线存在的结构性缺陷（turn 帧不闭合 / 未分类 message source / 存储日志损坏），按「候选相对认证线新增的拒绝」执行。Team Member 会话 619（换代 511）中当前格式工件 274（换代 204）**全通过**。1495 个文件读前读后指纹一致，`changedFiles` / `addedFiles` 为空，没有改写既有工件。留档：`audit-control-021rc2.json` / `audit-result.json` / `audit-final.json`（均在 `/home/yu/projects/.cert/0.2.2-rc1/`）。

**§3.6 后半（已发布 0.2.6 在候选宿主上可用）**：npm `latest` 仍是 0.2.1-rc.5、`next` 才是 0.2.2-rc.1 ⇒ 默认安装仍解析到已认证宿主，候选上线不当场打碎任何新装 ⇒ 本轮属例行认证，不是 release-blocking。真实 profile 布局通过：装上（只有 peer WARN）、启动正常、Team Host 真的挂上（账本初始化 2 条操作）、Client 组装 74 条、Client 模块 1,109,182 字节。Member 创建未实测（要走认证 Web/WS RPC，curl 够不到），记「未测量」不记 0，由候选 bundle 的浏览器旅程覆盖。

## 4. 剩余风险与未决

- **版本面已经动了，只剩版本点和认证段**：`121611c4`（"move the certified host line"）已经把 `engines.dsh`、49 条 DSH peer、CI 的 `DSH_HARNESS_TAG`、README 双语安装指引和 `docs/dsh-release-compatibility.md` §6 的「当前基线」段一起移到 `>=0.2.2-rc.1 <0.2.3`；`check:versions` 现在读到「16 处一致到 0.2.2-rc.1、49 peers 承认、plugin 仍是 0.2.6」，`check:docs` 双语 29 对全过。这比 §4 的「原子移动」提前了——因为不抬 facades 和区间就没法在 rc.1 上编译和测试；树没有推送、npm 上 0.2.6 仍带旧区间，所以没有用户可见后果。**真正剩下的发布动作**：① `docs/dsh-release-compatibility.md` 双语各补一段 `### DSH 0.2.2-rc.1` 认证记录（§6 现有段落是「当前基线」陈述，历史段还停在 0.2.1-rc.5）——独立验收已绿，前置条件满足，但它**必须点名发布版本**，所以跟发布动作同批落地，草稿见 §6；② 版本点 0.2.6 → 下一版 + CHANGELOG release 段 + tag + 推送 + 发布。**这棵树不能按 0.2.6 去 pack/发**（0.2.6 已在 npm 上且带旧区间）。
- **两个上游契约变更不做对抗性修复**：① `compaction-basic` 的换代守卫（新窗口压不动就拒绝换代并保留原路由，pending 选择留着）——只补文档；② `ToolRestriction` 只过滤 global 工具、scoped registrations 仍被声明（Vera 证明这是 0.2.1 就有行为，可观察变化来自 Team 不再有 assembly 期过滤）——官方 Team 插件的工具在 rc.1 下会对 Member 的模型声明，但执行仍被 Team 的 guard 拒绝。
- **可选的激活期加固未做**（Vera 提的 `tools.get(name, scope) === bindings.get(name)` 身份校验）：`member-runtime.ts` 有意偏好可用性而非激活失败，guard 已在执行期拒绝，加了还会和刚写进文档的那句矛盾。

## 5. 独立验收结论（Vera，17:18，Thread seq 27399）

**判绿：`299dc0f1` 原样通过，认证侧不再要任何改动。** 全部读数取自她自己在最终树上的复跑，没有借用执行者读数。证据：`/home/yu/projects/.cert/0.2.2-rc1/EVIDENCE-certification-299dc0f1.md`（另两份 `EVIDENCE-3.5-dependency-graph.md` / `EVIDENCE-3.6-published-bundle.md` 在同目录）。她随即 release 了 claim:f3cffa00；执行者的 claim:fbfcaa52 也在 17:22 收尾，Task #51 转入 `in_review`，accept 归 Human。

她这一轮补上的、执行者没覆盖到的读数：

- **typert 生成前后 sha256 相同**（5 个产物逐字节不变）——执行者只跑了包着它的 spec，没有单独做生成前后比对。
- `npm pack --dry-run` 409 文件 / 1.3 MB / **7.5 MB unpacked**（我最初写的「7.5 MB」是解包后体积，已改为 tarball 1.33 MB）；`check:artifact` 的 artifact entries 也是 409，与 pack 一致。
- `typecheck` 覆盖 4 个 project，含 `tsconfig.scripts.json`。
- 视觉抽检：`artifacts/browser/settings-nav/settings-nav-{desktop,narrow}.png` —— Team 行画本包标记（环 + 芯），其余行仍是宿主自己的字形，390 下同样成立，没有双重字形。157 张截图里只抽检了这两张（本轮唯一被修的可视缺陷），其余按旅程断言判绿。
- §3.6 的 Team 侧切面：Team Member 会话 619（换代 511）中，当前格式工件 274（换代 204）**全通过**。

她写下的五条判绿边界（后来人别误读）：① 那 12 条拒绝在对照线上同样拒、文案逐字相同，是既有结构缺陷，§3.6 只按「候选相对认证线新增的拒绝」执行，不背书「将来能修」；② 真实 profile 布局下的 Member 创建记「未测量」，覆盖面是 13 条旅程而非真实 RPC，两个口径分开写是对的；③ `scripts` 注释 1622/1622 零余量，下一个碰 `scripts/` 的人得先拆再写；④ 不能以 0.2.6 发布，发布提交形状是「版本点 + CHANGELOG release 段 + tag」；⑤ 三个 `tsconfig*.json` 是环境残留，提交不留。

她还认了自己的一处错（16:43 用 grep 零命中断言「别的设置行仍是宿主齿轮」那条不在，其实一直在，是她的模式里没有 `nav button` / `circle`），教训记在这里：**零命中只证「这几个词没有」，不证「这个断言没有」**。

## 6. compat 文档新段草稿（等发布版本号定了再落，双语同批）

按 §4 与独立验收证据第 3 条，`### DSH 0.2.2-rc.1` 一节**必须点名发布版本**，所以跟发布动作同批落地；`<版本>` 未定前不写进维护文档。草稿如下，发布时把 `<版本>` 换掉、按 `check:docs` 的最长段上限拆段即可（现有段落的长度形状可直接照抄）。

**英文（`docs/dsh-release-compatibility.md`，接在 `### DSH 0.2.1-rc.5` 之后）**

> ### DSH 0.2.2-rc.1
>
> DSH `0.2.2-rc.1` is certified on a moved peer line, `>=0.2.2-rc.1 <0.2.3`, shipped as Agent Team `<版本>`. The candidate falls outside `>=0.2.1-rc.2 <0.2.2`, so section 4 moves the peers rather than recording a baseline in place.
>
> At certification time npm `next` pointed at the candidate while `latest` still pointed at `0.2.1-rc.5`, so the declared line keeps admitting the host a default install resolves.
>
> Tag `66491b05e3` (2026-11-04) carries 8,278 changed files against `dsh-v0.2.1-rc.2`. Four upstream contract changes drove the round: the settings nav icon gained an official `settings.section.icon` slot, the narrow sidebar became a drawer, the outline button variant moved its stroke to an inset shadow reading `--dsh-button-outline-color`, and the sidebar paint inset shrank from 12px to 8px.
>
> Section 3.6 closes with no new refusal: 767 stored sessions were reopened, 755 pass and 12 are refused, while the equivalent control line refuses 47; every extra acceptance is a `subagent/descriptor version 2` artifact. Section 3.5 resolves a flat install to 322 `0.2.2-rc.1` packages and zero older ones.
>
> Evidence on the certified tree: `npm run typecheck`, `npm test` (2022 passed, 1 skipped), `npm run lint` (102 warnings, 0 errors), `npm run build`, `npm pack --dry-run` (409 files), `check:artifact` (108 runtime relative imports resolved), `git diff --check`, and `npm run test:browser` (13 journeys).

**中文（`docs/dsh-release-compatibility.zh.md`）**

> ### DSH 0.2.2-rc.1
>
> DSH `0.2.2-rc.1` 在移动后的 peer 线 `>=0.2.2-rc.1 <0.2.3` 上认证通过，随 Agent Team `<版本>` 发布。候选版本落在 `>=0.2.1-rc.2 <0.2.2` 之外，因此按 §4 移动 peer 而不是就地记录基线。
>
> 认证时 npm `next` 指向候选，`latest` 仍指向 `0.2.1-rc.5`，所以声明线继续接纳默认安装真正会解析到的那个宿主。
>
> Tag `66491b05e3`（2026-11-04）相对 `dsh-v0.2.1-rc.2` 改动 8,278 个文件。推动本轮的是四处上游契约变化：设置导航图标有了官方 `settings.section.icon` 槽位、窄屏侧栏变成 drawer、outline 按钮变体把描边改成读 `--dsh-button-outline-color` 的 inset shadow、侧栏 paint inset 从 12px 收到 8px。
>
> §3.6 以零新增拒绝收尾：767 个已存会话被重新打开，755 通过、12 拒绝，而等价对照线拒绝 47 条；多接受的每一条都是 `subagent/descriptor version 2` 工件。§3.5 的扁平安装解析到 322 个 `0.2.2-rc.1` 包、零个更早版本。
>
> 认证树上的证据：`npm run typecheck`、`npm test`（2022 通过、1 跳过）、`npm run lint`（102 warning、0 error）、`npm run build`、`npm pack --dry-run`（409 文件）、`check:artifact`（108 个运行时相对导入全部解析）、`git diff --check`、`npm run test:browser`（13 条旅程）。
