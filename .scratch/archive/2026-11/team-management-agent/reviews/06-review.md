# 06 independent review — 2026-11-15 Reeve

## 首轮范围

逐 hunk 读完 `1297621..346c767` 三笔提交：Project/owner Host 与账本入口、两个工具、九工具 preset、555 行新 Host/工具测试、真实 Web journey，以及全部中英维护文档。最终 verdict 等 05/06 修正提交和独立复跑后给出。

## 独立探针

在 Reeve 创建的临时 worktree 固定 `346c767`，独立 install/link/build 成功；临时 `manager-project-review-probe.spec.ts` 两条均红，证明的是已提交树而非作者自报：

1. **显式空责任被拒。** `project_owner update` 传 `responsibility: ''`，工具先把空串归一为 absent，Host 再拒绝缺少新责任；这与工具描述及 README 所写“显式空串清空”相矛盾。`clearResponsibility: true` 是另一条可用路径，但不能据此让已声明参数失效。
2. **旧 Project patch 重放答历史快照。** rename A → description B → archive C → replay A，账本无倒退，原 receipt 保留，但答案仍为 `original goal / active`，不是当前 `later goal / archived`。这会误导结果未知后的续做。

证据与修正要求已写入 06 Thread 的 message:b91a4f2c-007f-4105-8907-f5dc97c3fe87。临时探针保留在隔离 review worktree，最终树上原样复跑；不把当前未提交 WIP 当作交付证据。

## 文档待修（不另列行为阻断）

- `tools-and-preset` 的 cleanup warning 后一句写成 manager “不会去重试一次已经发生的归档”，容易误导未知结果后的续做；持久归档不能再用新 requestId 重做，但同一 requestId 的原样 replay 正是当前实现补齐私有清理的入口。最终稿要把它改成这个准确语义。
- 同页仍概括 manager 增加“非空 owner responsibility”，与 update 可显式清空的最终契约不齐；随本轮文档修订收窄到 add。

## 其他已核范围

- 局部 Project 字段在账本串行段内读最新记录并合并，replay 只比较原 patch 声明字段。
- owner update 走独立追加操作，不是 remove+add；remove 的任务归属仍由 Host 的 v3 participation 规则决定。
- archive 的 Claim/Attention/Task 与订阅清理由既有 Host/账本路径承担，manager 把提交后的 cleanup failure 作为 committed warning 报告。
- 新写入口在账本串行段内重检当前 manager；普通 Session/Member 不获得这些工具。
- 最终还需核：05 生命周期和模型应用修复、上述两项回归、完整 05/06 测试与统一全量门禁。此处不提前写成通过。

## 修正后最终验收（2026-11-15）

**通过。** 在独立 review checkout 固定 `c48a721`，原样复跑上述两条临时探针，并连同 05 的聚焦测试一起验证：5 文件、108 用例通过，exit 0。

- `project_owner update` 的显式 `responsibility: ''` 现在能清空责任；其他 action 的空白字段仍按既有输入契约处理。
- rename → description → archive → 旧 rename replay 保留原回执且返回当前 Project 状态，不把历史 description/state 当作现状。
- `b29737c`/`08d9dbe` 已修正上述文档歧义；`c48a721` 修正浏览器断言中的不存在 matcher。

独立全量证据：`npm run typecheck` exit 0；`npm test` 219 文件通过、1 跳过，2837 用例通过、1 跳过（含两条未提交的产品树外探针）；`npm run lint` 0 error、110 个既有 warning。Task #156 已 accept。最终浏览器车道留到整合 HEAD 由 Reeve 统一复跑；Human 实际使用尚未执行，不以工程验收代替。
