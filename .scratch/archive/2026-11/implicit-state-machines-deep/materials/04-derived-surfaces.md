# 派生面：owner guidance、sidebar order、shortcuts、clipboard

这四个面不是第一轮意义上的“生命周期状态机”，但它们是新增的派生/偏好/声明面。它们值得单独记录，因为其中 sidebar order 改变了第一轮 C16 的结论，owner guidance 和 tool availability 则把“当前事实”直接写进 prompt。

## 1. Project owner guidance

- **文件：** `packages/agent-team/src/project-owner-guidance.ts`；注册在 `index.ts:3070-3079`。
- **权威：** ledger 的当前 ownership 与 Host 的 Worker 开关。
- **状态：** 没有自己的持久状态。每次 prompt 组装时求值：
  - `ownsProject === false` → 空段；
  - `ownsProject === true` → owner duties + delegation；
  - `workerEnabled === true` → 追加 Worker 段。
- **事件：** owner grant/revoke、Worker 开关变化、每次 assembly。
- **守卫：** 段只写常驻职责和判断，不写工具参数、不写 per-Project 事实；per-Project 事实由 Member 通过 Team tools 读取。
- **恢复：** 注册一次 per generation，文本每次 assembly 重算；grant/revoke 不需要重启，下一次 assembly 生效。
- **测试：** `project-owner-guidance.spec.ts`。
- **开放问题：**
  1. 一个 Member 在 activation 之后才被授予 owner，段会在下一次 assembly 出现；如果它正在一个长 turn 中，是否要等到下一个 turn？当前是每次 assembly，应该会立即出现。需要确认 Harness 的 assembly 频率。
  2. Worker 开关关闭时，Worker 段消失；一个已经在跑的 Worker 不受影响。这是刻意的，但 prompt 里不再提 Worker，Agent 可能忘记它还有一个在跑的 run。是否需要一句“你仍有在跑的 Worker”由运行列表回答？当前由工具/Thread 事实回答。

## 2. Sidebar order（Host row 设置）

第一轮 C16 说“排序及开合是 localStorage 偏好，与 Remote 默认合并，不修改 Team ledger”。这只对 `7076dbd` 成立。当前排序写 Host row 的 `sidebarOrder`，localStorage 是缓存和离线回退。

### Host 侧

- **文件：** `packages/agent-team/src/sidebar-order.ts`。
- **形状：** `{ version: 1, lists: { '<workspaceId>|projects': refs[], '<workspaceId>|agents': refs[] } }`。
- **守卫：** 键必须是 `<workspaceId>|<projects|agents>`；Workspace 部分非空、无空白/控制字符、长度受限；refs 非空字符串、无空白/控制字符、最多 500 条、每条最多 200 字符；重复折叠。
- **读取：** `readableSidebarOrders` 丢弃不可用条目，不让一个手改的设置文档破坏整个读取。
- **迁移：** 该字段是 Host row 迁移已知的字段，carried group 到达时完整。
- **测试：** `sidebar-order-settings.spec.ts`。

### Client 侧

- **文件：** `packages/client-agent-team/src/client/sidebar-order.ts`。
- **状态：**
  - 本地缓存：`cachedRaw` / `cachedOrders` / `MEMORY_ONLY`；
  - Host 补水：`hydration` promise；
  - 未确认写入：`unconfirmed` set；
  - 本页已写：`writtenHere` set；
  - 快照缓存：`revision` + `signature` + `savedFingerprint`。
- **事件：** attach Host、首次渲染、Host load 成功/失败、拖动提交、Host save 成功/失败、Host 答案到达。
- **守卫：**
  - `writtenHere`：本页刚拖过的列表不被一个可能更早读到的 Host 答案覆盖；
  - `unconfirmed`：失败的写入在下次读取时重试；
  - `reconcileSidebarOrder`：删除已消失的 ref，保留相对顺序，新 ref 追加；
  - `isListKey`：只接受两种列表键。
- **恢复：** Host 读失败时本地缓存继续服务；旧本地顺序在首次 Host 读取时上迁一次；`Channels` 旧键名迁移到 `projects`。
- **测试：** `sidebar-order.spec.ts` 覆盖 Host 覆盖旧缓存、上迁、写失败继续服务、读期间拖动不被覆盖、Host 读失败回退、多个列表只读一次 Host。
- **开放问题：**
  1. 两个窗口同时拖动同一列表：后写的 Host 答案会覆盖先写；`writtenHere` 只保护本页。是否需要冲突提示？当前是“最后写入者赢”，对个人偏好可能可接受。
  2. Host 写入失败后，`unconfirmed` 只在下次读取时重试；如果用户不再打开该列表，失败会一直留着。是否需要在设置页显示“未同步”？当前没有。
  3. 一个 Workspace 被删除后，Host 里的键仍保留；`reconcileSidebarOrder` 只在读取当前列表时丢弃已消失的 ref，不会清理整个键。是否需要 GC？低优先级。

## 3. Team shortcuts

- **文件：** `packages/client-agent-team/src/client/team-shortcuts.ts`。
- **性质：** 声明式命令注册，不是状态机。每个命令有 id、label、aliases、平台默认、regions、modals、resolve。
- **守卫：**
  - Web 保留 Alt，因为浏览器拥有裸 Command 组合；
  - macOS 的 Command+Shift+3/4/5 被截图占用，所以 Inbox 数字族用 Alt+Shift；
  - Linux Desktop 保留方向键组合，所以 Back/Forward/Project 上下在 Linux 不绑定；
  - 一个无法承载的组合保持未绑定，不挤掉已发布快捷键。
- **行为：** 进入 Team mode 时同时选 rail panel；Back/Forward 复用 navigation 的 last face；Project 上下按侧栏可见顺序循环；Inbox 数字点击对应行。
- **测试：** `team-shortcuts.spec.ts` 覆盖注册、平台组合、模式切换、face 打开、composer 聚焦、Back/Forward、Project 步进、Inbox 行。
- **开放问题：**
  1. `projectRows()` / `inboxRows()` 直接读 DOM；如果列表还在 loading 或部分失败，命令会静默无操作。是否需要给用户一个“当前没有可跳转的行”的反馈？当前是静默。
  2. 快捷键与侧栏拖动的顺序：`projectRows()` 读的是 DOM 顺序，应该已经反映拖动后的顺序。需要确认拖动后 DOM 立即更新。

## 4. Clipboard

- **文件：** `packages/client-agent-team/src/client/clipboard.ts`。
- **性质：** 单次资源尝试，不是状态机。
- **行为：** 先走 Harness 的 `writeClipboard`；失败后尝试 `document.execCommand('copy')`；两者都失败返回 `false`，由卡片报告复制失败。
- **开放问题：** 无。这是第一轮 C24 的“复制提示”修复的落点，行为简单。

## 结论

- **sidebar order 是第一轮 C16 的过时描述**，当前实现有 Host 设置、缓存、上迁、未确认写入和测试；不需要再按“localStorage 偏好”理解。
- **owner guidance 和 tool availability 是纯派生**，没有自己的持久状态；它们的风险在 prompt 文本与实时事实的一致性，不在状态机。
- **shortcuts 和 clipboard 不是状态机**；shortcuts 的开放问题是“无行时静默”，属于 UX 细节，不是架构问题。
