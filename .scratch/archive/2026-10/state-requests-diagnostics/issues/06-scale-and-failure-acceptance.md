# 06 — 规模与故障整体验收

**What to build:** 操作者在持续协作、较大历史和故障恢复场景下可以正常管理团队、读取当前信息，并能由记录解释失败；交付结论包含实际性能证据和未解决限制。
**Blocked by:** 02 — 成员执行隔离；04 — 有界投影；05 — 通知与恢复追踪
**Status:** complete

- [x] 建立可复跑的场景矩阵：持续运行的多个 Member、多 Workspace、长 Thread、大量历史与少量活跃任务、积压未读、断线重连和 Host 重启。
- [x] 对关键用户操作记录端到端等待、查询数、返回字节、投影扫描与校验成本；与初始审查输入对照，不以合成内存数据冒充生产负载。
- [x] 测量提交后全量账本校验对响应与同进程任务的影响，再决定是否调整；保留独立校验能力，不凭文件长度或理论增长直接引入快照、worker 或存储迁移。
- [x] 检查原先出现的 Harness WeakMap 错误，查明原因并修复相关夹具或实现；测试退出码为零但页面仍报错不计为验收通过。
- [x] 运行受影响的 Host、工具、Client 检查及真实浏览器流程；检查桌面与 390×844、键盘焦点、加载/错误/空状态和普通 DSH 恢复。
- [x] 需要操作者预览时使用 dev profile，不改变默认稳定 profile；真实数据或生产环境操作另行明确范围。
- [x] 为每个发现给出已解决、保留且有理由、或明确后续处理的结论；涉及容量或响应预算的取舍用实际数据说明。
- [x] 正式文档和 package README 已反映最终行为；清理未采用方案与临时过程材料，只保留有复查价值且符合仓库规则的验收结论，然后关闭工作项。

## 完成记录（2026-10-09，提交 `12e83f13`，树 `85d9072f5b5a670f4d9cc63c6494fc87e34ff662`）

### 装置（判据 2 的「不许合成内存冒充生产负载」）

`.scratch/local/state-requests-diagnostics/2026-10-09/aster-host-scale-acceptance.mjs`（gitignored，按 `.scratch/AGENTS.md` 不随工作项提交；读数 `aster-host-scale-acceptance.json`）。真实 sqlite 文件与真实语句（生产同款域路由 `packages/agent-team/src/vendor/storage-sqlite`）、真实 Host 插件 `AgentTeam` 的提交路径与投影、真实 invariant companion、真实历史体量与并发提交。**不真实、必须随读数一起读的部分**：成员会话是桩（`agents.create` 抛错）⇒ 不起 LLM／Remote／UI，因此它答 Host 侧端到端，浏览器等待由判据 5 的真实车道答；成员侧读路径（`viewForAgent`）未挂活体 Agent，量的是同一投影的 Human 面与 `includeCatalog` 目录面（`team_view` 用的正是后者）；成员**写**路径只在播种期按账本语义出现。

规模样本：2 Workspace、6 Member、1000 Task（24 留 in_progress 且各一条 Claim）、40 条积压未读 taskless Thread、一条长 Thread 补到 20,000 笔操作（17,950 条回复）；介质 29.3 MB，播种 392.8 s（50.9 ops/s）。环境开关 `SCALE_OPS`／`SCALE_TASKS`／`SCALE_ACTIVE`／`SCALE_MEMBERS`／`SCALE_BACKLOG`／`SCALE_OUT` 可缩放复跑（2,049 笔的冒烟约 50 s）。

与 Vera 的 `vera-real-storage-cost.mjs` 分工（她 `703aa9b3` 的口径）：她那支量账本直连介质的分量记账，本装置量 Host 端到端；两支不互相冒充，读数并列出现在判据 2／3。她的装置把 `changeTask` 的 `status` 当参数用（该 API 要的是 `action: 'close'`），写出的记录在真实 Host 挂载时会被域规格解析拒绝——她的耗时读数不受影响，但那支介质本身不可用于 Host 启动路径；本装置用 `action: 'close'`（见发现 4）。

### 判据 1（场景矩阵，可复跑）

| 票面要求 | 装置里的样子 | 读数 |
| --- | --- | --- |
| 持续运行的多个 Member | 6 Member（2 Workspace × 3），2 个 Workspace 上 8 轮 × 2 频道 × 3 笔并发提交 | 48 笔在 735.5 ms 内全部返回（65.3 commits/s） |
| 多 Workspace | 2 个 Workspace、各 1 频道、各 3 Member | 每个 Workspace 各 500 Task／12 活跃；跨 Workspace 读取按 scope 定界 |
| 长 Thread | 长 Thread 17,950 条回复（账本 20,000 笔里的绝大多数） | `threadHistory(limit 50)` 0.29 ms／24,019 B（cursor 19951）；定向读 0.25 ms |
| 大量历史＋少量活跃任务 | 1000 Task，其中 24 条 in_progress 且各带一条 Claim | 目录 500 Task＋520 Thread；in-flight 雷达 12 行 |
| 积压未读 | 40 条 taskless Thread 由成员发起、Human 未读 | 被测读者 Inbox 11 条未读：`limit 1` → 1 行＋`hasMore: true`（6.07 ms）；`limit 100` → 11 行、`hasMore: false` |
| 断线重连 | 真实浏览器车道 `setOffline(true)` → 频道体与侧栏各自进入错误态（居中／告警色，且「失败不读成空 Workspace」）→ `setOffline(false)` → 两处无需手动重试自行恢复；另 4 处 `page.reload()` 验证 boot restore 落在持久路由 | `npm run test:browser` 6/6 |
| Host 重启 | 两次真实重启：20,000 笔后、20,108 笔后 | boot 681.6 ms（1 次 `entries()` 读 20,000 行）／645.1 ms；重启后首读 0.17 ms |

### 判据 2（关键操作读数与初始审查输入对照）

真实介质、真实 Host，20,000 笔／29.3 MB 规模；每次读数取 15 次中位（`msMax` 在 JSON 里）：

| 读操作 | 中位 | 返回字节 | 介质读取行数 |
| --- | --- | --- | --- |
| `view:channelPage(topLevel,limit 20)` | 2.19 ms | 11,991 B | 0 |
| `view:page(limit 20，含 activities)` | 0.13 ms | 19,506 B | 0 |
| `view:addressBook(catalog,limit 1)` | 0.47 ms | 218,848 B | 0 |
| `view:channelPage(catalog,limit 20)` | 0.54 ms | 235,050 B | 0 |
| `view:directed(长 Thread)` | 0.25 ms | 2,540 B | 0 |
| `inbox:badge(limit 1)` | 6.07 ms | 7,941 B | 0 |
| `inbox:page(limit 100)` | 6.12 ms | 16,760 B | 0 |
| `threadHistory(长 Thread,limit 50)` | 0.29 ms | 24,019 B | 0 |
| `threadObservations(sparse,limit 50)` | 0.03 ms | 218 B | 0 |
| `readThread(长 Thread)`（提交） | 10.6 ms | 1,284 B | 0 |
| `readThread(sparse)`（提交） | 0.05 ms | 858 B | 0 |

- **查询数／投影扫描**：11 次读取里介质读取行数全为 0、`table().entries()` 调用 0 次——读走内存投影，不回介质；两次 `readThread` 是普通提交（含一次真实落盘），不是读。
- **与初始审查输入对照**（100／1000 活跃 Task、内存表）：目录字节 103,918／1,033,222 B 的那一次读取，现在由 `includeCatalog` 契约决定范围——`team_view` 仍取整个 scope 的目录，其余调用方只取当页（票 04 的 `view:catalog(limit 1)` 1,046,866 → 2,446 B）；按 Task 取 Claim 的元素检查从 10,100／1,001,000 降到桶长（票 04）；线程定向读取的「匹配不足即稳态全账走查」已消除，`limit 1` 的定向读 0.25 ms（走 `factsByThread` 索引）。
- **最重的一次读是 Inbox 本身**：`limit 1` 与 `limit 100` 同为 ~6 ms，因为排序与全队列合计仍遍历全部未读候选（票 04 记的口径：预览文本、署名与 Claim owner 只为返回的行物化）。11 条未读下 6 ms 可接受；这一项的复查条件是未读候选量级变化（若单读者积压到千级，先看这里的遍历，而不是先加缓存）。
- **地址簿（`team_view`）的完整链条**：Host 投影 0.47 ms／218,848 B（500 Task＋520 Thread＋12 Claim＋12 雷达行；`limit` 只定 items，目录描述整个请求 scope）；工具侧把 `view.tasks` 逐条去 `view.threads` 找 revision（`packages/tool-agent-team/src/index.ts`，O(Task × 目录 Thread)）在真实目录规模（500×520）上中位 **3.03 ms**、tasks 规范值 104,061 B（同形冒烟介质：1000 Task／2,049 笔历史，JSON `aster-addressbook-map.json`）。**模型看不到这个目录**：Harness 契约里规范值是 execution-local（不落盘、不进 prompt、无字节上限，`../deepseek-harness/docs/cookbook/adding-a-tool.md`），模型可见的是 render 文本——频道、20 行 Thread 页、成员、in-flight 雷达，行数由 `limit` 与活跃数决定。
- **单机毫秒只作次级信号**（判据 7）：本票没有承诺任何 SLA，读数用于回答「量级与增长形状」。

### 判据 3（提交后全量校验的影响）与决定

20,000 笔规模，companion 关／开各 20 笔提交＋一次 10 笔连发：

| | 提交中位 | 提交 max | 重放次数 | 重放中位 | 事件循环 max 滞后 |
| --- | --- | --- | --- | --- | --- |
| companion 关 | 21.0 ms | 25.7 ms | 0 | — | 0 |
| companion 开 | 19.0 ms | 29.1 ms | 20 | 191.0 ms（max 228.5 ms） | 358 ms（mean 218.6） |

- **提交响应不为校验买单**：19.0 ms（开）对 21.0 ms（关），差异在噪声内；校验跑在提交之后、不阻断响应。
- **合并有效**：10 笔连发在 167 ms 内全部返回，只触发**一次**重放（190.8 ms，重放行数 20,060＝一次整表），不是 10 次。
- **量级**：显式 `validateLedger()` 186.6 ms／20,000 行；重启后重放 198.7 ms；挂载 companion 的一次挂载校验 180.4 ms。两笔小规模点用于看形状：2,049 笔时显式校验 42.8 ms、2,158 笔时重放 34.4 ms（≈线性，含固定成本）。
- **决定：保留**（不加快照、不加 worker、不做存储迁移）。理由：这笔成本不在这笔提交的响应里，同一批提交只重放一次，重放与显式校验同量级（≈0.2 s @ 20k 笔），且独立校验能力（显式 `validateLedger()` ＋ companion）是当前唯一能发现「记录合法但投影不可重放」的手段，不能为了省一次 ~0.2 s 的停滞换掉它。
- **记录边界（复查阈值，不是待办）**：停滞随持久化操作量线性增长——≈0.2 s @ 20k 笔、≈2 s @ 200k 笔。若某个部署的账本操作量接近 20 万，先用同一装置复测再决定是否分段校验或快照；现在不预置任何机制。

### 判据 4（Harness WeakMap 错误：根因、修复、护栏）

- **根因**：`packages/client-agent-team/tests/harness.tsx` 的 `conversation` 桩停留在旧版形状，缺 `fileUploads`，而随包发布的 composer bar 把它当可观察对象注入 ⇒ `observableHook` 里 `hookCache.set(source, hook)` 收到 `undefined`，在 slot entry 内抛 `Invalid value used as weak map key`，被 `SlotErrorBoundary` 吞成 `console.error`。**退出码仍为 0**：修复前该用例文件 34 项全绿，同时控制台有 51 条 WeakMap 报错、17 条 `slot entry crashed in 'conversation.composer.bar'`。按 `61fcf478` 的口径补夹具、不为它改产品代码。
- **修复**：把桩补齐到已发布控制器的完整面（`fileUploads` 快照存储、`createDrafts`、`resolveDraftAttachments`、`retryFileUpload`、`releaseDraftAttachment(s)`、`rebindDraftFiles`）。补齐后 WeakMap 报错归零，但重新开的护栏立刻抓出**第二个同性质崩溃**：jsdom 30 无 `document.fonts`，`control-row-layout.ts` 读 `addEventListener` 抛 `TypeError`（42 条 slot 崩溃、4 个文件失败）⇒ 补 jsdom 假 `document.fonts`。
- **护栏**（`04096133`）：客户端 bench 现在会让**任何渲染出的随包 slot entry 崩溃过的文件失败**，所以「测试绿但页面报错」这条路被堵住；文档记在 `docs/development/start-and-checks.md`。
- **结果**：客户端套装 29 个文件 278 项全绿、0 条 WeakMap 报错、0 条 slot 崩溃；`npm test` 全绿（见闸门）。

### 判据 5（受影响的检查与真实浏览器流程）

- 定向检查：Host／工具／Client 三层都跑在改动面上——`npm run typecheck`（3 个 tsconfig）、`npm test`、`npm run lint`、`npm run build`、`npm run test:browser`、`npm run check:docs`，读数在闸门节。
- 真实浏览器流程（`scripts/team-ui.e2e.ts` 经 `scripts/run-browser-test.mjs` 写进相邻 Harness 检出后用临时 profile 跑）：6/6 通过、退出码 0、70.4 s。覆盖桌面 1440×960 与 390×844 两档（模板里 27＋22 处视口设定，含窄屏 `scrollWidth ≤ 390`）、键盘可达（`:focus-visible` 焦点环、Enter／Escape／Space）、加载／错误／空状态（`还没有消息` 空态；断网后频道体错误态居中、侧栏告警色，且失败不读成空 Workspace）、普通 DSH 恢复（离开 Team 回到 `对话` 后仍是普通会话与普通 composer）。
- **边界（如实记）**：`c15c4a33` 的「补充读取失败→入口仍在→按下即重试」是在组件层用例里覆盖的（jsdom ＋ 真实随包 slot entry），真实浏览器车道没有历史读失败的注入点，因此车道验的是这一步之后的页面仍完整、以及断线／恢复与 boot restore；车道里 4 处 `page.reload()` 覆盖 boot restore。票 03 交办的两句（角标失败面无视觉呈现、`还没有频道`／`还没有 Agent` 计数为 0 作真浏览器层覆盖）已补进票 03 的完成记录。

### 判据 6（dev profile）

本轮没有需要操作者预览的改动：三条修复都是行为／文案级，且已由组件用例与真实车道覆盖 ⇒ 未要求预览操作。浏览器车道用 `mkdtemp` 临时 profile（`scripts/run-browser-test.mjs`），默认稳定 profile 未被触碰；没有真实数据或生产环境操作。

### 判据 7（每个发现的结论）

| # | 发现 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | Inbox 是有界队列却无完整性信号（Vera `536e9f6f`）：`items` 默认 50、硬上限 100，超过即静默截断，工具文案还承诺「用更大的 limit 再调」——100 之后是空的 | **已解决**（`d4289ffb`）：`hasMore` 进契约与工具输出、`items`／`limit` 注释改写、客户端在截断时给出脚注、工具文案改为「读这些 Thread 以清空队列」 | 读数：`limit 1` → `hasMore: true`；`limit 100` → 11 行、`hasMore: false`；Host／工具／客户端用例 |
| 2 | 不加游标分页 | **保留且有理由**：Inbox 是待清空队列，读 Thread 就会把它从队列里排掉（读数里 `readThread` 之后 `hasMore` 转 false），没有跨提交稳定的排序键可做游标；`limit`＋`hasMore`＋脚注已让截断可见且可继续 | 同上 |
| 3 | Thread 页首屏补充读取失败被静默吞掉（Vera `4c48faf1`）：`Promise.all` ＋ `.catch(() => undefined)` 让 `historyHasMore=false`，「加载更早消息」不再出现，而 `loadOlder` 自己的守卫又堵死手动重试 | **已解决**（`c15c4a33`）：失败不再折掉入口——入口成为重试，它自己的失败照常显式报错；主读取（`readThread`）仍决定页面 ⇒ 保留「补充读取非致命」这一取舍 | 组件用例（失败 → 入口仍在 → 按下重试成功）；读数里长 Thread 首屏 0.29 ms，失败路径不改变主流程 |
| 4 | `activeTaskThreads` 契约注释与实现不符 | **已解决**（`12e83f13`）：注释改为按 scope 描述（in-flight 雷达是整个请求 scope 的，不只当页） | 注释与 `view()` 实现；`includeCatalog` 行的读数（12 雷达行 vs 当页 1 行） |
| 5 | 账本的 `validate()` 与域规格解析检查面不同（本装置用 `changeTask({ status })`——该 API 要 `action: 'close'`——写出的记录 `kind` 为 `undefined`，账本侧通过、真实 Host 挂载时被 zod 解析拒绝） | **保留且有理由**，后续另计：账本校验查语义（引用、顺序、投影可重放），域规格解析查记录模式，是启动路径上更强的闸门；该 API 只由类型化调用方使用（TS 参数类型与 Remote 校验挡住这类误用），不为一个越界调用放宽或加倍校验。若将来要「记录与域规格同源自检」，那是另一件工作 | 装置实测：同一介质账本可读、Host boot 在该记录上失败；本装置改用 `action: 'close'` 后 20,000 笔全程可重启 |
| 6 | 提交后全量校验带来同进程停滞 | **保留且有理由**：见判据 3 的读数、决定与 20 万笔复查阈值 | 判据 3 |
| 7 | address book 目录 ∝ 请求 scope，工具侧 O(Task × 目录 Thread) | **保留且有理由**，复查阈值明确：目录范围是 `team_view` 的契约（address book 要描述整个 scope 的 in-flight 与 Task/Thread 索引），规范值 execution-local、不进 prompt，模型可见文本仍由 `limit` 与活跃数决定；复查条件是单 Workspace 的 Task 目录到千级（那时工具侧映射约 10⁷ 次比较、规范值约 MB 级），届时先给该映射加 `threadRef`→revision 的 Map，不动契约 | 判据 2 的读数（0.47 ms／218,848 B／3.03 ms） |
| 8 | Inbox 角标失败面无视觉呈现（票 03 遗留） | **明确后续**：首读即失败时与「无未读」视觉相同，失败只在按查询诊断里可查；本票不改 UI（角标是常驻 chrome，为一个无失败态入口加视觉会改变 rail 语义），句子补进票 03 记录 | 票 03 的读数与浏览器车道（`还没有频道`／`还没有 Agent` 计数为 0 作为真浏览器层覆盖） |

### 判据 8（文档、README 与清理）

- 正式文档（中英成对，`npm run check:docs` 绿、未抬任何块上限）：[attention-and-messaging](../../../../../docs/team-collaboration/attention-and-messaging.md)（Inbox 有界队列＋`hasMore` 的口径）、[sidebar-browser](../../../../../docs/frontend-design/sidebar-browser.md)（Inbox 截断脚注）、[thread-and-composer](../../../../../docs/frontend-design/thread-and-composer.md)（补充读取失败后入口仍在）、[start-and-checks](../../../../../docs/development/start-and-checks.md)（客户端 bench 的新护栏）、`CHANGELOG.md` 两条 `[Unreleased]`。
- package README 逐条核过（**未改，因为没有需要改的断言**）：`packages/tool-agent-team/README.md` 那句「截断结论」此前是用未读条数之和推断的（Thread 数与条数混用），现在由 `hasMore` 真正兑现；`packages/agent-team/README.md` 不提 Inbox 有界性，`packages/client-agent-team/README.md` 的 Thread 段不描述补充读取失败语义——有界性与失败语义各有正式文档的家，不在这里重复第二份权威。
- 过程材料：装置、JSON、日志留在 gitignored `.scratch/local/state-requests-diagnostics/2026-10-09/`（按 `.scratch/AGENTS.md` 不入 active/archive）；未采用方案（Inbox 游标、提交后校验的快照／worker／存储迁移、为 WeakMap 改产品代码、地址簿分页）只在票面记录里写明不采用的理由。
- 关闭工作项：本票完成后把 `active/state-requests-diagnostics/ → archive/2026-10/`（另一笔，只碰 `.scratch/`）。

### 闸门（树 `85d9072f5b5a670f4d9cc63c6494fc87e34ff662`，即 `12e83f13` 的树；本记录笔只碰 `.scratch/`，`git diff 12e83f13 HEAD -- packages/ docs/` 为零 ⇒ 读数随树转移、不重跑）

`npm run typecheck` ✓（3 个 tsconfig，Typert 产物无漂移）；`npm test` 1015 通过 / 1 跳过（1016）；`npm run lint` ✓ 0 error、3 条既有 warning；`npm run build` ✓；`npm run test:browser` 6/6（退出码 0，70.4 s）；`npm run check:docs` ✓（28 文档、28 对、34 大纲，块上限未抬）。

落地顺序（全部本地未推）：`04096133` 闸门与桩修复 → `d4289ffb` 发现 1 → `c15c4a33` 发现 3 → `12e83f13` 发现 4；票 06 的装置与读数不随提交（gitignored），因此没有额外的实现笔。
