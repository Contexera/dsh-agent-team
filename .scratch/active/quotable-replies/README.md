# 引用可定位（quotable replies）

- **来源**：仓库外的一份改动清单（9 项，A→B→C→D→E）；清单本身不入库。
- **基准**：清单完成时逐个核对过它引用的 6 个文件 sha256；本分支现基于上游 `b9f11de`（已含 `@wowyuarm` → `@contexera` 重命名）。
- **状态**：已实现并提交；`npm test` 991 passed / 1 skipped。最后核对 2026-10-09。
- **完成条件**：清单 9 项均有断言覆盖，且仓库门禁全绿。
- **文档出口**：结论已落入 `docs/team-collaboration/{tools,boundaries,attention-and-messaging}.*` 与 `CHANGELOG.md`。

## 做了什么

| 项 | 落地 |
|---|---|
| A1 | `ledger.readMessage`：先经 `threadContextForActor` 授权（成员 + 归档），再按 `messagesByRef` 身份命中，逐字返回 `body`；未记录 / 别的帖 / 归档三种拒绝可区分 |
| A2 | `@Remote('readMessage')`（Human 席位）+ `readMessageForAgent`（Agent 席位）→ 同一个私有实现；开关关闭时**抛错**而非返回空 |
| A3 | `team_thread` 新增 `action=message`（`messageRef` 必填、`threadRef` 必填、拒绝 `beforeSequence`/`limit`），渲染逐字正文 |
| A4 | 类型只改 `src/types/`，生成物由 `generate:typert` 重出 |
| B1 | 通知行 `Replies to: @作者 — "首行摘要" [message:<uuid>]`，解析为空时回退裸号 |
| C1 | `readThreadForAgent` / `threadHistoryForAgent` 对**整个窗口一次**解析，并把锚点也一并装饰；**新建对象，绝不原地改** |
| C2 | 工具侧视图 / schema / 两处投影 / 渲染 / 锚点行五处同步 |

## 相对清单补的三处（清单作者未知的三点）

1. **A3 漏了 `output.schema`**：`team_thread` 的 output schema 顶层是 `additionalProperties: false`，且注册时会**校验返回值**（违反即 `throw ToolOutputError`，不是"被裁掉"）。新 action 的返回字段必须在 schema 里声明。
2. **A3 还需要 `readMessageForAgent` 桥**：本仓工具的调用面是 `*ForAgent` 服务方法，不是 Client Remote；清单只写了 Remote。
3. **C1 必须克隆**：facts 是读操作的持久化载荷（`Object.freeze(facts)`），原地写会抛错或让持久数据长出 schema 不认的字段 —— 就是 2026-10-08 那次宿主宕机的成因。

## 留痕

- 测试：`agent-team.spec.ts`（逐字/身份/三种拒绝/开关）、`member-lifecycle.spec.ts`（窗口外解析 + 一次解析 + 持久形状 + 通知格式）、`team-thread-render.spec.ts`（渲染与 schema 完备性）。
- 文档：`tools.md`/`tools.zh.md`（新 action、five→six、渲染）、`boundaries.*`（令牌缺席枚举）、`attention-and-messaging.*`（通知格式）。段块触顶按"拆段"处理，未缩内容、未上调上限。
