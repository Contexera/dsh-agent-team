# 07 验收核对

2026-10-30。01–06 已提交；06 为`05bf168`。07 工具说明、文档与确定性验收已完成，真实模型评测待授权。此文件不代表模型验收通过。

## 完成检查

- 逐项核实七工具盘点中的问题，只修改已证实的矛盾和重复说明。
- 复用真实 Session、Host、工具调用组合；不以自行拼接的 messages 数组代替实际上下文。
- F1–F6 的确定性验证与模型理解验证分别报告。
- 保持普通 Session 隔离、Human Remote、历史 ledger 重放与通知投递语义。
- 指标区分当前 surface 文本、单次新增输出、累计输出、完整模型请求；字符不是 token 或费用。
- 模型评测未获本轮配置和费用授权，不执行、不复制归档凭据。

## 已有确定性流程

以下定位已核对源码，相关测试已包含在最终全量回归中。

| 流程 | 当前测试 | 检查范围 |
| --- | --- | --- |
| F1 | `member-context-integration.spec.ts` | 分类注入、memory 修改、撤销为空、压缩与真实 Session restore、普通 Agent 无注入 |
| F2 | `thread-read-context.spec.ts` 中 discussion→board→claim | 原文、Task/Claim 分工和领取结果；普通通知无正文由通知测试补充 |
| F3 | `main-read-context.spec.ts` 中完整direct→post→read | 无重复读取即可post，不自动确认，之后read省略正文并确认 |
| F4 | `surface-rejection-recovery.spec.ts`、`activity-tool-recovery.spec.ts` | 完整变化→修改回复→提交，新增事实仍拦截，不完整拒绝不给直接写入依据 |
| F5 | `thread-read-context.spec.ts`、`main-read-context.spec.ts` | 压缩后无未读仍提供最近原文，重复read不堆副本，不新增确认 |
| F6 | `thread-read-context.spec.ts`、`main-read-context.spec.ts`、`surface-probe.spec.ts` | 长消息续读、缺段恢复、未完整消息阻止后续确认、查询不确认、restore与裁剪 |

这些测试通过 ScriptedAdapter 固定模型行为，证明接口和状态条件，不能证明真实模型理解或行动正确。

## 评测工具限制

归档 `team-tools-model-eval/harness/live-eval.mts` 第177–220行自行维护 `messages`，直接执行 `tool.execute` 和 `tool.output.render`，没有真实 Session 的 call/result provenance 或 presentationMeta。它能测参数形状，不能直接用于01–06的完整事实识别与压缩恢复验收。

后续复用其合成场景和指标分类，但执行应使用既有 `realHarness` 与真实 Agent loop。无需复制一套工具循环或修改 Harness。评测模型配置必须在运行前由 Human 确认。

原 `harness/context-volume.mjs` 自动扫描个人日志，现已移除，由 `context-volume.mts` 显式读取合成Session快照。`context-scenarios.spec.ts` 使用真实Agent loop串联F3/F5/F6并导出检查点，脚本区分输入文件、Session、当前surface、累计文本、分类注入、分段绑定及每次GenerateOptions。实现及命令见[harness说明](../harness/README.md)，历史研究数字不改。

## 07 核实结果

- 已从模型schema、结果转换和渲染删除 v1 `undeliveredMentions`，保留Host历史ledger receipt/replay；旧结果字段不再触发邀请Human的误导。
- reply ref设置开关不存在，双语文档已删除；当前v2回复父Message作者会投递，包括Human，回复自己不新增自身收件人，显式mention仍正常投递。
- Thread地址与Main地址互斥；同Thread双ref可共存。message需要threadRef，不能只给taskRef；同时给taskRef仍经orientation查询检查同Thread。加强异Thread输入后真实测试纠正了主线程和审查者先前“额外taskRef被忽略”的错误判断，不修改既有行为。
- recovery registry仅统一有恢复路径的措辞；没有下一步时不编造建议，普通错误不一概描述成不确定。
- DM body明确@mentions不会增加收件人或通知Human；保留已记录未送达的真实结果与禁止盲重发说明。
- 只有读者自己在该Thread Task上的active Claim阻止Thread unfollow；他人Claim和Main stream unfollow不受此限制，已有真实Host测试。
- persona保留跨工具写作规则，工具保留选择/调用合同，参数保留格式/动作适用范围，结果保留本次状态与恢复，core skill保留详细方法。不恢复工具参数中已删除的重复写作提示，也不让基本调用依赖先读教程。

## 当前量测

2026-10-30重跑既有合成Member场景，与基线deaa671对比：memory修改单次新增8242→355个UTF-16代码单元；ownership修改8301→154。初始分类包装8242→8455，压缩后恢复8301→8514。没有变化的步骤均无新注入。

这些是固定合成输入的字符数；当前surface与单次新增分别记录，未测token、真实请求费用或真实模型目标完成率。原始输出在`.scratch/local/agent-context-implementation/context-scenario-notification.json`。

07组合快照已跑通：1个Session、10个检查点、16次ScriptedAdapter请求；长消息返回2段且查询期间未读保持1，显式read后为0。F3显式read后累计文本与surface均4566；压缩后累计4605而surface87，证明脚本没有把日志历史当当前上下文。后续恢复和分段均记录在`context-volume-current.json`。数值受合成临时路径等影响；realHarness测试preset没有完整发布persona，不能当生产请求总长度、费用或跨版本收益结论。

边界检查：无输入明确失败，不扫描默认目录；重复传同一个导出文件报告2个输入文件、1个Session，不误把文件数当Session数。脚本TypeScript检查通过。F1–F6与重放/隔离相关组合9files/73tests通过，日志`flows-f1-f6-guidance.log`。

## 最终检查

- 全量回归：134files/1525tests通过，1原有跳过，日志`full-guidance-ready.log`。
- 类型和lint通过；本工作项改动文件无新warning，既有warnings保留。docs/core-skills/comments/boundaries/facades/versions通过，core skill7814/7850。
- Host/tools使用最新源码构建；真实Session组合场景和显式量测重跑通过。未改变Client、Remote、manifest或Web组装，本票未重复browser与全量Web build。
- 独立审查完成。最终补强的异Thread双ref测试揭示并修正一处共同误判，证明仅测试同Thread合法输入不足以判断额外参数是否被忽略。
- 验收期间两次全量失败分别为过时shipping文案断言、core skill稳定规则原文漂移；另一次窄测失败纠正message双ref说明，均已修正并复跑。详细日志与处理见实施记录。
- 尚未执行真实模型调用、模型质量重复样本、真实token/费用比较；需要本轮模型配置与费用授权。07整体保持in-progress，不归档。
