# 设计原则与设计语言

[English](principles-and-language.md) | 中文

## 设计原则
1. **优先复用 Harness 公共原语**（`@deepseek-ai/dsh-client-ui-primitives`）：`MarkdownText`、`Button`、`Pill`、`Modal`、`Tooltip`、`Input`、`StateDot`、图标，以及 `useDismissOnOutsidePointer`、`useAnchoredMaxHeight` 等 hook。Team 不重写这些能力；composer textarea 是唯一例外（`Input` 原语明确只做单行）。`MessageText` 已不在集合内——该原语在 0.1.5 被移除，`TeamMessage` 自行渲染纯文本正文、Markdown 委托给 `MarkdownText`。
2. **只用 DSH alias token 取色**，且只允许主题实际定义的名字（`@deepseek-ai/dsh-client-ui-theme` 的 `design-platform.css` 与 `gradient-shadow-text.css` 是唯一定义处）：文字 `--dsw-alias-label-*`、边框 `--dsw-alias-border-l1..l4`（+`l2-darkmode-thin`/`inverted*`）、背景 `--dsw-alias-bg-*` 与 `--dsw-alias-interactive-bg-*`、状态 `--dsw-alias-state-*`、阴影 `--dsw-shadow-lv1..lv3`、具体值 `--dsw-specific-*`。禁止凭印象引用主题不存在的 token——`var()` 对未定义变量会静默回退 initial，边框/背景直接隐形（2026-08 教训：`border-subtle`/`border-default`/`text-*`/`fill-tertiary`/`surface-primary` 曾整批不存在，时间线全部发丝线与 loading 点从未渲染过）。Team 自有变量只允许派生值（见头像色相）。
3. **聊天密度优先于 assistant 排版密度**：正文统一 14px 档；markdown 原语自带的标题/列表间距在本包内收紧。
4. **渐进披露**：默认状态安静（细边框、无底色），hover/focus 才提升反馈；次要信息用 tertiary 文字色。
5. **durable mutation 不做乐观更新**：提交失败保留输入并以 Host 报错为准；成功后从 Host 投影刷新（`mergeChannelView` 合并而非整体替换）。
6. **键盘与读屏基线不妥协**：所有自定义复合控件都有 role、aria 状态和完整键盘路径。

## 设计语言对齐（DSH 0.1.7，rc.2 基线）
Team Client 渲染在 shipped DSH 外壳内部，必须讲基础 UI 的设计语言。本节是**耐久合同**；可重复执行的机械审计是 `node scripts/audit-ui-parity.mjs`（任何可见 UI 改动后、每次 DSH 升级后都跑一次——其中的 shipped 参考 tripwire 会在 harness checkout 不再定义本对齐所依赖的原语时报警，提示重新核对基线）。

对齐目标是 **0.1.7-rc.2** 的写法：它把焦点环 token 化、把圆角刻度变成命名 token，并重新调圆了几个面（composer 卡 22px → 28px，菜单行与结果行 8px → 12px 与 16px，小胶囊 6px → 8px）。同一份样式如何同时服务 rc.1 与 rc.2，见下面的「双 checkout 规则」。

这条基线已在 **0.2.0-rc.1** 线上复核（认证线见 [dsh-release-compatibility.zh.md](../dsh-release-compatibility.zh.md)），并在 **0.2.0-rc.2** 上做了源码级复核：圆角刻度与焦点环链未变，本表镜像的 shipped 样式表逐字节一致，主题文件只增别名。0.2 真正动过的是本契约**不**镜像的 shipped 面：浮层改读新的 frame inset 变量、转录区微光改走 `TextShimmer` 原语、聊天气流间距收紧到 6px（助手回复后 12px）。Team 时间线保持自己的消息节奏、不采用那个间距：它的行是带座位的消息，预留身份位、正文自带 markdown 块级外边距，固定的转录 flow gap 在这里没有对应物。

| 维度 | 规则 | shipped 参考 |
| --- | --- | --- |
| 纯图标控件 | 28×28 圆形，`border-radius: 999px`，`corner-shape: round`，透明底色，hover 用 `--dsw-alias-interactive-bg-hover-solid`（composer）/ `--dsw-alias-interactive-bg-hover`（侧栏） | `InputBar.module.css .add`、`SidebarRoot.module.css .iconButton` |
| 主圆形动作（发送/停止） | 34×34 圆形，`--dsw-alias-button-info-fill`，静态 `#fff` 图形，hover info-hover，disabled `opacity .4` + `cursor: default`，`translateY(-2px)` 座位补偿 | `InputBar.module.css .primary` |
| 列表行 | shipped 圆角刻度的 md 档（12px）；`aria-current="page"` 叶子行底色；hover `--dsw-alias-interactive-bg-hover`。这一档跟着「行」本身，而不是它落在哪个面上：承载一个人或一个实体的行——侧栏的频道与 Agents，以及成员弹窗、频道编辑器与 Agent 导入共用的名册行——渲染在哪里都是列表行。 | `SidebarRoot.module.css .panelRow`（0.1.6 线起 12px，harness c6b81a75；0.1.7-rc.2 起读 `--dsw-radius-md`） |
| 队列/结果行（双行） | 整宽按钮，lg 档（16px；rc.1 checkout 上为 8px）、左右 8px 内缩，每条事实独占一行、各自省略，hover `--dsw-alias-interactive-bg-hover`，焦点环内缩。字号分级两行：主体 14px/22px primary；来源/元信息 12px/18px tertiary，其中显著片段（频道名）提到 secondary 600；行内 `Task #N` 是小胶囊。哪一行承载哪条事实，由该面自己的信息顺序决定。**这与「列表行」是两个维度**：`.panelRow` 在 0.1.6 线并到了栏的 12px，而 `.searchResultRow` 一直是 8px——直到 0.1.7-rc.2 把它提到 `--dsw-radius-lg`。 | `ui-workspace/src/client/rows/Rows.module.css .searchResultRow`（8px 内缩、整宽按钮、hover 底色、14px 标题 + 12px 元信息） |
| 胶囊与圆形 | 任何**实质无上限**的圆角——`border-radius: 50%`、`999px`，或等于盒子一半高度的 pill 圆角——都必须在同一条规则内配 `corner-shape: round`。平台把所有圆角面按 `superellipse(1.5)` 弯曲，会把正圆压成方圆、把胶囊两端切平；shipped 的全圆角块 100% 配对，审计对未配对者直接报错。 | `ui-theme/src/styles/corner-shape.css`；`Tag.module.css`、`StateDot.module.css`、`SidebarRoot.module.css .iconButton` |
| 计数徽标 | 读者看到的每一处计数共用一枚胶囊，声明只有一份，在 `countBadge.module.css .badge`：18px 高、`min-width: 18px`，`border-radius: 999px` 配 `box-sizing: border-box`（单字符保持正圆，不被 padding 撑成椭圆），底色 `--dsw-alias-state-business-primary`、文字 `--dsw-alias-label-primary-foreground`，为 0 隐藏、超过 99 显示 `99+`，数字挂在控件的可访问名（`aria-label`）上，不能只存在于视觉徽标里。 | `Tag.module.css`（只读胶囊语言）；`countBadge.module.css .badge` |
| 小胶囊 | shipped 圆角刻度的小档（8px；rc.1 checkout 上为 6px——0.1.7-rc.2 淘汰了 6px 档），`--dsw-alias-interactive-bg-hover` 底色 | `composer-editor.module.css .reference`（行内引用；shipped 保持透明、hover 才叠 business 色） |
| 控件间距 | composer/侧栏工具组内兄弟控件间距 12px；composer 在窄于 560px 时缩到 8px | `InputBar.module.css .tools/.trailing`；composer 自己的 `@container (max-width: 560px)` |
| 键盘焦点 | 焦点环用 shipped 的 token 写法：`outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`——全站一种颜色。兜底值就写这个 business 色，所以 rc.1 checkout 上也画同一种蓝；在 rc.2 上宽度、颜色与「指针输入时把非可编辑控件的环清空」的抑制都由平台掌管。offset 仍按控件自定（行用 `-2px`）。`outline: none` 仅当同一条规则内有**环级替代**时才允许（outline、`box-shadow`、`border-color`、`text-decoration`）。豁免：`aria-activedescendant` listbox 行——焦点留在文本输入框，选中态由 `[aria-selected]` 呈现 | `SidebarRoot.module.css .panelRow:focus-visible` |
| 图标语义 | 图形沿用基础 UI 的含义：`+` = 命令菜单、回形针 = 附件、铅笔 = 编辑。**禁止**把 shipped 图形挪作他用。0.1.7 改名了整套图标——尺寸从名字里移出、字重进入名字（`Icon*OutlineRegular`、`Icon*OutlineMedium`、`Icon*OutlineArtwork`），尺寸走 `size` prop——并删掉了 shipped composer 自带的附件控件，所以 Team composer 的回形针是本仓自己的约定。字重按控件选定而非按尺寸：composer 的领起控件在 14px 用 `Medium`（shipped 的 `+` 即如此），而更广的图标集合在 12–14px 仍是 `Regular`——Team composer 自己的附件与模式控件随 composer 走。 | `InputBar.tsx`（`+` 经 `aria-haspopup="listbox"` 打开命令菜单，`IconPlusOutlineMedium size={14}`） |
| Team 自有图形 | Team 画自己的图：shipped 图标里没有表示「Team」的那一个，插件列表在没有图标时显示的是默认占位图。根 manifest 的 `icon` 字段指向 `assets/icon.svg`（包内相对路径，SVG/PNG/JPEG/WebP，≤256 KiB，经 `files` 随包发布），也就是插件列表渲染的彩色标识；rail 行则携带同一张图的 16px 单色标记，形态沿用 shipped 图标（`viewBox="0 0 16 16"`、`fill="none"`、`stroke="currentColor"`、`stroke-width="1"`、几何落在 2..14 内、`aria-hidden`），因此在两种主题下都随该行自己的墨色。 | `assets/icon.svg`；`TeamPanelIcon.tsx`（rail 行图形）；`package.json`（`icon`） |
| 模式控件（composer） | 改变主操作**语义**的控件（「作为任务」）是**模式**而不是动作：它在任何宽度都保留可见文字标签，与附件控件同处左侧分组，形态为 28px 高的 chip（8px 圆角、13/20px 字重 500、透明底色、hover `--dsw-alias-interactive-bg-hover`、`aria-pressed` 打开时 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`）。shipped 在 0.1.7 删掉了带字权限 chip 与其 460px 收起标签，因此文字在任何宽度都不再隐藏，composer 改为在窄于 560px 时缩控件间距（`aria-label`、`title`、`aria-pressed` 照旧承载模式语义）。 | `InputBar.module.css .row`（size container）；模式控件现在是 `.select`（28px、8px 圆角、13/20 medium） |
| 悬浮表面 | 解析为半透明颜色的 surface token（`rgba(…, α < 1)`）必须在同一条规则内配背景模糊，并带上 elevation 描边与阴影——浮卡配方：`background: var(--dsw-specific-menu)`、`backdrop-filter: var(--dsw-menu-backdrop-filter)`、`--dsw-elevation-stroke-color`、`box-shadow: var(--dsw-elevation-prominent)`。0.1.7 把 `--dsw-specific-menu` 改成了半透明**却没有改名**，于是「当成不透明底来画」的弹层会真实地读不清，而所有存在性检查仍是绿的；审计的毛玻璃表面规则负责抓这一条。0.1.7-rc.2 保留该名字、让它指向新的 `--dsw-menu-surface-fill`，配方因此不变；形状是 lg 档的面配 md 档的行（`.list`、`.item`），手搓的弹层说的就是 `Menu` 原语的语言。 | `ui-primitives/Menu.module.css .list` |
| 卡片表面 | 承载内容的卡面用 elevation 发丝描边，而不是布局边框：`border: 0` + `--dsw-elevation-stroke-color` 取该层的中性色（菜单 l1、composer 卡 l2，两者差一档）+ 该层阴影。用 dark-mode thin 别名画实打实的 1px，在深色下只有应有一半的 alpha，还要占布局。 | `InputBar.module.css .card`（`border: 0`、描边 l2、`--dsw-elevation-soft`）；`Menu.module.css .list`（描边 l1、`--dsw-elevation-prominent`） |

**双 checkout 规则。** 一份样式要同时服务两个 checkout：本仓今天构建所依据的 rc.1，以及 rc.2 基线。因此凡是 rc.2 才进入 shipped 主题的 token，都要把它取代掉的那个字面量写成兜底（`var(--dsw-radius-md, 8px)`、`var(--dsw-focus-ring-width, 2px)`）：token 把语言带向新版本，兜底让旧 checkout 保持它今天的渲染。审计两头都管——未定义且不在它的 forward-declared 名单上的 token 报错，名单内但没写兜底也报错。

有三处**刻意不跟齐**。它们是裁决而不是漂移，写在这里是为了避免后来者把它「修好」：

- **小胶囊底色**：shipped 的 `.reference` 是行内编辑器引用，平时透明、hover 才上色；Team 的 chip 要在 14px 正文里读成同一个 token，因此继续以共享 hover 底色作为自己的地面。
- **composer 卡内距**：shipped 卡上 8px、下 4px；Team 的卡多了它没有的行（收件人提示行与附件 chip），因此保留上 10px、下 8px。卡的描边、圆角、底色与阴影与 shipped 完全一致。
- **中性描边宽度**：shipped 把每一条中性分隔线都写成 `0.5px`（`--dsw-alias-border-l*`，共 164 处），但 Chromium 会把 `border-width` 向上取整到整数 CSS 像素——computed 的 `0.5px` 边框在设备像素比 1×、1.25×、2×、3× 下都报成并画成 `1px`，把 shipped 源码原样取出逐像素实测也是这个结果。Team 直接写实际渲染的那个值 `1px`：像素与 shipped 完全一致，源码说出的就是眼睛看到的。真正的半像素机制是上一条「卡片表面」所用的 `box-shadow` 发丝线。

按面记录的组件级裁决在 [components.md](components.md)；审计脚本报告机械漂移，判断由这些文档拥有。
