# 05 independent review — 2026-11-15 Reeve

## 范围与结论

逐 hunk 读完 `9b43187..1297621` 的三笔提交（23 文件，+1370/−99），对照 05 票、Thread 裁定与现行 Host/工具/文档边界。**首轮不通过，两个行为阻断；不是对既有绿灯的重复确认。**

## 独立证据

在固定 `1297621` 的临时独立 worktree 构建并执行，避免与 Tars 的 06 实施树互抢 `lib/`：

- `npm run build`：exit 0。
- `manager-member-adjust.spec.ts` + `member-model-adoption.spec.ts`：2 文件、19 用例通过，exit 0。
- 临时探针均在运行后删除，worktree 已移除；生产源码未改。

## 阻断 1：生命周期重放驱动历史快照

场景：create → suspend（requestId A）→ resume（requestId B）→ 用 A 原样 replay suspend。

观察：账本仍 `enabled`，回执复用 A，但 Client 当前 Member `availability` 变成 `unavailable`；探针 exit 1。`suspendMemberInternal` / `resumeMemberInternal` / `archiveMemberInternal` 使用 `result.value.member` 做 converge/activate 和 status；replay 时它是历史操作快照，不是当前状态。

要求：重放只能补齐原操作欠下的效果，不能撤销后来状态。补 suspend→resume→旧 suspend、resume→suspend→旧 resume、archive 后旧 suspend 三类回归，并同时核账本、回执和当前运行态。

## 阻断 2：模型应用失败误分类且续做不 retry

对 active Member 的 `agent.model.select` 只让第一次抛错，再以相同 requestId/model patch 重放：

- 第一次正确返回 committed，但 effect 错报 `failed:capability-apply`；模型失败与能力配置失败混为一类。
- 第二次 `select` 总调用次数仍为 1；探针 exit 1。replay 时 previous 已是新模型，模型 diff 消失，未真正补齐失败的运行效果。

要求：模型与 capability 的失败分别命名、诊断对应实际阶段；同 id/model patch 重放能重试未成功的模型效果，后来模型已改变时则不得应用旧 patch。保留 capability 失败续做的既有用例。

两个探针与结果已发到 thread:eb170a83-699a-4f90-a25f-8528f94e7e5b（00:28、00:31）。修正后连同 06 的最终树再独立跑完整检查；本轮不把 Tars 的全量数字当成 Reeve 的独立证据。

## 其他已核范围

局部字段在账本队列合并、patch 重放只比较声明字段、目录变化后 update replay、recover 生命周期临界区授权、能力应用失败回执、adoption 入队、工具 schema/注册与文档均在完整 diff 中核过；除上述两项外，本轮未发现另一个已证实的行为缺陷。这里的“未另发现”不是验收通过。

## 修正后最终验收（2026-11-15）

**通过。** 逐 hunk 复核 `b29737c`、`08d9dbe`、`c48a721`，在独立 review checkout 固定最终 `c48a721` 复跑：

- 聚焦 Host/工具/模型 adoption 与原始独立探针：5 文件、108 用例通过，exit 0。生命周期三类历史重放保持当前运行态；首次模型应用失败分为 `failed:model-apply`，同 id/model patch 能续做，后续新模型不被旧 patch 覆盖。
- `npm run typecheck`：exit 0。
- `npm test`：219 文件通过、1 跳过；2837 用例通过、1 跳过，exit 0。该数包含两条临时 06 独立探针，探针未进入产品提交。
- `npm run lint`：0 error、110 个既有 warning。

Task #155 已 accept。最终浏览器车道由 Reeve 在整合 HEAD 统一执行；Tars 的同基线报告不冒充本条独立证据。Human 的真实自然语言使用按 2026-11-14 决定留到最终合并后，尚未执行。
