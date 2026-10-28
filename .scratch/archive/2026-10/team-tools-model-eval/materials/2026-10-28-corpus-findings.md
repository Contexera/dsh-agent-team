# 语料盘点（2026-10-28，第一层：离线回放语料）

脚本：`harness/team-tools-shape-corpus.mjs`（可复跑；输出在 `.scratch/local/team-tools-model-eval/`）。
口径：全量枚举 `~/.dsh/sessions` 下 824 份 `*.jsonl.zstd`（多帧 zstd 用 `zstd -dc` CLI 解，rollover 前代不漏），只认 `tool/call`（`data.name` 以 `team_` 开头）与其 `tool/result`（按 `data.message.toolCallId` 配对）。判据链与「扫 session log 必踩坑」笔记一致：空结果≠没发生、命中≠是那个东西。

## 总量

| 指标 | 值 |
| --- | --- |
| team 工具调用 | **7,239** |
| 成功 | 6,771 |
| 业务拒绝（`Not committed — …`，`isError:false`） | 223 |
| 抛错（`isError:true`） | 245 |
| 摩擦合计 | **468（6.5%）** |
| 不同参数形状 | **159** |
| 出现过的模型 | **20 个**（队伍换过很多模型，摩擦史是跨模型累积的） |

## 拒绝原因分布（前 18，共 30 种）

| 次数 | 原因 | 性质 |
| --- | --- | --- |
| 186 | `unread_required` | **设计门**（先读再写） |
| 35 | `stale_revision` | **设计门** |
| 43 | `invalid arguments`（zod 生成） | 传参习惯 |
| 28+26+25 | 未分类抛错（归类正则粗，见下） | 待细拆 |
| 22 | `read does not accept history arguments` | 10-13 已修（文案+读忽略页大小） |
| 18 | `reply requires threadRef…` | 传参习惯 |
| 18 | `reply target … is not a recorded Message` | 传参习惯 |
| 17 | `workspace is required when participating in multiple…` | 传参习惯 |
| 10 | `claim mutation requires a positive baseRevision` | 传参习惯 |
| 6 | `read takes no beforeSequence or limit` | 10-13 已修 |
| 6 | `done needs a taskRef` | 传参习惯 |

**约 221/468 是设计门（unread/stale），约 247 是传参习惯类**——后者才是评测要压的数。

## 按形状的拒绝集中点（回放门的种子）

- `team_message reply` 四形状合计 **268** 次拒绝（占全部拒绝 57%）：主流形状 `[baseRevision,body,threadRef,workspace]` 1296 次调用被拒 116——**主体是 unread_required 设计门**，不是缺陷。
- `team_thread read` 74 次：含 10-13 已修的页大小形状（`limit=falsy` 等）。
- `team_claim` 三动作 54 次：`list` 不带 taskRef、`claim`/`done` 的 baseRevision。
- **空串/零值填充习惯的实证**：`[beforeSequence=falsy,limit=falsy,messageRef=empty,projectRef=empty,taskRef=empty,threadRef=set]` 这种「把口袋填满」形状出现 9 次、9 次全被拒（10-27 归一化修复的目标形状）。

## 边界（读数前必须知道）

- **⚠ 按模型归因已按轮次重跑（10-28 10:57）**：本文件初版的「gpt-6.1-sol 样本仅 31 次」是错的——回收/rollover 的 session 文件混有多成员多模型的轮次，按文件第一个 model 事件贴标签会把大多数调用贴错。按轮次归因后 gpt-6.1-sol 是 **78 次调用 / 49 次非 ok**（三个标签：`codex/`、`workbuddy-ai/`、裸名），与 10-27 人工核的 49 一致。修正后的逐日全景（含 10-28 全绿）见 live-eval-findings 的「纠正」节。
- thrown 归类正则是粗的（`Error: ` 后抓小写词），28+26+25 是未分类桶；回放门建成后按 shape 细拆，不按当前正则下结论。
- 「已修」指的是 10-13/10-27 的源码修改；**源码绿≠线上生效**（构建产物 + 成员进程加载），语料里的旧拒绝发生在修复前。
