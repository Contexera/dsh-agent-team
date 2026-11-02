# Holon 的 Webhook 事件订阅实现

- 对象：`holon-run/holon`，main 分支，`Cargo.toml` 版本 0.57.0
- 源码位置：本地快照 `/tmp/holon-src`（codeload tar 包解压）
- 结论先行：Holon 不订阅 GitHub webhook，也不校验 GitHub 签名。它给每个 agent 签发一个 capability URL 作为入站通道，真正的订阅、过滤、签名校验在外部中间层完成。

## 1. 设计定位

Holon 把外部事件处理拆成三层：

| 层 | 责任 | 归属 |
|---|---|---|
| 订阅层 | 接收 GitHub / CI / 设备上报的 webhook，验签、过滤、去重、重试 | 外部系统，例如 AgentInbox、UXC、自建转发服务 |
| 入站层 | 校验 capability token，把投递归一化成内部消息 | Holon |
| 等待与恢复层 | 记录 agent 在等什么，事件到达后只恢复对应的工作 | Holon |

`docs/rfcs/external-trigger-capability.md` 把这种设计称为 providerless ingress：Holon 不需要理解 GitHub、Slack、CI 的 payload 结构，只需要知道"某个 agent 的入站能力被使用了"。

因此 `WaitFor{ wake: "external", resource: "github:owner/repo#123" }` 里的 resource 只是一个稳定标识，不产生任何订阅动作。

## 2. 端到端链路

```
GitHub ──webhook──> 中间层（AgentInbox / UXC / 自建转发）
                        │  验签、按 repo/PR/CI 过滤
                        │  POST {callback_base_url}/api/callbacks/wake/{token}
                        ▼
                 Holon HTTP ingress（无 Bearer，token 即凭据）
                        │ sha256(token) → external_triggers 中 status=active 的记录
                        │ 校验 agent 状态、路径模式与记录模式一致
                        ▼
                 submit_wake_hint：Triggered / Coalesced / Ignored
                        ▼
                 MessageKind::SystemTick + metadata.wake_hint
                        ▼
                 匹配 WaitSource::ExternalIngress{external_trigger_id}
                        ▼
                 agent 醒来，自行查询真实数据（gh pr view / CI 状态）
```

关键点：推送只是提示，真实状态由 agent 醒来后主动拉取。这就是文档里反复强调的"收到回调不等于工作完成"。

## 3. 能力对象与 token

### 3.1 每个 agent 一条默认 ingress

`src/runtime/callback.rs:38` `ensure_default_external_ingress`：

- 一个 agent 只有一条 active 的 `ExternalTriggerRecord`，模式固定 `wake_hint`
- 幂等：已存在则直接返回现有能力，不新签 URL
- `create_callback` / `create_external_trigger` 等兼容工具名最终都落到这里，传进来的 delivery_mode 被忽略

记录结构见 `src/types.rs:3416`：

| 字段 | 含义 |
|---|---|
| `external_trigger_id` | 触发器标识 |
| `target_agent_id` | 目标 agent |
| `delivery_mode` | 实际固定为 `wake_hint` |
| `token` | 明文 token，仅用于拼接 URL 时读取 |
| `token_hash` | SHA-256，数据库查询用这个 |
| `status` | `active` / `revoked` |
| `delivery_count`、`last_delivered_at` | 投递统计 |

### 3.2 token 的生成与存储

`src/callbacks.rs`：

```rust
generate_callback_token()  // capability_id("cb")
hash_callback_token()      // SHA-256 hex
build_callback_url()       // {base}/api/callbacks/{wake|enqueue}/{token}
```

- 查询只按 `token_hash` 走，`active_by_token_hash` 同时过滤 `status = 'active'`（`src/runtime_db/repositories.rs:2265`）
- 明文 token 只出现在两处：拼给 agent 的 URL、`reset-callback` 接口返回值
- agent 的 prompt context 会带上该 URL，并附带"这是 capability secret，不要复述、不要提交仓库"的说明（`src/context/mod.rs:1366` `render_default_external_ingress`）
- 命令行子任务会额外拿到环境变量 `HOLON_EXTERNAL_TRIGGER_URL`（`src/runtime/command_task.rs:959`）

### 3.3 轮换与撤销

| 操作 | 入口 | 行为 |
|---|---|---|
| 轮换 | `POST /api/control/agents/{id}/reset-callback`（需 control token） | 原子撤销旧记录并签发新 token，旧 URL 立即失效 |
| 撤销 | agent 工具 `CancelExternalTrigger` | 按 `external_trigger_id` 置为 revoked |
| 停 agent | `src/runtime/lifecycle.rs:426` | 停止时自动撤销该 agent 全部触发器 |

`src/runtime/callback.rs:204` `reset_external_trigger` 是轮换实现，`reset_default_for_agent` 在同一事务里完成撤销与新建。

## 4. HTTP 入站

### 4.1 路由

`src/http/mod.rs:851` 起：

```
POST /api/callbacks/wake/{callback_token}      256 KB body limit
POST /api/callbacks/enqueue/{callback_token}   256 KB body limit
POST /api/webhooks/generic/{agent_id}          另一条路：Bearer + 公开入站
```

wake/enqueue 两条路由没有 `Authorization` 头要求，token 是唯一凭据。

### 4.2 校验顺序

`src/http/ingress.rs:3` `callback_ingress`：

1. 解析 body，失败返回 400
2. `sha256(token)` 查 active 记录，查不到返回 403 `invalid callback token`
3. 读取 agent 身份记录，状态不是 Active 返回 403
4. 路径模式与记录 `delivery_mode` 不一致返回 403 `callback delivery mode mismatch`
5. 调用 `deliver_external_callback`，失败统一返回 403 `forbidden`

错误信息不区分"token 不存在"和"token 已撤销"，避免探测。

### 4.3 payload 归一化

`src/http/ingress.rs:112` `parse_callback_body`：

| Content-Type | 内部表示 |
|---|---|
| `application/json`、`*+json` | `MessageBody::Json` |
| `text/*` | `MessageBody::Text` |
| 其它 | `{content_type, body_base64}` |
| 无 Content-Type | 能 UTF-8 解码则 Text，否则 base64 包装 |

空 body 合法，纯唤醒不需要内容。Holon 不解析任何 provider 字段。

## 5. 投递语义：电平触发与合并

`src/runtime/waiting.rs:1602` `submit_wake_hint` 按 agent 状态分流：

| agent 状态 | disposition | 行为 |
|---|---|---|
| `Stopped` | `Ignored` | 无副作用，不排队 |
| `AwakeRunning` / `AwaitingTask` | `Coalesced` | 覆盖 `pending_wake_hint`，只保留最新一条 |
| `Booting` / `AwakeIdle` / `Asleep` 且队列为空 | `Triggered` | 立即生成 SystemTick |
| `Booting` / `AwakeIdle` / `Asleep` 且队列非空 | `Coalesced` | 等队列排空后再处理 |

这是电平触发而非队列触发：连续投递 100 次，agent 忙时最终只处理一次。官方博客中"34,876 次投递合并成 23,551 个 turn"即该机制的结果。

写入 `pending_wake_hint` 后立即持久化 agent state，重启后会通过 `emit_recovered_pending_wake_hint`（`src/runtime.rs:7691`）补发一次。

## 6. 从投递到具体工作

### 6.1 生成 SystemTick

`src/runtime/scheduler_continuation.rs:992` `emit_system_tick_from_wake_hint`：

```
kind            SystemTick
origin          System { subsystem: "wake_hint" }
authority       RuntimeInstruction
admission       RuntimeSystem / RuntimeOwned
body            "wake hint: {reason}"
metadata        wake_hint { idempotency_key, reason, source, scope,
                            external_trigger_id, work_item_id, resource,
                            body, content_type, correlation_id, causation_id }
```

发送前先过调度器决策（`src/runtime/scheduler.rs`）。`idempotency_key` 由 `external_trigger_id` 加微秒时间戳组成（`src/runtime/scheduler.rs:1653`），用于重启恢复时抑制重复 tick，不是通用的 HTTP 重放防护。

`reason` 的来源（`src/runtime/callback.rs` `callback_wake_reason`）：文本 body 取原文，JSON body 序列化后截断到 160 字符，空 body 用固定文案 `external trigger fired`。

### 6.2 关联到 wait

- 注册侧：`WaitFor{ wake: "external" }` 会读取当前 agent 的默认 trigger，把 `WakeSource::ExternalIngress{ external_trigger_id }` 写进等待记录（`src/runtime/waiting.rs:555`）
- 匹配侧：`src/wake_contract.rs:176` `matching_wake_source` 按 `external_trigger_id` 精确匹配，不按 work item 或 source 名称模糊匹配
- 绑定侧：`emit_system_tick_from_wake_hint` 发现该 trigger 恰好对应一个未完成的外部等待时，把 `wait_id` 写入 `source_refs`，从而只解除那一个等待
- 兜底：`recheck_after_ms` 到期后由 runtime 自行重新检查，避免事件丢失导致永久挂起

匹配成功后只解除等待和阻塞，不会自动完成任务，也不会把 payload 当成业务结论。

### 6.3 模型看到的内容

`src/context/mod.rs:2795` `render_wake_hint_context` 渲染为：

```
## continuation_context
Continuation context:
 - Trigger kind: system_tick
 - Continuation class: resume_expected_wait
 - Wake hint:
- Source: agentinbox
- Scope: agent
- External trigger id: trig_...
- Description: ...
- Resource: interest/pr-reviews
- Reason: github inbox updated
- Content-Type: application/json
- Payload:
{ ... }
```

同时标注 `current_input is a runtime system-tick continuation, not a trusted operator request`。

注意：官方文档 `docs/website/concepts/events-and-waits.md` 写的是"wake_hint 的 payload 不作为 model-visible message 投递"，但当前实现会把 payload 渲染进上下文（快照见 `tests/prompt_context_snapshots.rs:1086`）。两者差异在于"不作为独立排队消息"与"完全不可见"的表述，阅读文档时需以代码为准。

## 7. 权限与安全边界

| 维度 | 处理 |
|---|---|
| 认证 | capability URL 本身是 bearer 凭据，不叠加签名或 Bearer token |
| 权限等级 | `AuthorityClass::IntegrationSignal`，`AdmissionContext::ExternalTriggerCapability`，不构成 operator 指令 |
| 作用域 | 一条记录对应一个 agent，无广播、无按 source 分区的路由 |
| agent 已停止 | 停止时触发器已被撤销，旧 URL 投递直接 403 |
| 日志 | 访问日志把 `/api/callbacks/.../<token>` 脱敏为 `<redacted>`（`src/http/mod.rs:1677`） |
| 审计 | 记录 `external_trigger_created` / `external_trigger_revoked` / `callback_delivered` / `wake_hint_triggered|coalesced|ignored` |
| 体积 | 单次 body 上限 256 KB |

## 8. 已实现但需注意的行为

1. **`enqueue_message` 模式实际已退役。** `ensure_default_external_ingress` 强制返回 `wake_hint`；`deliver_callback` 把历史 enqueue 记录映射成 wake_hint 并写审计字段 `deprecated_enqueue_message_mapped_to_wake_hint`。文档仍并列两种模式，实际以 `wake_hint` 为准。
2. **没有 provider 侧签名校验。** GitHub 的 `X-Hub-Signature-256` 不会被 Holon 验证，持有 URL 即可投递。生产环境需要把 URL 当密钥管理，或在中间层完成验签。
3. **一个 agent 只有一个 ingress。** 不要按 PR、按 CI run 轮换 trigger；等待粒度靠 wait 记录而不是 trigger 记录。
4. **`holonbot/` 目录与这套机制无关。** 那是仓库自用的 Probot GitHub App（Vercel 部署），用于仓库管理，不参与 agent 事件订阅。
5. **`POST /api/webhooks/generic/{agent_id}` 是另一条路。** 它需要 Bearer 鉴权，把 payload 作为 `WebhookEvent` 直接入队，不经过 capability token，也不合并。

## 9. 接入方式

### 9.1 使用现成中间层（推荐）

让 agent 用 `agentinbox` skill 配置订阅：skill 读取 agent 上下文里的默认 ingress URL，在 AgentInbox 侧注册仓库或 PR 兴趣，GitHub 事件由 AgentInbox 转发到该 URL。

### 9.2 自建转发

```
GitHub App / repo webhook
  → 你的服务：验签、按 repo/PR/CI 过滤、去重
  → POST {callback_base_url}/api/callbacks/wake/{token}
  → 返回 200 {"ok":true,"result":{...}} 表示已受理
```

拿到 URL 的方式：

```bash
curl -X POST "$BASE/api/control/agents/$AGENT/reset-callback" \
  -H "Authorization: Bearer $HOLON_CONTROL_TOKEN"
```

注意 `reset-callback` 会撤销旧 URL，只在首次配置或主动轮换时使用。

### 9.3 事件侧配套

agent 需要在收到事件前登记等待，否则唤醒只会产生一次空闲 tick：

```json
{
  "wake": "external",
  "resource": "github:owner/repo#123",
  "reason": "Recheck CI for the recorded commit before reporting acceptance",
  "recheck_after_ms": 600000,
  "delivery": "final"
}
```

## 10. 参考文件

| 主题 | 路径 |
|---|---|
| 设计动机与边界 | `docs/rfcs/external-trigger-capability.md` |
| 使用指南 | `docs/website/guides/connect-external-events.md` |
| 契约参考 | `docs/website/reference/events-and-timers.md` |
| HTTP 入口 | `src/http/ingress.rs` |
| 路由注册 | `src/http/mod.rs:851` |
| token 与 URL | `src/callbacks.rs` |
| 能力生命周期 | `src/runtime/callback.rs` |
| 投递状态机 | `src/runtime/waiting.rs:1602` |
| tick 生成 | `src/runtime/scheduler_continuation.rs:992` |
| 等待匹配 | `src/wake_contract.rs:176` |
| 上下文渲染 | `src/context/mod.rs:1366`、`src/context/mod.rs:2795` |
| 存储查询 | `src/runtime_db/repositories.rs:2265` |
