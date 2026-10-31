# 启动与加载性能研究（研究线 1）

**检查日期：** 2026-10-28\
**仓库版本：** 检查从 `dsh-agent-team` `a91e84a` 开始；并行工作在此期间提交到 `f4c44d4`，最终源码引用已按 `f4c44d4` 复核。相邻 Harness `687f282e86`\
**运行环境：** Node.js `v24.15.0`，npm `11.12.1`\
**证据类型：** 当前源码、当前 `lib/` 产物、实时文件体积；本轮没有运行浏览器验收，也没有生成 Host 启动耗时样本。

检查开始时工作树有 Attention/Inbox 修改，涉及 `packages/agent-team/src/index.ts`、`ledger.ts`、`cordis.patch.yml` 和 Client `slots.ts`；并行工作随后把这些改动提交为 `80a6e0d`、`fde555a`、`f4c44d4`。本轮没有重新 build，因此 `lib/` 体积是仓库现有构建产物，不保证与最终源码 commit 逐字对应。

下文标记：

- **事实：** 已从源码、测试、生成物或实际命令确认。
- **推断：** 由已确认事实推导，仍需计时验证。
- **未测量：** 当前没有可信样本，不能据此判定优化是否有效。

## 结论

本轮没有测到任何用户可感知的毫秒数，所以不能先说“bundle 太大”或“并行激活一定更快”。可以确认的结构性风险有三处：

1. **Host 启动时的 ledger 重放随操作数增长。** 一次启动会完成 JSON 解析、严格 schema 解析、记录排序、三轮投影应用和索引构造；这是最明确的后台启动扩展风险。
2. **Member 激活完全串行。** 所有 enabled Member 依次恢复 Session、绑定 preset、应用工具策略、挂载私有 skill provider、附加 Workspace，最后才发布 handle。Host Loader 会等待整棵插件树稳定，因此会等待这条循环结束。
3. **Team Client 在普通模式也进入全局 Web boot。** 浏览器预取并激活 Team 单入口，`bootClient` 等到所有入口 active 后才继续；Team Remote 的 40 个 descriptor 每次页面启动都要建立索引。UI 数据读取和 changes stream 已按需启动，这部分没有在 boot 时抢先发请求。

另一个重要纠偏：`team-member` preset 的子插件树是共享且只挂载一次，不会按 Member 复制整棵树。每个 Member 仍会重新绑定 generation，并重新审计这棵树、应用工具策略和恢复 Session。

## 优先级

| 优先级 | 主题 | 依据 | 下一步 |
|---|---|---|---|
| P0 | 建立启动基线 | 当前没有 Host/Web 首次可用时间门槛，也没有多 Member 启动样本 | 固定 profile、数据量、浏览器缓存状态，先记录 median/p95 |
| P0 | Ledger 冷启动和提交后全量校验 | 启动至少三轮投影遍历；commit 后 `setImmediate` 全表校验 | 用 1k/10k/100k operation 测量 load、parse、ctor、首个 query、commit 后 CPU |
| P1 | Member 串行激活 | 循环逐 Member `await`，Host boot 等待整棵树 | 对 1/4/8/16 个 fresh 与 persisted Member 测总量、单 Member 分布、峰值内存 |
| P1 | Team Client 进入全局 boot 关键路径 | 应用脚本全量预取，所有入口 active 后才继续；Team 单 bundle 1.04 MiB raw、约 211 KiB gzip level 1 | 测 Network、compile/evaluate、long task、Team rail 首可点击 |
| P1 | Host Typert 与 preset 首次激活 | Host Typert 产物约 516 KiB raw；preset 注册时同步等待共享树加载和审计 | 单独 profile 动态 import、manifest 校验、preset mount/audit |
| P2 | Remote mount | 40 个 descriptor 在 `$mount` 首次访问时统一解析；Zod 实例化和 JSON Schema 投影按需发生 | 先微基准，确认是否真的占 boot 主耗时 |
| P2 | source map 和包体积 | Client map 1.43 MiB，npm 包解包 5.70 MiB、340 文件；正常 boot 不读取 map | 只作为安装和调试网络成本处理 |

## Host 启动链

### Service 与插件树

**事实：** `packages/agent-team/src/index.ts:331-343` 声明了九个依赖：`storageDomain`、`tokenMeter`、`workspaceRegistry`、`agents`、`agentDefaultModel`、`agentPresets`、`tools`、`sessionPersistence`、`sessionProjections`。Cordis 在构造时注册 `agentTeam` 服务（`index.ts:447-448`），但异步 `[Service.init]` 完成前 fiber 不进入稳定 active 状态。

**事实：** Harness `packages/boot/app-boot/src/index.ts:1232-1241` 挂载整棵树后执行 `loader.await()` 和启动审计。Web 的 URL 提示和自动打开又明确等待整棵 Host Loader 稳定，见 `packages/bundle/web-app/cordis.patch.yml:190-198`。

**推断：** Team Host 的任何启动阻塞都会进入整棵 Host 的 ready 临界路径，包括普通 Session 也共用的 Web 进程。具体增加多少秒尚未测量。

**事实：** Host 各 Loader row 通过服务依赖决定可启动时机，没有固定的配置行串行顺序；Harness `vendor/loader/src/config/group.ts:48-64` 用 `Promise.all` 创建同组 row。preset registry 的 service 在构造时出现，preset definition row 随后 eager load；Team Host 和 preset mount 存在并行窗口。两者实际重叠多少，未测量。

### `AgentTeam[Service.init]`

`packages/agent-team/src/index.ts:683-816` 的顺序是明确的：

1. 注册 Team Session projection，安装 Agent 事件监听。
2. `openTeamStorage()` 创建隔离 SQLite，路径为 `$DSH_HOME/storages/agent_team.sqlite`，使用 WAL（`index.ts:458-468`）。
3. `await storageDomain.open(agentTeamDomainSpec)`（`index.ts:745-746`）。
4. 构造 `AgentTeamLedger`，构造函数同步重放全部记录（`index.ts:773-777`）。
5. `await ledger.initialize()`（`index.ts:783`）。
6. 启动不阻塞 boot 的 attachment GC。
7. 一次 `sessionPersistence.list()`，建立所有 Member 共用的 persisted Session 集合（`index.ts:785-789`）。
8. `await sweepWorkspaceParticipations()`；它按 Member 和 Workspace 嵌套扫描，只对已消失的非默认 Workspace 写 leave operation（`index.ts:823-836`）。
9. 对 `ledger.listMembers()` 逐 Member 串行执行 transition 收敛、activation 或非 enabled effect 收敛（`index.ts:790-816`）。

**事实：** 第 7 步避免了每个 Member 各调用一次 `sessionPersistence.list()`；`persistedSessionHeaders()` 只在 `ENOENT` 时重试，最多额外等待 `25 + 50 + 75 = 150 ms`（`index.ts:2272-2280`）。这是现有设计已经消除的重复 I/O。

**事实：** 第 9 步没有并行化。一个 Member 的异常会在内部捕获并记录，不会阻止后续 Member，但所有 `await` 的耗时仍相加。

### 单个 Member 的激活成本

`packages/agent-team/src/index.ts:2283-2408` 的 `activateMember` 在每个 Member 上执行：

- `initializePrivateMemory()`：检查旧路径、可能重命名、合并旧目录、`mkdir notes`、`mkdir skills`、以 `wx` 尝试创建 `memory.md`（`member-runtime.ts:278-293`）。这是每 Member 一组真实文件系统调用。
- 用共享 Session header 集合判断是否 persisted，必要时执行 cold generation recycle 判断。
- `await ctx.agentPresets.mount(...)` 绑定共享 preset generation。
- `applyMemberToolPolicy()`，重新读取 preset scope 的 tool schemas、建立 allow-list、安装 restriction 和 guard（`member-runtime.ts:99-161`）。
- `validateMemberPreset()` 再读取一次 schemas，确认七个 Team tools 都存在（`index.ts:2451-2461`）。
- `agents.resume()` 或 `agents.create()`。resume 的 Session log 越大，潜在读取和折叠成本越高。
- 挂载 Member 私有 skill provider。
- `await workspace.attachSession(member.sessionId)`，然后才把 handle 放入 `this.handles`（`index.ts:2360-2361`）。
- persisted Session 还要折叠 context projection、恢复 transition、修复 continuation，并可能重放 carried input（`index.ts:2372-2384`）。

**事实：** `agentPresets.mount()` 不会重新挂载整棵 preset tree。`packages/preset/agent-preset-registry/src/index.ts:281-289` 只 retain 共享 generation 并 bind。

**事实：** 每次 `agentPresets.mount()` 的 `retain()` 都会先调用 `diagnostic()`；`agent-preset-registry/src/index.ts:135-145` 再执行一次 `auditRows(tree)`。`mount.ts:134-157` 遍历所有 preset row，并逐 row `await fiber.await()`。所以共享树只挂载一次，但“共享完整审计”会在每个 Member 上重复一次。

**未测量：** 文件系统小操作、preset 审计、Agent create/resume、Session 事件折叠分别占多少；也无法从当前测试推断 8 或 16 个 Member 的总时长。

### Ledger 冷启动

**事实：** 存储打开和记录读取分成四层：

1. `packages/agent-team/src/vendor/storage-sqlite/unit.ts:76-108` 对每张表执行 `SELECT key, value FROM ...`，逐行 `JSON.parse`。没有 SQL `ORDER BY`。
2. `packages/storage/storage-domain/src/index.ts:117-142` 对每条记录执行 `tableSpec.valueSchema.parse(raw)`。
3. `packages/agent-team/src/spec.ts:737-757` 的 `projectSpelling()` 在 strict union parse 前递归复制并改写每个旧 Channel key，随后执行严格 union parse 和 `stampOperationMessages` transform。
4. `packages/agent-team/src/ledger.ts:657-673` 的构造函数同步调用 `replay()`。

**事实：** `ledger.ts:6263-6280` 的 `sortedRecords()` 将全表展开并排序，建立 message occurrence 和 instant 索引，然后逐记录执行多项 legacy normalize/repair，并把结果应用到一个 scratch projection。

**事实：** `ledger.ts:2806-2831` 的 `validateRecords()` 构造第二个 projection，逐记录执行 `validateOperation`、`applyTo`，并建立 operation/request/ref 集合。随后 `replay()` 再对 live projection 执行第三轮 `applyAndAdvanceProjectionVersion`。

**推断：** 冷启动 CPU 和临时对象随 operation 数增长；排序为 `O(n log n)`，至少三轮完整投影为 `O(n)`，schema/legacy normalize 还包含额外的递归与对象复制。已有 `storage-bench.spec.ts` 只测 SQLite/JSON 后端写路径，不覆盖这条重放链。

**事实：** 启动没有第二次 invariant 全量重放。`index.ts:2032-2045` 和 `ledger.ts:2559-2568` 会采纳构造函数刚建立且 head 未变化的 boot validation。

## Commit 与 Tool call 的后续成本

**事实：** `packages/agent-team/src/invariant.ts:40-69` 监听每次 `agent-team/committed`，用 `setImmediate` 合并同一 I/O turn 的提交，然后调用 `validateLedger()`。`ledger.ts:2555-2557` 的该方法再次执行 `sortedRecords()` 和完整 `validateRecords()`，即重放整个 durable table。

**事实：** 首次提交不会在返回响应前执行这项全量校验，所以它不是直接的同步提交延迟。

**推断：** Agent Team 写得越多，每次有写操作的 tool call 后越可能出现全表 CPU 尖峰，并挤压同一 Host 的后续请求。事件循环延迟、CPU 峰值、下一次 tool call 的排队时间都尚未测量。

## Preset 与七个 Team tools

**事实：** `cordis.patch.yml` 当前为 22,746 B。`team-member` preset（`cordis.patch.yml:24-223`）只声明一份，包含 persona、native tool presentation、指令、shell/fs/search/jobs/skill、member context/time、七个 Team tools、web、compaction 子组和 `/compact`。

**事实：** preset registry 在 register 时 eager 激活定义（Harness `packages/preset/agent-preset-registry/src/index.ts:77-110`）。`mountPreset()` 建立一棵 Loader 子树，执行 `root.update()`、`auditRows()` 和 service leak 检查（`mount.ts:204-215`）。这发生在共享 definition 激活阶段。

**事实：** 七个 tools 在 shared preset tree 的 `packages/tool-agent-team/src/index.ts:1297-1305` 一次注册，没有 await。

**推断：** YAML 解析、prompt 进入配置、插件首次 import 和审计是 Host 启动的一次性成本；Member 数增加不会重复 YAML 解析或插件 import。Per-Member 成本主要来自 bind、重复 audit、工具 surface 检查、Agent create/resume 和 Session 恢复。

## Client bundle 与普通模式

### 何时加载

**事实：** 根 `package.json:48-67` 只声明一个 `dsh.client` Web 入口，输出是 `packages/client-agent-team/lib/client.js`。

**事实：** Harness `packages/client/modules/src/index.ts:559-593` 将所有 application batch 写成 `<link rel=modulepreload>`。`packages/client/modules/src/client/entries.ts:84-99` 为 manifest 的每个 plugin并发 create，然后等待 Loader 稳定。`packages/client/web/src/boot-client.ts:36-57` 再执行 `loader.await()` 并要求每个入口 active。

**推断：** 普通 conversation 模式也会下载、解析、执行并激活 Team Client；不能把 Team 数据请求或 Team 页面渲染当成只在进入 Team mode 后才发生的全部成本。

### 激活顺序

**事实：** `packages/client-agent-team/src/client/index.ts:71-74` 的硬依赖包括 `slots`、`workspaces`、`layout`、`locale`、`remote`、`remote.session`、`sessions`、`connection`、`conversation`、`uiWorkspace`、`configForms`。根 manifest 还声明八个 Client package inject 边（`package.json:52-67`）。这是服务就绪屏障，不代表八个网络请求依次串行。

**事实：** `client/index.ts:472-476` 的顺序是：

1. `await ctx.remote.$mount(agentTeamRemote)`。
2. `ctx.inject(['remote.agentTeam'], ...)`。
3. namespace 出现后同步执行 `applyUi()`。

**事实：** Harness `packages/api/gateway/src/client/index.ts:214-221` 将 `$mount` 放进全局 mutation queue，所以它会排在其他 Remote mount 前后。`$mount` 随后验证全部 descriptor、strict input，并整组安装 namespace；不会暴露半个 namespace。

**事实：** `applyUi()` 注册 locale、navigation、draft、identity、environment、query/read controller、常驻 Team rail 和 main seat、conditional sidebar/main mode shadow、panel ownership 和 settings section（`client/index.ts:313-469`）。这些同步注册发生在 boot active 之前。

**事实：** 网络数据没有在 boot 时统一拉取：

- `TeamChangeStream` 的构造只保存 remote；第一次 `subscribe()` 才调用 `$stream()`（`team-changes.ts:33-44,70-83`）。
- Human identity 在第一个 subscriber 时读取（`human-identity.ts:53-71`）。
- environment 同样只在第一次 subscribe 时刷新（`environment-check.ts:21-46`）。
- Team 页面组件和 Query 在 slot 真正渲染后才发首个 Team query。

**推断：** Team Client 对普通 Web boot 的阻塞主要是 bundle compile/evaluate、依赖服务等待、全局 Remote mount 和同步 slot 注册；数据网络不是 boot 时的主要串行链。具体百分比未测量。

## Typed Remote

**事实：** 当前生成 Remote 有 40 个方法，39 个 unary、1 个 stream（`agentTeam/changes`）。40 个 invocation 都是 `direct`。

**事实：** `packages/typert/protocol/src/remote-info.ts:28-81` 延迟到首次读取 `descriptors` 或 `methods` 才建立 descriptor index。Zod 输入 schema 在 `NamedInput.create()` 首次调用时创建，JSON Schema 投影也在首次 getter 时构造（同文件 `100-160`）。

**事实：** `$mount` 一定要读取 descriptors，因此 40 个 descriptor 元组会在 Client boot 时建立；但业务输入 Zod parser 不会仅因 `$mount` 全部实例化。

**事实：** Harness `packages/typert/loader/src/index.ts:408-454` 按 package name 缓存 Host generated manifest import，并执行结构校验；初始扫描并发处理各 Loader entry。

**未测量：** Host 528,771 B Typert 产物的 dynamic import、parse、eval 和 40 descriptor 校验耗时；Client index 构造和全局 mount queue 等待耗时。

## 生成物与网络体积

| 文件 | raw bytes | gzip level 1 | gzip level 9 | Brotli | 说明 |
|---|---:|---:|---:|---:|---|
| `packages/client-agent-team/lib/client.js` | 1,088,000 | 215,856 | 163,764 | 105,532 | 浏览器唯一 Team bundle |
| `packages/client-agent-team/lib/client.js.map` | 1,498,870 | 320,040 | 241,557 | 175,272 | 正常 boot 不读取 |
| `packages/agent-team/lib/typert.remote-client.js` | 415,622 | 54,628 | 37,545 | 16,485 | 被内联进 Client bundle |
| `packages/agent-team/lib/typert.host.js` | 528,771 | 72,772 | 52,137 | 27,773 | Host dynamic import |

Harness shipped Web server 使用 gzip level 1，见 `packages/bundle/web-app/cordis.patch.yml:179-188`。因此浏览器传输对照应优先使用上表的 level 1 列。

**事实：** Client source map 有 63 个 source，`sourcesContent` 共 952,397 B。最大单源就是 generated Remote，415,622 B，占全部 source content 的 43.6%，也占成文 Client JS 的 38.2%。其后最大页面源码约 28–38 KiB，说明 Remote 的静态 JSON Schema 和 factory 是单入口中的最大代码块。

**事实：** `npm pack --dry-run --json --ignore-scripts` 显示当前包为 1,009,372 B tarball、5,699,228 B unpacked、340 个文件。根 `package.json:17-25` 发布所有 `lib/**/*`，包括 source map。

**事实：** Harness `docs/subsystems/client-modules.md:100-102` 明确说明 startup、index、script GET 和 HEAD 不读取 map；只有第一次 map GET 才读取和缓存。

**推断：** source map 影响安装、解包和调试网络，不应列为普通页面启动阻塞。Client 单 bundle 的 parse/evaluate、长任务和首屏阻塞需要浏览器 trace 才能定级。

## 首次可用时间定义

当前必须分别记录四层，不能只报一个“启动时间”：

| 层 | 起点 | 终点 | 当前已知等待 |
|---|---|---|---|
| Host service | Host profile 开始 boot | `agentTeam` fiber active | storage open、schema parse、ledger replay、Session list、Member 串行激活 |
| Host process ready | 进程启动 | Web URL 提示/自动打开 | 整棵 Host Loader 稳定，包括 Team |
| Web app ready | navigation start | `bootClient()` 完成、根页面可渲染 | 全部 application bundle 预取、所有 client entry active，包括 Team |
| Team usable | 普通页面已渲染或 Team mode 恢复 | rail 可点击、Team 页面首个数据可用 | Remote mount、slot 注册、changes baseline、首个页面 query；stream 为按需 |

对恢复 Team mode 的页面，还要单独记录：首个 `changes` baseline、首批 members/projects/view/inbox 请求、页面首可交互。普通模式的 Team rail 不应等待这些数据。

## 可复现测量办法

### 1. 冻结样本

每次记录：Team commit、Harness commit、Node/browser 版本、profile、SQLite 文件大小和 operation 数、enabled Member 数、persisted Session 数与 Session log 大小、冷/热磁盘缓存、正常/恢复 Team mode。构建前先对同一产物跑 `npm run build`，或在报告里明确使用现有 `lib/`；不要混用源码版本和旧产物。

### 2. 产物体积

```bash
node - <<'NODE'
const fs = require('fs')
const z = require('zlib')
const paths = [
  'packages/client-agent-team/lib/client.js',
  'packages/agent-team/lib/typert.remote-client.js',
  'packages/agent-team/lib/typert.host.js',
]
for (const p of paths) {
  const b = fs.readFileSync(p)
  console.log(p, b.length, z.gzipSync(b, { level: 1 }).length,
    z.gzipSync(b, { level: 9 }).length, z.brotliCompressSync(b).length)
}
NODE

npm pack --dry-run --json --ignore-scripts
```

同时记录 source map 的 source 数、`sourcesContent` 总量和最大 source；体积变化必须绑定同一 commit。

### 3. Browser trace

用同一 Chromium 版本分别跑：

- 禁用 HTTP cache 的 cold navigation；
- 浏览器 cache 和服务端 bundle cache 都预热的 reload；
- ordinary conversation；
- localStorage 已保存 Team mode 的恢复；
- 空 Team 与真实数据 Team。

Playwright trace 至少记录：navigation start、Team `client.js` response/transfer/decoded size、script compile/evaluate、long task、根页面首个内容、Team rail 首次可见/可点击、Team 页面首个内容、首个 `changes` baseline、首批 Team query。开发环境可以用 DevTools Performance 与 Network 交叉确认；最终用 script 取的 p50/p95，而不是单次截图。

建议通过 Playwright 设置 Route 统计每个 Team Remote 请求，并记录 `PerformanceObserver({ type: 'longtask' })`。真正比较单入口拆分收益时，使用相同数据、相同冷/热缓存和相同 slot 访问路径。

### 4. Host CPU 与关键区间

先做不改仓库的整进程采样：

```bash
rm -rf /tmp/team-perf-cpu
mkdir -p /tmp/team-perf-cpu
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp/team-perf-cpu" \
  dsh web --profile web-dev
```

记录进程启动到 Web ready 的 wall time，并用 CPU profile 按 self time 检查 `JSON.parse`、Zod parse、`projectSpellingKeys`、`sortedRecords`、`validateRecords`、`applyTo`、preset audit、Agent resume。

要区分内部阶段，必须在临时 worktree 或 `/tmp` 测量副本中插入 `performance.now()` 标记；不得把临时插桩提交到生产代码。至少标记：

- Team row 开始；
- SQLite `loadAll` 前后；
- domain schema parse 前后；
- ledger constructor 前后；
- `initialize` 前后；
- Session list、Workspace sweep 前后；
- 每个 Member activation 开始/结束；
- preset definition ready；
- Team fiber active。

### 5. Ledger 数据阶梯

使用合法 operation 链构造空 ledger、1k、10k、100k 三档。每档关闭已有连接，复制同一 SQLite 文件做多次 cold start，分别计时：

- SQLite `SELECT` + `JSON.parse`；
- domain strict schema parse；
- ledger constructor/replay；
- `initialize`；
- 首个 `status()`/`members()` Remote；
- 启动峰值 RSS。

至少 10 次，报告 median、p95 和离群值。大 ledger 还要在同一进程测一次写操作后到 invariant replay 完成的 event-loop delay 与 CPU time。

### 6. Member 阶梯

保持同一个 Workspace 和 ledger operation 规模，分别测 1、4、8、16 个：

- fresh enabled Member，无 Session log；
- persisted enabled Member，短 Session log；
- persisted enabled Member，长 Session log；
- 无 cold recycle 与有 cold recycle；
- 无 carried input 与有 carried input。

同时记录总 activation 时间、各 Member 时间分布、preset audit、Agent create/resume、workspace attach、内存峰值。只有在单 Member 成本和时间分布稳定后，才决定有限并发；并发可能和 Session I/O、SQLite、Workspace registry 争用，不能先假定 N 倍收益。

### 7. Preset 和 Typert 分离样本

为区分责任，至少跑四组：

1. Team bundle 全关；
2. 只启 Team Host 与 preset registry/definition，不激活 Member；
3. 同一 profile 加 1 个 Member；
4. 再加 N 个 Member。

对 Host Typert 单独测量首次 dynamic import、manifest validation 和 registration；对 preset 分别测量 definition mount/audit 与 per-Member mount/audit。

## 尚未回答

- 空 Team profile 与无 Team profile 的 Host ready 差多少。
- 典型和最大 production ledger 的真实 operation 数、SQLite 大小和 cold replay 时间。
- 当前用户实际有几个 enabled Member，Session log 多大，启动时多少走 resume 或 cold recycle。
- Client `client.js` 的 compile/evaluate 和 long task 是否进入用户可感知的首屏路径，普通模式和 Team mode 差多少。
- Team Remote mount 在全局 mutation queue 中等待多久，40 descriptor 索引占多少毫秒。
- preset 首次加载、重复 audit 和 Host Typert 首次 import 各占 boot 多少。
- commit 后 invariant 全表 replay 在真实 tool call 间隔内是否形成可观察的排队或卡顿。

这些数据出来前，优化实现应停留在实验分支和指标验证阶段。
