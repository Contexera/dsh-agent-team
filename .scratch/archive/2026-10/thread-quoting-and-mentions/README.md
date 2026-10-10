# Thread 的引用与 mention 语义（在 master 上重做）

> 本工作项原名 `thread-hover-quote`（在共享 checkout 里未跟踪），2026-10-10 按 Human 要求更名为 `thread-quoting-and-mentions`，并成为**本方向全部讨论与实现的唯一容器**：前六轮的阅读语言（hover／浮卡／座位时间／`@human` chip）与第七轮的「在 master 上重做引用」都在这里。

**状态**：**已归档（2026-10-10）**——本方向的全部成果已在共享 checkout 的 master 上落地为**本地提交**（未 push，等 Human 决定）：`feat: read quoted Messages and the reader's own mention`（读侧引用、「提到了你」、开 Thread 落点）、`docs: document reply quoting, the mention chip, and run dividers`、`fix: state a Message's time under the pointer and keep its action card legible`、`test: pin where a Thread opens on an unread Message that names the reader`。PR #42 的 Host 侧与 client 管道已署回原作者带过来。
**最近核对**：2026-10-10 23:05
**当前前沿**：**无在办事项**。归档依据：durable 结论已进 `docs/frontend-design/`（双语对）与 `CHANGELOG.md` 的 Unreleased 段，过程材料不再有可移植价值。人工验收结论尚未给出，故本归档**不带 `validation/`**（按 `.scratch` 规则只收人工确认过的代表图）；前六轮分支 `preview/hover-quote-r6` 与第七轮 worktree 分支 `preview/quote-on-master` 保留在本地作安全网。
**决策快照**：见同目录 [`spec.md`](spec.md)（引用与 mention 的语义、UI 裁决、做序）。

**完成条件（新方向）**
- [x] 消息行 hover：整行一层极轻填充（shipped `--dsw-alias-interactive-bg-hover`，**不加圆角、无阴影**）+ 时间出现在头像那一列的空白处 + 右侧浮出动作卡（复制正文 / 引用）。**不做删除、编辑**——消息是 append-only 账本，UI 上没有对应写面。
- [x] 卡片在 `:focus-within` 时同样出现（键盘可达）；窄屏 390 不依赖 hover——点一下让行内动作常显。按钮始终挂载（只切 opacity），不进/出 DOM。
- [x] **单独** mention Human 的消息：卡内一行「提到了你」；`@all` 不算（读侧重解 + 与既有 mentions 取交集）。
- [x] 打开**任何** Thread：自动居中命中**第一条未读** mention Human 的消息 + 一瞬间的行层脉冲（复用 flash 形态，遵守 `prefers-reduced-motion`）；没有 mention 就照旧停在末尾；不动既有的未读分隔线。
- [x] 引用：composer 的引用条**按下之前**就写明「会送达 @X」；送达发出者（显式动作，不算隐式唤醒）。
- [x] 气泡砍、同人分组保留、行距回退到既有值；journey 钉住 hover 填充、时间落点、卡片几何（1440 与 390）与 `documentOverflow ≤ 0`。
- [x] 四道门禁绿（`audit-ui-parity` exit 0 / `test:browser` 6/6 / client 包 271 passed / `check:docs` OK）。

**已知边界**：目标消息就在 Thread 末尾时，浏览器无法把它居中（下方不足半屏），只能贴底——行仍可见并闪一下；夹具里特意在它后面留 8 条消息，journey 才能验「居中」而不是「贴底」。

## 落地（2026-10-09 21:26，全部在 `preview/hover-quote`）

| 文件 | 改动 |
| --- | --- |
| `TeamMessage.tsx` | 删气泡与徽标，行结构回归既有层级；新增 `data-card-open`（点行开卡）+ 浮卡 `data-message-card`（`data-mentions-you` / `data-copy-message` / `data-quote-message` + sr-only `role=status` 反馈）；`grouped` 行渲染 `data-gutter-time`；引用块改 `data-quote-line` |
| `conversation.module.css` | 行层 = 纯填充（无圆角无阴影）；`@keyframes rowFlash` 驱动 `data-reply-flash`；`.gutterTime`（28px 座位、hover/focus 显现）；`.messageCard`（`--dsw-radius-md` 12px + `--dsw-shadow-lv2`，`data-side=end` 镜像到左）；`.quoteLine`（无填充、2px 左条、muted、单行省略） |
| `TeamThreadPage.tsx` | `mentionedMe` 去掉 unread 门槛；`firstUnreadMention(facts)` 从**首次 read** 判定 → `pendingJump`；打开时无命中才 `scrollToBottom()`；引用上下文带上父 `messageRef` |
| `TeamComposer.tsx` | 引用条新增「会送达 {name}」行 |
| `locales.ts` | 复制 / 已复制 / 复制这条消息 / 会送达 {name}；回复→引用、徽标文案→提到了你 |
| `tests/team-message.client.spec.tsx` | 两个 describe 重写（无气泡、mention 行在卡上、座位 28px、引用行在身份行之后、复制取**存储 markdown**、点引用行跳**父消息**） |
| `scripts/team-ui.e2e.ts` | 新增约 140 行：hover 前后不透明度与几何、卡 radius/shadow/填充、座位宽、指针移开收回 + 焦点 reveal、引用全流程、打开即跳的居中距离（失败时报差多少 px） |

**顺手修掉两个 PR #42 自带的缺陷**（此前没有任何断言走到）：

1. **点引用行跳到自己**：`onOpenReplyTo` 传的是本条消息的 ref ⇒「跳到被引用的消息」实际滚回它自己。改为父 ref（引用上下文带上 `messageRef`），单测钉住回调参数。
2. **打开即跳被 pin-to-bottom 撤销**：首帧时间线尚未铺完时 `scrollIntoView` 是空操作，紧接着共享滚动策略（`timeline-scroll.ts`，默认 `pinned = true`）把视图拉回末尾。现在目标在脉冲窗口（1.2s）内保持 pending、每次 commit 重新居中，脉冲结束随 `flashedMessage` 一起释放；跳转后立刻调 `timeline.onScroll()` 让策略知道读者已不在末尾。诊断靠 journey 里 25ms 采样 `scrollTop/scrollHeight`（843 → 658 居中）拿到的，不靠猜。

**门禁数字**：`npx tsc -p packages/client-agent-team` exit 0；client 包 28 文件 271 passed；`packages/tool-agent-team/tests/team-thread-render.spec.ts` 14 passed；`node scripts/audit-ui-parity.mjs` exit 0（0 error / 0 warning）；`npm run test:browser` 6/6；`npm run check:docs` OK。截图 `artifacts/browser/ui-05/thread-row-hover{,-narrow}.png`、`thread-quote.png`、`thread-open-on-mention{,-narrow}.png`。

**正式文档出口**：`docs/frontend-design/thread-and-composer.md`（双语对）+ CHANGELOG。

## 新方向（Human 2026-10-09 20:32，附 Raft 参考图）

Human 的原话要点：thread 内默认为沟通、对话的空间；当前 Agent 为收敛结论会来回很多轮，human 不知道该关注什么。**假定交流都是必要且有信息增量的**，那么「如何把 human 放到给方向、作决策的位置」才是要解决的问题。方向：

1. **每条消息 hover**：轻微阴影、**轻且尽量不太圆润**；hover 时显示消息时间；右侧新增悬浮 card（浮在 hover 之上），内含**复制、引用**等按钮——「这样消息有了层次」。
2. **mention**：单独 mention 了 human 的消息，hover 时显示一行「mention you」。
3. **自动跳转**：打开任何 thread，自动跳转到（页面正中间命中）**第一条** mention human 的消息，并作一瞬间的 hover 阴影——「很像一些 im 的处理」。
4. **引用**的扩展：引用的消息**可以直接送达消息发出者**。
5. 参考：Raft 的页面设计（图：同人连发里 hover 那一行整行浅填充、**时间出现在头像列的空白处**、右侧浮一张白色小卡带阴影与两个图标按钮；其余行保持安静）。

**我（Iris）据此改掉的自己的结论**：① 「run 内细线 + 续条常显时间」作废——hover 揭示比常显好，默认更安静；② 「引用保持惰性」作废——引用是显式动作，送达不算隐式唤醒，但 composer 必须让它在按下前可见。

## PR #42 在新方向下的重判

| 块 | 判定 |
| --- | --- |
| 气泡（两侧、内容宽、圆角填充） | **砍**（hover 层次取代它；气泡把阅读列让给装饰，还把 feed 条目行卷进气泡 ⇒ 状态列散成 7 个 x、行距 10→4） |
| 同人连发分组 | **留** |
| 引用骨架（Host 事实 + 引用块 + 跳回原文） | **留，并恢复送达作者**（composer 可见）；`replyEnabled` 之类开关在新方向下不必需 |
| 「有人@我」徽标 + warn 描边 | **砍**（改为 hover 卡内的「mention you」行） |
| 顺手改的既有面（行距、窄屏覆写） | **回退** |
| `:has([data-thread-entry])` 结构耦合 | **不是 PR 带来的**（master `conversation.module.css` 既有四条：397 / 403 / 429 / 433） |

## 已作废的中间方案（备查，别再实现）

**「待你拍板」谓词 + Inbox 切片**：`Human ∈ 事实 mentions` 且读侧重解出**具名**命中（`@all` 不算）且此后 Human 未在该 Thread 发言 ⇒ 待拍板；Thread 页画行首 gutter 条，Inbox 加一条 Human-only 切片（去重、两头不静默裁、老的在前）。

**作废理由**（Human 原话）：「没必要做一些不需要的，如『待你拍板』，这只是因为前置做得不好」——它把「Agent 聊太多」当既定事实去**补偿**（替你筛信息），而根问题是「你怎么给方向、怎么作决策」。

**仍然成立的技术结论**（将来若真要做「待办」类信号会用到）：
- @我 类标记**不能骑 `unread`**（读过即灭，而 Human 找「要我拍板那条」正在读过之后）。
- **`@all` 与具名点名在 ledger 事实里不可区分**：`mentionCandidatesFor` 把 Human 放候选首位（`ledger.ts:3981`），`authored = resolution.all ? candidates.map(…) : resolution.memberIds`（`:4014`），直投标记按 `mentions` 建（`:2762`）；要区分只能读侧用 `resolveBodyMentions`（`mentions.ts:105-115`，返回 `{ memberIds, all }`）重解正文并与既有 `mentions` 取交集。
- **Inbox 准入门槛是「未读」**：`inboxForWorkspaces` 里 `unread.length === 0 → continue`。
- **两道静默截断**：Host `limit`（1..100，页面给 100）+ `items.slice(0, limit)`（`ledger.ts:1518/1519/1567`）；Client `RECENT_ROWS_LIMIT = 5`（`TeamInboxPage.tsx:39/107`，只作用于 `recent`）。可行动队列两头都不能吃。
- Human 的 Inbox 请求**恒为单 workspace**，跨 workspace 合并在 Client（`TeamInboxPage.refresh()` 的 `Promise.all` + `flatMap`）。

## 不在本次范围

- Thread 页过滤器（全部 / 需要我 / 我参与的）。
- 「唤醒合流」（同成员同 Thread 窗口内多条事实合成一次唤醒，Host 侧，另立工作项）。
- Inbox 的其它队列重构：见并行工作项 `active/state-requests-diagnostics/`。

## 第二轮：按 Human 21:34 三条反馈收敛（2026-10-09 21:54，门禁全绿）

分支 `preview/hover-quote`（worktree `/home/yu/projects/dsh-agent-team-pr42`），四道门禁：`tsc -p packages/client-agent-team` 0、client 271 passed、`audit-ui-parity` 0、`test:browser` 6/6、`check:docs` OK。**未 commit、未 push。**

**1. Channel 静默（语境隔离）**：整套 hover 语言 CSS 收进 `[data-team-thread]` 作用域；`TeamMessage` 新增 `showGroupedTime`（只有 Thread 传 ⇒ Channel 不渲染 `data-gutter-time`）与 `cardOpen`/`onToggleCard`（开合状态上提到页面：Thread 持单值 `openCard` + 稳定 `handleToggleCard`，换 Thread 时重置；Channel 两个都不传 ⇒ 结构上不可能开卡）。**更正一处误判**：Channel 上从来没渲染过卡（卡只在 `onReply` 存在时渲染，Channel 不传），漏出去的是行层填充与座位时间。journey 断言：`[data-team-channel]` 里 `data-side` 0、卡 0、座位时间 0、hover 后行背景 transparent。

**2. 回归一列**：`data-side` 从 `messageRow` 与 `TeamRunDivider`（含 `side` prop）整体删除——**master 本来就没有 `data-side`**（`git show master:packages/client-agent-team/src/client/TeamMessage.tsx` 无此属性），镜像规则是 PR 引入的；删掉 `conversation.module.css` 里 5 条 `[data-side=…]` 规则。journey 断言：Channel 与 Thread 的所有行共享同一个文本列 x（`columns.length === 1`），1440 与 390 都过。

**3. 浮卡 = shipped 控件逐档几何（把「像不像验收按钮」变成可量的事实）**：

| 项 | 值 | 依据 |
| --- | --- | --- |
| 卡高 / 圆角 | 36px / `--dsw-radius-md`(12px) | `packages/client/ui-primitives/src/Button.module.css:9`：36px 高 + `border-radius: var(--dsw-radius-md)`（= 验收按钮本身） |
| 卡内动作 | 28px / `--dsw-radius-sm`(8px) | 同文件 `:33` 的 small 档 |
| 阴影 | `--dsw-shadow-lv2` | `ui-theme/src/styles/gradient-shadow-text.css:7`：`0 4px 12px rgba(0,0,0,.02), 0 2px 8px rgba(0,0,0,.04)`（本身就是两层渐变） |
| 出现 | `opacity 160ms ease-out` | 原 80ms 生硬；padding 4px 且**不加描边**（0.5px 描边会把总高顶到 38px） |

结论：**「8 还是 12」的答案是 12px**（36px 那档才是验收按钮），8px 属 28px 小按钮；卡做成 36px 高后与验收按钮同高同档。

**我自己拍的三处**（Human 21:47「@Iris 你自己把握吧」授权）：① 行层保留极轻填充（他 20:32 的 Raft 参考就是「整行浅填充 + 右侧浮卡」；全宽行加阴影无边缘可依附）② 时间留在头像座位（分组续条**没有身份行**，时间只能在座位；`flex: 0 0 28px` + nowrap，11px「21:23」≈29px 溢出 1px 进行内 10px 间距，不裁切不推文本列）③ 引用行保持 muted 12px + 2px 左条。**不采纳 Reeve 的「砍行层」「时间移到昵称右侧」**；采纳他指出的 Channel 误伤与过渡生硬。已知取舍：卡浮在行右上会盖住长首行尾部（参考图同样如此，只在 hover 时）。

**journey 手法补充**：`article` 文本过滤会命中引用它的消息 ⇒ 原文行要 `.first()`；`getComputedStyle(x).height` 是字符串 ⇒ `Math.round(Number.parseFloat(...))`；Channel 断言必须插在 journey 的 Channel 段落内（`[data-team-channel] article` 存在那段），插到 Thread 段会超时。

## 第三轮：Human 21:58 两处（直角 + 假「提到了你」，2026-10-09 22:1x，门禁全绿）

1. **行层填充的直角**：hover/引用目标/flash 的行层补上 shipped 的全宽行 hover 档半径 `--dsw-radius-md`（判例：`ui-conversation/src/client/settings/EnterBehaviorRow.module.css:41` `.selector` 行 hover 用 `--dsw-radius-md` + 同一 alias 背景）。journey 断言从 `rowRadius '0px'` 改为 `'12px'`。
2. **「提到了你」假阳性（真 bug）**：卡片 chip 原来读 `fact.mentions`——那是 **Host 的投递集**，Task Thread 每行都送达 Human ⇒ 没点名的行也挂 chip。改为 `bodyMentionsHuman(body, mentionNames)`（`team-formatters.ts`）：用正文 chips 的同一把 `scanBodyHandles`（跳过代码段）判「正文有没有真的写 `@human`/别名」。顺带把 `mentionsHuman` prop 从 `TeamMessage` 撤掉（`data-mentions-me` 也改由正文判），`TeamChannelPage` 的投递态标记删除。
3. **连带行为修正**：`TeamThreadPage.firstUnreadMention`（打开 Thread 落点）原来也用投递集 ⇒ 任何未读行都算「点了你」；改用同一把正文扫描——**只有正文真的点名才跳转**，否则开在最新处（journey 的 8 条不点名续条正好守这个）。
4. 新单测：点名行出 chip；「交付但未点名」不出 chip；`@human` 别名认、代码段里的 `@human` 不认。client 271 / tool render 14 / audit 0 / docs 0 / journey 6（最终轮）。

## 第四轮：Human 22:01（时间位置 + 「全局圆角/头像不对齐」，2026-10-09 22:2x）

1. **时间不挤在左边**：座位时间整个撤掉（`.gutterTime` 删除，头像座位回到纯座位）；未分组行的时间就在身份行（「消息上面一行」✓），分组行的时间**上浮到动作卡**（`data-card-time`，12px tertiary，与「提到了你」同一行），随卡一起 reveal。
2. **「全局圆角样式」没动**：`git diff master` 里我改的只有 `conversation.module.css` 一个文件；全部三处 radius 都是 Thread 作用域内的新规则（行层 `--dsw-radius-md`、卡 `--dsw-radius-md`、卡内动作 `--dsw-radius-sm`），shipped 的 token 定义与全局样式零改动——他看到的「乱」来自下面第 3 条。
3. **头像与消息不对齐的真因**：`.messageIdentity`/`.messageIdentityImage` 上残留 bubble 时代的 `margin-top: 22px`（给气泡首行让位的偏移），一列布局下头像整体沉到昵称下方 22px ⇒ 已删，头像回到与身份行同一顶线（`align-items: flex-start`）。
4. 门禁：271 / audit 0 / docs 0 / journey 6（rowRadius 12px、卡时间、Channel 静默、一列、跳转居中）。

## 第五轮：Human 22:28（圆角第三次被点，这次是我错；时间与遮挡，2026-10-09 22:44）

**根因（我连错两轮的判断）**：验收 button 是 `<Button size="sm" variant="primary">`（`TeamThreadPage.tsx:916`），shipped 定义 `'sm' 28px control with 8px corners`（`ui-primitives/src/Button.tsx:22`，`Button.module.css:28-34`）。**验收档 = 28px/`--dsw-radius-sm`(8px)**。我前两轮按 `Button.module.css:9` 的**默认档**（36px/12px）推断，没有去看本方调用点传了 `size="sm"` ⇒ 连续两次答错「8 还是 12」。**教训：判「跟 shipped 哪个档」必须看本方调用点实参 + shipped 该档定义，不能只看基类默认值。**

1. **卡片 = 验收同档**：`height: 28px` + `border-radius: var(--dsw-radius-sm)`（`padding`/`gap` 去掉，动作按钮铺满卡高）。journey 改为**同一次渲染里现场量验收按钮**，卡的高与圆角必须与它**相等**——把「像不像」变成上游一变就红的等式。
2. **时间回座位**：分组行的时间用 `position: absolute; left: 0; top: 0; width: 28px; text-align: center` 落在 avatar 那一列（座位上），**不占右侧文本、也不推文本列**（绝对定位 ⇒ 不参与 flex 宽度）。
3. **卡片上偏半格**：`top: -14px`（28px 卡的一半压在行内）。副作用：首行卡片会被 timeline 的 12px 顶 padding 裁 2px ⇒ `[data-team-thread] .timelineContent > .messageRow:first-child { margin-top: 2px }` 补回。journey 断言 `cardPlacement.topInRow === -14`。

门禁：271 / audit 0 / docs 0 / journey 6。**教训（写给下一个改这块的人）**：`cardPlacement` 里 `gapToBodyEdge`（卡右缘贴文本列右缘）与 `topInRow` 是两个独立约束，改 `top` 不会动右缘。

## 第六轮：Human 23:03（三点；2026-10-10 13:41 完成）

1. **卡片再上移——固定数值治不了续行**：hover 的那行是 `[data-grouped]`，**没有身份行**，`padding-top: 2px` ⇒ 内容从 +2px 起，普通行是 +10px。上轮 `top: -20px` 实测仍在蹭字（卡下沿 y=767 vs 文字 y=765）。终态：`--team-card-rise` 按行型给（普通 20px / 续行 28px），不变量 = **下沿停在本行内容上沿再高 2px**。e2e 改守 `body.top - card.bottom === 2` 而非裸 `top` 数值——裸数值看不出「有没有压字」。
2. **点击后行层不散**：根因 `:focus-within`（按下的按钮持有焦点 ⇒ 行一直亮到点别处）。改 `:has(:focus-visible)`；触摸保留 `[data-card-open]`。e2e 真点复制再移开指针，断言底色透明 + 卡/时间归零。
3. **引用样式重做（不用 PR #42 那套）**：banner 与消息内引用行统一为「2px 静音竖线（`--dsw-alias-label-caption`，opacity .5，复用 shipped Markdown 块引用）+ 12px 安静文字」；**无填充/面板/蓝条/上方标签**。「会送达 {name}」改为同 行末尾补充说明；取消按钮收成 20px 静音小叉。

**环境坑（本轮最大的绕路）**：`../deepseek-harness` 升到 0.2.0-rc.2，`readContextTimeline.measureSource` 契约改返 `SurfaceMeasurement` ⇒ `generate-typert` 抛错、build 全断。**修复在共享 checkout 的本地 master**（`575b7a9d` + `43a5ce30`，origin/master 还在 `^0.3.0` 没有），做法是 `cherry-pick` 这两笔到自己分支（`37b05794` 纯测试且基座无该文件 ⇒ 跳过），再 `node scripts/sync-paths.mjs` + 重跑 `generate:typert`。**教训：动手前 `git merge-base --is-ancestor` 判旧基座在不在 master 上**；这轮先试 origin/master、再试 merge origin/pr-42（4 处真冲突）都白走。

门禁：tsc 0 / 271 / audit 0 / journey 6。预览 `http://127.0.0.1:45207/?token=jVP053pbovBDl78jKz7aGa8K0sMX5_dhk4pYAknBcIE`。分支 `preview/hover-quote`（worktree `dsh-agent-team-pr42`）已 commit 未 push。待办：Human 看完设计 → 补 `docs/frontend-design/thread-and-composer.md` + CHANGELOG 文档对 → 收尾提交。

## 第七轮：在 master 上重做（Human 2026-10-10 14:54 定方向，17:54 放行）

**Human 的决定**：「处理 pr：我们重新在当前 master 去做，但是后面要把 pr 贡献带过来」；随后授权我也可以做非 UI 部分（Host／工具层）。他要求把本轮讨论都收进本工作项。

### 为什么是 Host 先行（硬约束，不是偏好）

master 上引用**根本跑不起来**：`AgentTeamMessage` 无 `replyToMessageRef`、无 `resolveMessageRefs`／`readMessage`、无 `AgentTeamReplySettings`，client 侧 `git grep master -- onReply/copyMessage/replyTo/replyCapabilities` 全 0。先做 UI 会有一段「样式写完但点不动」的半成品期。

反过来可行：`git merge-tree --write-tree master ca2dcf28` 显示整个 PR 对 master 只有 **2 处冲突**（`CHANGELOG.md`、`client/index.ts`），**都不是 Host 文件**；`agent-team/{index,ledger,spec,types/entities,types/requests-results}` + `tool-agent-team/index.ts` 全自动合并。

### 已落（均以 PR 作者 纪章鹏 <1208235155@qq.com> 署名，保留贡献归属）

| commit | 内容 |
| --- | --- |
| `2a0ff2f6` | Host 侧 + 工具侧全量：durable `replyToMessageRef`（`spec.ts` 的 `messageSchema`，注释说明「写路径存了而 schema 未命名 ⇒ 整个域重开即死，必须同笔加」）、`resolveMessageRefs`／`readMessage`／`replySettings` 三个 Remote、`team_thread` 的 `message` action、`reply` 的 `replyToMessageRef` 参数与「引用即送达」、读时投影 `replyTo`（刻意放在 `AgentTeamStoredThreadFact` 之外） |
| `d69b6fa1` | client 管道：`reply-capabilities.ts`（新增）、`refs.ts` 的 `ResolvedMessageRef`／`hostMessageRefLookup`、`slots.ts`、`team-formatters.ts` 的 `HUMAN_MEMBER_ID`／`mentionsHuman` |

**我补的三处**（PR 自带缺口，改动属我）：① `packages/agent-team/tests/typert-generation.spec.ts` 是**显式枚举**的边界清单，加 Remote 必须同步加 `readMessage`／`resolveMessageRefs`／`replySettings`，否则该 spec 红 ② 修了补丁引入的一处 JSDoc 破损（`HUMAN_HISTORIC_HANDLE` 注释被挤成畸形块）③ `mentionsHuman` 注释里的 "bubble" 改为 "Message"（气泡方向已否决，注释不该留旧词）。

**门禁**：typecheck 0、全量 **1026 passed**（rebase 到 `7167bf9a` 之后）。

### 剩下的步骤

1. **`client/index.ts` 手工接线**——PR 那笔在 master 上 apply 不进去：master 的 `registerModeShadow` 多了一个 `queries` 参数，签名对不上（`merge-tree` 早报它是两个冲突文件之一）。要接：`TeamReplyCapabilities`／`AgentTeamResolveMessageRefsRequest` 的 import、`registerModeShadow` 加参透传、`teamSharedRemotes`／`main` 分支加 `resolveMessageRefs`、`applyUi` 里 `new TeamReplyCapabilities(() => ctx.remote.agentTeam.replySettings())`、三处调用补参、settings inject。master 侧锚点：`registerModeShadow` `:297`、`teamSharedRemotes` `:212`、`humanIdentity` `:356`、三处调用 `:456-458`、`resolveThreadRefs` `:288`。
2. ~~补 PR 漏掉的缺口：`team_thread read` 的 fact 视图没有 `replyTo`~~ —— **核销：我自己报错了**。实测 `read`（`:434`）／`history`（`:407`）／anchor（`:482`）三处**都带**这两个字段，工具侧无缺口、无需改动。详见 `spec.md` 第 5 节。
3. **穿 memberId**：`TeamComposer` 的 `replyTo` 现只有 `{senderName, excerpt}`，**无 memberId** ⇒ 要把 `AgentTeamResolvedMessageRef.sender` 穿到 composer，才能把被引作者并进「将通知」行并删掉 `quoteDeliversTo`。
4. **视觉层自己写** + 把前六轮已验成果移植过来 + 工具描述加判据（见 `spec.md`）。

### 恢复时必做（跨等待期）

1. **`git merge-base --is-ancestor <锚点> master`** 判锚点还在不在。**不在** ⇒ 基座被折过，不能硬 rebase，要换锚点重来（#21 之后踩过：旧基座 `49e5721d` 被折，白走两轮）。
2. 在则 `git rebase --onto master <旧锚点> preview/quote-on-master`（本轮实测：master 前进 7 笔、4 个文件重叠，rebase **零冲突**通过）。

## 收尾（2026-10-10 归档）

**成果去向**

| 去向 | 内容 |
| --- | --- |
| 正式文档 | `docs/frontend-design/thread-and-composer.md`、`components.md`、`layout-and-typography.md`、`principles-and-language.md`（各自双语对）、`CHANGELOG.md` 的 Unreleased 段 |
| 代码 | `packages/client-agent-team/src/client/`：`TeamMessage.tsx`、`TeamThreadPage.tsx`、`TeamChannelPage.tsx`、`TeamRunDivider.tsx`、`TeamComposer.tsx`、`conversation.module.css`、`locales.ts` |
| 测试 | `tests/team-mode-conversation.client.spec.tsx`、`tests/team-message.client.spec.tsx`、`scripts/team-ui.e2e.ts`（journey 6/6） |
| 未决 | Human 尚未给出 push 与验收结论 |

**读归档时注意：有两处已被后续改动推翻，上文对应段落保留的是当时的状态**

1. **回合分隔线曾把时刻写在线上**（「线下首行标注后一条消息的时间」）。最终裁决相反：「时刻由行自己说」——有身份行的写在名字旁，续行在头像座 hover/焦点时出现；**分隔线不再带任何时刻**，且只有 Channel feed 画它，Thread 页一条 run 级线都不画（`fix:` 那笔）。跨天日期锚与未读线仍在两页保留。
2. **hover 卡的表面**曾用 `--dsw-shadow-lv2`/`-lv1`。最终按仓库自己的「卡片表面」配方：`--dsw-elevation-stroke-color` 取 composer 卡同档的 l2 描边 + `--dsw-elevation-panel`（最轻一档 elevation）——原因见 `docs/frontend-design/principles-and-language.md` 的 Card surface 行：**柔光几乎不可见，由描边承担分离**，卡片浮在白色代码块与截图上时靠填充分不开。
