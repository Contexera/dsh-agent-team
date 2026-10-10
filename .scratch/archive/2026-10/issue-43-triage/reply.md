# GitHub issue #43 回复草稿

> 面向 issue 报告者。说明清楚每项的处置，不堆细节。English version follows.

---

## 中文

感谢这份清单——逐条都很有价值。我们在 `v0.2.2` 与当前 `master` 上逐条复现了一遍，结论如下。

### 确认会修的问题

| 项 | 处置 |
| --- | --- |
| **取消上下文后新会话 ID 由请求 ID 派生**（issue 4） | 确认成立。新 ID 会改回 `agent-team-<uuid>`，幂等性由其它机制保证，不受影响。 |
| **点击成员行无反应**（issue 1 的一部分） | 会话尚未进入客户端目录时，打开失败会被静默吞掉。会补上失败提示与状态回退。 |
| **`addMember` 不校验模型路由**（issue 6） | 未注册的 provider 会直接拒绝，而不是等到首回合才失败。 |
| **说明可为空、`memory.md` 英文占位**（issue 7） | 说明保持可选但引导填写；模板跟随界面语言。 |

关于 issue 2 的原始描述要说明一点：失败回合**确实会写会话日志**，完整的回合记录与结构化错误信息都在磁盘
（此前有复现报告称日志为空，原因是只解了 zstd 的第一帧——该格式每批写入一个独立帧）。
我们一度认为「失败原因重启后会消失」，进一步验证后确认不成立：成员会被重启重新唤醒，
路由若仍是坏的，同一持久来源会重新产出同一条诊断，所以我们不会为它改任何东西。

### 会调整的语义（会是一次破坏性变更）

| 项 | 处置 |
| --- | --- |
| **`sendMessage` 默认创建 Task**（issue 9） | 会改成必须显式声明。目前 Remote 默认建、而模型工具与 Web 输入框默认不建，三者不一致。 |
| **`updateMember` 省略字段即清空**（issue 10） | 改成真正的局部更新；清空改为显式传入空值。 |

这两项会影响直接调用 Remote 的调用方，会在版本号与变更日志里明确标注。

### 暂时不做

**Human 侧的编程入口（CLI / HTTP 接口，issue 8）**：我们暂时保持 Team 在 DSH Web 内使用，
暂不新增入口。不过会把 `ctx.agentTeam` 现有的接口面补进文档，并标注哪些有稳定性承诺——
目前通过 `ctx.get('agentTeam')` 取用属于未文档化用法，这一点会改善。

### 未能复现

**「新建多个成员后点击都打开同一个会话」**：我们在 Web 界面里连续建三个成员逐个点击，每次都正确打开
各自的会话，代码里也不存在按行位映射会话的逻辑。如果你是通过外部桥（`team-bridge`）调用的，
麻烦补充一下创建方式和当时的成员列表输出。另外上面提到的「点击无反应」缺陷可能与你的现象有关，
如果你看到的其实是「点了没切换」，那已经被覆盖了。

### 另会补充的文档

- 哪些操作会唤醒成员
- 成员卡住时的排查与恢复顺序（`recoverMember` 的几条分支各自适用什么情况）

---

## English

Thanks for this list — every item was worth chasing. We reproduced each one against `v0.2.2`
and current `master`; here is where we landed.

### Confirmed, and being fixed

| Item | What we're doing |
| --- | --- |
| **Cleared context derives its new session ID from the request ID** (4) | Confirmed. The new ID goes back to `agent-team-<uuid>`; idempotency is guaranteed elsewhere, so nothing else changes. |
| **Clicking a Member row does nothing** (part of 1) | When the session hasn't reached the client catalog yet, the open failure is swallowed silently. We'll surface the failure and roll the navigation back. |
| **`addMember` accepts an unusable route** (6) | An unregistered provider will be rejected outright instead of failing on the first turn. |
| **Empty description and English `memory.md` placeholder** (7) | Description stays optional but the UI will guide you to fill it; the template follows the interface language. |

One correction on issue 2: the failed turn **does** write a session log — the full turn and a
structured error are on disk. (An earlier reproduction reported an empty log; that came from
decoding only the first zstd frame, while this format writes one independent frame per batch.)
We initially believed the failure reason was lost across a restart; further verification showed it is not — the restart wakes the Member again, and if the route is still broken the same durable source reproduces the same diagnostic. So we are not changing anything for it.

### Semantics we're changing (this will be a breaking change)

| Item | What we're doing |
| --- | --- |
| **`sendMessage` creates a Task by default** (9) | Becomes explicit. Today Remote defaults to creating one while the model tool and the Web composer default to not — the three disagree. |
| **`updateMember` silently clears omitted fields** (10) | Becomes a true partial update; clearing takes an explicit value. |

Both affect callers that talk to the Remote directly, and both will be called out in the
version and changelog.

### Not doing right now

**A programmatic Human-side entry point (CLI / HTTP, issue 8)**: Team stays a DSH Web capability
for now, so we're not adding an entry point. We will, however, document the existing
`ctx.agentTeam` interface and mark which parts carry a stability promise — reaching for it via
`ctx.get('agentTeam')` is currently undocumented usage, and that part improves.

### Could not reproduce

**New Members all opening the same session**: creating three Members in a row through the Web UI
and clicking each one opened the correct session every time, and there's no row-index session
mapping in the code either. If you created them through the external bridge (`team-bridge`),
could you share how you called it and what the member list looked like at the time? Also, the
"click does nothing" defect above may be related — if what you actually saw was "nothing switched,"
that's already covered.

### Documentation we'll also add

- Which operations wake a Member
- A triage and recovery order for a stuck Member (what each `recoverMember` branch is for)
