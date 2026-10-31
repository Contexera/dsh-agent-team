# Team 启动与加载性能研究

## 1. 范围与证据口径

检查基线是 `master` 的 `a91e84a`，包版本 `0.2.5`。检查时工作区有并行未提交修改，包括 `cordis.patch.yml`、`packages/agent-team/src/index.ts`、`packages/agent-team/src/ledger.ts` 和 `packages/client-agent-team/src/client/slots.ts`。本文读取当前工作区，并用符号名作为主要定位；行号只对应本次快照。

当前 checked-in 构建产物时间如下：`client.js` 为 12:20，Host/Tools 的 `lib/index.js` 为 12:20，`typert.*.js` 为 13:58。部分 source 在构建后仍有修改，因此体积和模块导入的结论属于 checked-in artifact，不代表重新构建后的精确值。

必须分开的完成点：

| 指标 | 完成条件 | 当前是否测量 |
| --- | --- | --- |
| Host ready | `AgentTeam[Service.init]` 完成，包括 ledger 打开和 Member 恢复 | 未测量 |
| Web shell ready | 全部 Client entry 激活，renderer 完成挂载 | 未测量 |
| Team UI ready | `remote.$mount()` 完成，`remote.agentTeam` 出现，Team slot 已注册 | 未测量 |
| Team first data | 进入 Team 模式后，当前页面所需 Remote 读完成并渲染 | 未测量 |
| Member ready | 单个 Agent 已 resume/create，preset、tool/model policy、Workspace 和 Session 已就绪 | 未测量 |

本轮没有完整 Harness 冷启动数据。下面把“源码确认”“本地 Node 测量”“推测”“未测量”分开写，不能用局部数字代替端到端时间。

## 2. 实际加载路径

### 2.1 Host 与 preset

1. Team bundle 由 `cordis.patch.yml` 的三个顶层入口组成：`@contexera/dsh-agent-team`、`/host`、`/invariant`。Host 与 preset registry 位于私有 `agentPresets` isolate group，普通 Session 不共享这个 preset。
2. Typert loader 按 live package entry 找到 `package.json` 的 `./typert` export，并用 `manifests` Map 保证每个 package 在一个进程只 import/validate 一次（`../deepseek-harness/packages/typert/loader/src/index.ts:342-351,408-455`）。首轮各 contributor 用 `Promise.all()` 并发 load（同文件 `489-500`）。`validateTypertManifest()` 只检查静态结构，要求 schema 有 `create()` 工厂但不调用它；computed projection 也保持 lazy（同文件 `80-135`）。
3. `cordis.patch.yml:15-25` 先声明私有 registry 和 `team-member` preset，`cordis.patch.yml:224-225` 再声明 Host。Host 的 `static inject` 包含 `agentPresets`（`packages/agent-team/src/index.ts:331-343`），所以 Host `Service.init` 必须等 preset 注册完成。
4. `AgentPreset[Service.init]` 会 `await agentPresets.register(...)`（`../deepseek-harness/packages/preset/agent-preset/src/index.ts:27-29`）。registry 的 `register()` 不仅保存定义，还立即 `await this.activate(record)`（`../deepseek-harness/packages/preset/agent-preset-registry/src/index.ts:77-110`）。`mountPreset()` 会更新完整 child tree、等待 tree 并执行 `auditRows()`（`.../agent-preset-registry/src/mount.ts:191-215`）。
5. Linux 上 `team-member` 有 15 个 enabled leaf row，另有 compaction group。它们覆盖 persona、coding tools、Team tools、web、context 和 compaction。这个 tree 在启动时加载一次。之后每个 Member 的 `agentPresets.mount()` 重做整 tree audit，不会重新实例化 child plugin。
6. `packages/tool-agent-team/src/index.ts:2` 是运行时代码导入，整份 `@contexera/dsh-agent-team/host` 会随 tools row 的模块图加载。ESM module cache 会复用该模块，没有第二个 Host 实例证据。代价是 tools row 与 200 KB 级 Host 入口模块及其依赖耦合。
7. Host 初始化按 `packages/agent-team/src/index.ts:745-816` 执行：打开数据库、全量读取并解析 domain、构造 ledger 并 replay、初始化 ledger、列出 Session headers、扫描 Workspace participation，最后串行遍历 Member 并执行 transition/activation/convergence。
8. invariant 的 `inject = ['agentTeam']` 保证 Host 暴露服务后才 mount；mount 验证复用构造期 replay 的结论（`packages/agent-team/src/invariant.ts:31-37`，`packages/agent-team/src/index.ts:2036-2045`），正常路径没有第二次全量 replay。

### 2.2 Web/Client

1. Harness 在 HTML 中预加载全部 application batch，然后执行 blocking bootstrap，最后加载 shell（`../deepseek-harness/packages/client/modules/src/index.ts:559-592`）。Team 没有声明 `immediately`；`package.json:48-67` 的 `dsh.client.inject` 用于模块图/external 关系，不是 Cordis 运行时激活顺序。
2. `Boot.run()` 等 bootstrap readiness，创建 module loader，等待 stage-one prefetch，再进入 `bootClient()`，全部 entry 激活后才 `mountClient()`（`../deepseek-harness/packages/client/web/src/boot.ts:49-98`）。
3. `ClientEntries.start()` 用 `Promise.all()` 创建初始 entries（`../deepseek-harness/packages/client/modules/src/client/entries.ts:84-99`），所以初始 entry 之间不是一个接一个导入；仍是全有或全无的 barrier：`loader.await()` 后检查所有 entry active（`../deepseek-harness/packages/client/web/src/boot-client.ts:36-56`）。
4. Remote contribution mount 本身另有串行门：每个 `$mount()` 都进入 ApiGateway 的同一个 `enqueue()` mutation queue（`../deepseek-harness/packages/api/gateway/src/client/index.ts:214-221,248-252`）。多个 Client plugin 可以并发 import，但 Team 的 `$mount()` 要等前面的 mount，后续 contributor 也要等它完成。
5. Team Client 的运行时可观察顺序是：静态模块已完成求值，然后 `apply()` 先 `await ctx.remote.$mount(agentTeamRemote)`，再等 `remote.agentTeam` 并调用 `applyUi()`（`packages/client-agent-team/src/client/index.ts:472-476`）。页面 renderer 要等这个 `apply()` resolve，所以 Team bundle 求值和 `$mount()` 在 shell-ready barrier 内；`applyUi()` 与 slot 注册相对于 renderer 的精确先后尚未测量。
6. `applyUi()` 注册语言字典、导航、查询层、Team panel、Settings section；Team 页面和 Team mode shadow 仍是静态导入。`TeamWorkspaceBrowser` 只有在 `navigation.mode === 'team'` 时才注册（`packages/client-agent-team/src/client/index.ts:270-310,386-389`），因此普通模式不会在 Client activation 时读取 Team Inbox。
7. 首次进入 Team 模式后，`TeamWorkspaceBrowser` 的 effect 才会对每个 Workspace 并发发一个 `limit: 1` 的 Inbox 请求（`packages/client-agent-team/src/client/TeamWorkspaceBrowser.tsx:53-88`）。这是“进入 Team 的首数据成本”，不是 Web 启动或 Client activation 成本。

## 3. 已证实的成本

### 3.1 Host Member 恢复是串行门槛

`packages/agent-team/src/index.ts:790-816` 对 `ledger.listMembers()` 顺序 `await`。每个 enabled Member 路径可能包含：

- `initializePrivateMemory()`：目录迁移和 `mkdir/writeFile`（`packages/agent-team/src/member-runtime.ts:278-292`）。
- `planWakeForMember(member, undefined)` 在 Member 尚未 live 时调用 `StoredSessionReader.read()`（`packages/agent-team/src/index.ts:528-540,2297-2303`）。`StoredSessionReader.read()` 打开、读完并关闭整个 Session（`packages/agent-team/src/stored-session-reader.ts:111-127`）。首次 cold wake 若通过 age gate，还会重建 Session 并计算 token。
- `agentPresets.mount()` 会执行 `retain -> diagnostic -> bind`，其中 `diagnostic()` 每次重新 `auditRows()` 整棵已激活 tree（`../deepseek-harness/packages/preset/agent-preset-registry/src/index.ts:124-146,232-290`）。
- `agents.resume()` 或 `agents.create()`、Workspace attach、Session event fold、transition repair 和可能的 carried-input replay（`packages/agent-team/src/index.ts:2311-2384`）。
- carried-input replay 会再次完整读取 previous Session（`packages/agent-team/src/index.ts:2068-2088`）。JSONL backend 的 `coldLogMemo` 可以在紧接着的 resume 中复用同一 revision 的解析结果（`../deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts:304-314,566-629`），但命中率未测，不能假定所有读取都免费。

当前本地 profile 在采样时报告 31 个 Agent Member。enabled 子集的完整路径会逐项串行等待，现有 profile 最多有 31 个候选；实际 enabled 数量需要从固定 ledger 副本读出并写入基准元数据。该数字只描述当前本地状态，不是仓库保证的规模。

`AgentTeam.static.inject` 还把所有九项依赖作为 Host activation 的前置条件（`packages/agent-team/src/index.ts:333-343`）。其中只有一部分是打开 storage/ledger 立即需要的，但当前实现不能拿 ledger replay 与 preset、Session persistence 或无关 Host 服务的 readiness 重叠。这个静态依赖门的真实等待未测量；不能只凭字段列表判断哪项最慢。

`persistedSessionHeaders()` 虽然只调用一次，内部仍执行全局 `sessionPersistence.list()`（`packages/agent-team/src/index.ts:2272-2280`）。这避免了 N 次重复 list，但输入规模仍是全部 Session，而不是只列 31 个 Member Session；实际目录/header 成本未测。

### 3.2 ledger 启动会形成秒级同步区块

`openTeamStorage()` 固定创建独立 SQLite backend（`packages/agent-team/src/index.ts:458-467`）。`storageDomain.open()` 调用 `loadAll()`，SQLite 一次 `SELECT key, value` 全表读取并 `JSON.parse`，随后 domain 对每条记录做 Zod schema parse（`../deepseek-harness/packages/storage/storage-domain/src/index.ts:103-151`，`packages/agent-team/src/vendor/storage-sqlite/unit.ts:76-107`）。

`new AgentTeamLedger(...)` 在构造函数同步执行 `replay()`（`packages/agent-team/src/ledger.ts:657-673`）。`replay()` 包含：

1. `sortedRecords()`：收集全表、按 sequence 排序、normalize，并在 scratch projection 上应用一次。
2. `validateRecords()`：在第二个 projection 上验证全部记录语义。
3. 对 live projection 再应用一遍全部记录。

证据见 `packages/agent-team/src/ledger.ts:2806-2829,6263-6280`。上述步骤对已加载记录做三次不同目的的投影/验证，各自维护不同的正确性约束；成本随 ledger 规模线性增长。

本地只读测量使用当前真实 `/home/yu/.dsh/storages/agent_team.sqlite` 和当前 dirty source：

| 项目 | 观测值 |
| --- | --- |
| DB 文件 | 91,078,656 bytes |
| operations | 25,366 行，value UTF-8 共 72,673,916 bytes |
| 大表 | 约 13.6k 条 `team/thread-read`、7.3k 条 `team/thread-replied` |
| SQLite SELECT + JSON.parse + domain schema parse | 1.26-2.02 s |
| `new AgentTeamLedger(table)` replay | 0.89-1.19 s |
| 两段合计 | 2.14-3.21 s |
| 单独再次 `ledger.validate()` | 0.71-0.85 s |

这是 3 个样本的 Node 微基准，不计 Host 模块导入、Member 恢复、DSH Web 或浏览器时间，也不能直接说成完整启动增加了 2-3 秒。测量期间本地数据库还从 25,365 增至 25,366 条 operation，说明它是 live 状态；正式基准应使用固定副本。复现时以 `node:sqlite` 只读打开副本，分别计时 `SELECT key,value` + `JSON.parse` + `agentTeamOperationSchema.parse`，再构造 `AgentTeamLedger` 和调用 `validate()`；不要向真实 profile 写测试 operation。

### 3.3 提交后的全量 invariant 校验

invariant 在 `agent-team/committed` 后用 `setImmediate()` 合并校验（`packages/agent-team/src/invariant.ts:40-69`）。校验不阻塞当前提交响应，但 `validateLedger()` 会重放整个 durable table；以上 25k 行局部测量为 0.71-0.85 秒。当前本地 Member 协作会让这个同步 CPU 区块与后续操作竞争。它不是启动阻塞项，却会损害“启动后马上可用”的体验，因此必须和 cold boot 分开测量。

### 3.4 attachment GC 不阻塞 ready，但有同步 keep-set 扫描

`startAttachmentGc()` 用 `void sweep()` 启动（`packages/agent-team/src/index.ts:1280-1290`），不等待目录扫描和删除。不过参数求值会先同步执行 `ledger.referencedAttachmentIds()`；该函数遍历全部 `orderedFacts` 和 `mainSourceByRef`（`packages/agent-team/src/ledger.ts:2197-2208`）。随后 `scanAttachmentCache()` 对缓存目录项逐个 `readFile/JSON.parse`（`packages/agent-team/src/attachments.ts:177-201`）。

因此“GC 非阻塞”只对文件 scan/remove 成立；keep-set CPU 扫描仍落在 Host startup 调用栈上。现有 25k ledger 下具体耗时未测，附件目录很大时异步 scan 也会持续占用 I/O。

### 3.5 Client bundle 和 typed Remote

当前 checked-in 产物：

| artifact | raw bytes | gzip level 9 | brotli quality 11 | 启动关系 |
| --- | ---: | ---: | ---: | --- |
| `packages/client-agent-team/lib/client.js` | 1,088,000 | 163,764 | 105,532 | 浏览器 application bundle |
| `packages/agent-team/lib/typert.remote-client.js` | 415,622 | 未单独测 | 未单独测 | 内联进 Client bundle |
| `packages/agent-team/lib/typert.host.js` | 528,771 | 52,137 | 27,773 | Host Typert manifest |
| `packages/agent-team/lib/index.js` | 199,999 | 44,249 | 36,151 | Host runtime |
| `packages/tool-agent-team/lib/index.js` | 112,594 | 23,349 | 19,783 | preset tools row |
| `packages/client-agent-team/lib/client.js.map` | 1,498,870 | 不适用 | 不适用 | 启动不读取 |

`client.js.map` 有 63 个 source、约 952 KB `sourcesContent`，但不是 startup resource；Harness 文档明确 source map 只在首次 map GET 时读取（`../deepseek-harness/docs/subsystems/client-modules.md:100-102`）。它增加安装/下载包体积，不是首屏请求。

产物大小可用 `stat -c %s <file>`、`gzip -9 -c <file> | wc -c` 和相同输入的 `brotli -q 11 -c | wc -c` 复现；比较前固定文件 hash 和构建时间。

所有 Team 页面、两种 locale、查询层和 Remote 都是静态导入；checked-in `client.js` 没有动态 `import()`。`packages/client-agent-team/tsdown.config.ts:18-54` 把 `@contexera/dsh-agent-team/remote` 显式解析到生成产物，再由 `clientBundle()` 内联。remote 模块单独占用 `client.js` raw size 的约 38%，是 bundle 中的大块，但实际浏览器 combos 和压缩后增量未测。

Remote 有 40 个 direct endpoint（`packages/agent-team/tests/typert-generation.spec.ts:17-75`）。`createTypertRemoteInfo()` 在首次访问 `descriptors/methods` 时建立 40 项 index（`../deepseek-harness/packages/typert/protocol/src/remote-info.ts:20-82`）。Client `$mount()` 会经过串行 mutation queue，校验 descriptor、按 namespace 安装方法，并为 direct method 建 mount token（`../deepseek-harness/packages/api/gateway/src/client/index.ts:214-280,282-324,727-760`）。这一段完整 browser 耗时未测。

strict input Zod schema 和 JSON Schema 是 lazily created（`remote-info.ts:100-140`），普通 direct invocation 不调用 descriptor 的 `input.create()`；常见 Client 调用路径主要做参数映射和 connection RPC（`api/gateway/src/client/index.ts:444-545`）。因此“mount 时创建 40 套 parser”不是事实；但生成 artifact 中用于懒创建的代码仍要下载、解析和编译。

本地 Node 微基准只作为体量检查：

| 操作 | 观测值 |
| --- | ---: |
| fresh process 导入 `typert.remote-client.js` | 约 32-51 ms |
| 首次建立 40 项 descriptor/method index | 约 0.23-0.40 ms |
| 主动创建全部 40 个 strict input schema | 约 13-17 ms，非普通启动路径 |
| fresh process 导入 Host `lib/index.js` | 约 177-477 ms，波动大 |
| Host 已导入后导入 `typert.host.js` | 约 17-55 ms |
| Host 已导入后导入 tools `lib/index.js` | 约 15-46 ms |

这些是 Node warm filesystem 下的微基准，不是浏览器 cold load，也不是 Host ready。

## 4. 容易误判的加载点

| 候选 | 结论 |
| --- | --- |
| `teamSharedRemotes()` 被调用三次 | `packages/client-agent-team/src/client/index.ts:185-217,282,386-389` 只是创建包含 Remote 闭包的对象，没有网络 I/O。不是三次加载。 |
| Member 各自重新 mount 整棵 preset | 已证实 Member 各做一次整 tree audit；没有证据表明 child plugin 或 import 被重新实例化。 |
| Session headers 被每个 Member 重复 list | 已优化；`packages/agent-team/src/index.ts:786-789` 启动时只调用 `persistedSessionHeaders()` 一次。 |
| invariant mount 再 replay 一次 | 正常路径复用 ledger 构造期结果；真正第二次全量 replay 是提交后的 invariant check。 |
| `dsh.client.inject` 决定 Team 最后激活 | 不是。它是 package manifest 的模块图/external 信息；运行时等待由 Client plugin 自身的 `inject` 和 `ctx.inject()` 控制。 |
| Client entries 串行加载 | 初始 entries 是 `Promise.all()`；shell 等待全部 entry，但不是逐 entry 串行。 |
| Host 和 tools 各自创建 Host 实例 | 没有证据。`tool-agent-team` 会提前带入 Host module graph，ESM cache 随后复用。 |
| Team sidebar 在普通 Web boot 时请求每个 Workspace Inbox | 不是。shadow 只在 Team mode 注册，Inbox fanout 在 Team UI mount 后发生。 |

## 5. 现有测试和脚本覆盖

| 现有资产 | 覆盖 | 缺口 |
| --- | --- | --- |
| `packages/agent-team/tests/loader-composition.spec.ts:145-197` | 真实 Loader boot、dispose、reopen 和 ledger replay 正确性 | 没有阶段计时或规模矩阵 |
| `packages/agent-team/tests/member-cold-activation.spec.ts` | cold generation activation/swap 行为 | 没有 Member 数量曲线和 Host ready 时间 |
| `packages/agent-team/tests/typert-generation.spec.ts:17-75` | 40 个 Host/Remote method 一致性 | 没有 bundle、mount、parse 或 Long Task 指标 |
| `packages/agent-team/tests/storage-bench.spec.ts:9-18,94-117` | 1k/10k 顺序写入 | 没有 `loadAll`、schema parse、ledger construct/invariant replay |
| `packages/client-agent-team/tests/slots.client.spec.ts` | slot takeover/unload 正确性 | 没有 module import、Remote mount 或首屏耗时 |
| `scripts/e2e/support.ts:41-63` | 真实 Chromium、profile、进入 Team mode | 没有 performance marks 或样本输出 |
| `scripts/run-browser-test.mjs:9-56` | 真实构建、临时 Home/profile、Chromium journey runner | 场景各自只验证行为，没有 ready 时间或资源指标 |
| `scripts/e2e/team-multi-page.e2e.ts` | Team 多页查询正确性 | 没有加载和渲染性能 |
| `../deepseek-harness/packages/session/session-persistence-jsonl/tests/catalog-migration.perf.ts:1-77` | 0/100/1,000 个无关 Session 下的 stat、cold read、memo read、publish、current read，3 个独立进程样本 | 只测单个 parent Session 和固定 4 个 children，不是 Team Member/ledger 启动矩阵 |
| `../deepseek-harness/apps/web/tests/startup-rpc-budget.e2e.ts:27-43` | cold boot 的 `settings/describe` 请求数 | 不限制总 RPC、响应时间或 ready time |

## 6. 可复现测量方案

### 6.1 Host baseline

在临时 worktree 或后续实现 ticket 中增加可选 marks，默认保持关闭。至少记录：

```text
process spawn
  Host module import
  Typert manifest import/register
  preset child import tree
  preset mount + audit
  AgentTeam Service.init start
  storage backend open
  domain loadAll
  operation JSON.parse
  operation schema parse
  ledger sortedRecords
  ledger validateRecords
  ledger live apply
  ledger initialize
  Session list
  attachment keep-set / scan
  workspace sweep
  each Member: finishTransition | private-memory | cold-session-read | preset-audit | resume/create | workspace-attach | carried-input replay
  AgentTeam Service.init end
```

独立进程启动真实 Harness，从 parent process 记录 spawn 到 readiness probe 的总墙钟，同时记录内部 stage。采集 `--cpu-prof`、heap/RSS 和各状态样本；Node 计时波动大，空库至少 10 次，只报中位、p95/max，不把 3-5 个样本称为稳定 p99。

Session list/cold read 的规模矩阵可以直接复用 `catalog-migration.perf.ts:17-77` 的独立子进程与 `performance.now()` 结构，但要把无关 Session 档扩到 0/100/1k/10k，并另外改变 Team enabled Member 数。

规模矩阵：

- enabled Member：0、1、4、8、16、31。
- operations：0、1k、10k、25k、100k。
- Session：空、小、大，至少包含一个有真实长历史的 Member。
- 变体：current baseline、`deferMemberActivation` 实验、invariant on/off。
- 缓存：fresh process（Node/module cache 冷）和 warm process；DB 使用同一固定副本。

保持业务结果一致：最终 operation count/sequence、Member state、Session id、preset id、tool policy 和主要 Team 查询结果必须相同。

### 6.2 Chromium baseline

使用 Harness 现有 Playwright scaffold 和独立 Chromium profile。每个场景记录：

- `PerformanceResourceTiming` 的实际 combo URL、`transferSize`、`encodedBodySize`、`decodedBodySize`、request start/end。不能直接拿单包 `client.js` 大小代替 combo 大小。
- `responseStart -> DOMContentLoaded -> renderer mount -> Team apply -> Team slot ready` 的自定义 marks。
- `PerformanceObserver({ type: 'longtask' })` 和 CDP tracing，区分 JS parse/compile、Team module factory、`$mount`、React render、Team data RPC。
- 普通模式首次可用，以及点击 Team 后的 first data。

成对运行 Team bundle enabled/disabled，分别测 cold HTTP cache、warm cache 和至少一档 CPU throttle。每档 5-10 次 fresh profile，报中位、p95/max；不给小样本编造 p99。若比较“Team UI 延迟到首次 Team 模式”方案，也必须把普通模式与 Team 模式首数据分别报告。

### 6.3 preset、Remote 和依赖图

- 用同一永久 mounted preset generation 重复调用 `agentPresets.mount()`，测 1/31 次 audit 的增量，不把 child import 计入每次 Member。
- 在浏览器分别测 module factory 求值、`agentTeamRemote.descriptors` 首次访问、`$mount()` 完成、首个 Remote call。
- 对 Host 用 `import()` 链分别记录 `agent-team/host`、`typert.host.js`、`tools` 和每个 preset child 的 materialize 时间；不要用 source `tsx` 导入时间代替构建产物。
- 用 `NODE_DEBUG=module` 或 module timing instrumentation 确认 tools 确实复用 Host module，而不是从观察到的 import 推导。

## 7. 优先级建议

### P0：先建立 Host 端到端分段基线

在以上真实 25k operations、31 Members 的状态上，ledger 路径已经有 2.14-3.21 秒的 Node CPU 信号，Member 恢复又会串行读 Session 并 audit preset。第一步应测两者在同一进程中的占比，以及 0/1/4/8/16/31 Members 的斜率。没有这个基线，不应先改 ledger 数据结构或并发恢复。

### P0：按依赖拆分 Member restore

实验先分三段：read-only Session observation、private-memory provisioning、实际 `agents.resume/create`。前两段可以在有界并发池中做，最终 activation 仍按 Member 生命周期边界串行或采用小并发，避免 31 个 Agent 同时分配内存和工具服务。必须验证每个 Member 的 failure isolation、transition order、Session id 和 replay 结果不变。

### P0/P1：优化 ledger 前先定位三次 projection 和 schema parse

分别测 `loadAll`、JSON.parse、Zod parse、三次 projection 和 invariant check。可能的长期方向是减少重复遍历或建立可验证的增量索引；若考虑 snapshot，必须证明它是可重建的派生数据，仍以 append-only operation ledger 为唯一 authority。不能为启动提速跳过 durability 或 invariant 语义。

### P1：测 Client bundle 对普通 Session 首屏的真实影响

Team `client.js` raw 1.088 MB、gzip 164 KB，且包含 416 KB 的 generated Remote。它位于所有 Client entries 的 shell-ready barrier 前，但可能被浏览器缓存、与其他 application resource 共用 combo，也可能在桌面设备上影响很小。先做 Team enabled/disabled Chromium 对照，再决定是否把 Team 页面或 `$mount` 移到首次 Team 模式。任何拆包方案都不应手改 generated `typert.*`。

### P1：量化每次 Member preset audit

如果 31 次 `auditRows()` 在 Host ready 中占比明显，再考虑在 preset generation 上缓存成功的 tree audit，或向 Harness 提议公开一个不会在每次 bind 时重新 audit 的 API。Team 不应通过复制 preset tree 或绕过 registry 来换时间。

### P2：减少 Host 模块图耦合

把 tools 从 Host runtime 导入的常量、marker 和错误类型拆到轻量共享入口，可能减少 preset row 的导入耦合；但 Host runtime 迟早仍要为 Host row 加载，且当前 ESM cache 已防止重复实例。只有 module timing 证明这段位于串行关键路径时才值得改。

### P2：进入 Team 后的 Workspace fanout

`TeamWorkspaceBrowser` 已用 `Promise.all()` 并发读取各 Workspace，避免串行 fanout。这个点不影响普通 Web boot；若启动后的首次 Team 数据仍慢，再评估把多个 Workspace badge 合并成一个 Remote，或先渲染骨架再补 badge。

## 8. 未测量项

- 真实 Harness 从 process spawn 到 Host ready、shell ready、Team UI ready 和 Team first data 的各段耗时。
- 31 Members 中每个 Member 的 cold Session 大小、full read、preset audit、resume/create 和 Workspace attach 分布。
- JSONL `coldLogMemo` 在“startup observation -> resume -> carried-input replay”中的实际命中率。
- 25k operations 在当前完整 Host 中的 ledger 占比；本文只有 Node 局部读测。
- preset 的 15 个 enabled leaf row 各自 import/activate 时间和 tree audit 时间。
- Team client bundle 在 chromium combo 中的实际 transfer size、parse/compile 时间和 Long Task。
- `remote.$mount()` 安装 40 个 direct method 的浏览器耗时。
- ApiGateway Remote mount queue 中，Team `$mount()` 的等待时间和各 contributor 顺序。
- attachment keep-set 全量扫描、目录 scan 和删除在 cold/warm filesystem 下的耗时。
- 把 Member restore 改成 2/4/8 并发后，Host ready、内存峰值、失败恢复和 Agent 行为是否正确。
- snapshot、增量索引或延迟 Team UI 的实际收益；这些都只是待验证方向，不是现有结论。
