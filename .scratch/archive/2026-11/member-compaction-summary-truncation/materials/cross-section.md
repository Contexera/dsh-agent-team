# 横向量：这个现象到底有多少人、多少模型中过（11-06 扫描）

## 口径（数怎么来的）

- **数据面**：`~/.dsh/sessions/*/*/session.v4.jsonl.zstd` 全部 **330 个会话文件**（本机所有工作区），用 `zstd -dc` 解多帧（Node `zstdDecompress` 只解第一帧，会静默漏读）。保留窗口 **09-24 → 11-06 09:39**；更早的会话可能已被清理，所以「09-24 起没有别人中」不等于「历史上只有这些」。
- **判据**：只认事件 `{"type":"compaction/end","data":{"error":…}}` 且 `error` 含 `summarization truncated`。不数正文里转述的报错串——会话日志里大量转录会让它虚高（含该串的文件 12 个，有真事件的只有 4 个）。
- **归属**：成员用同文件 `session/title`（这 4 个文件各只有一个 title，没有多成员混写）；模型用失败前最近一个 `request/header.config.model`（不用 `model/selection`，那不是路由）。
- **同窗口另有 15 条其他压缩失败**（配额 402、上下文超窗、reasoning effort 不支持、流中断、aborted），已排除，不混进本表。
- **复跑**：`materials/scan-compaction-history.py`（约 25 s，输出与下表逐行一致）。

## 结果：15 次，4 个成员，2 个模型

| 成员 | 截断次数 | 模型 | 时间窗 | 后果 |
| --- | --- | --- | --- | --- |
| Tome | 5 | `magpie/workbuddy/hy4free` | 11-04 16:15–16:37（另有 16:37 一次手动 `/compact` 失败） | **卡死约 1.8 h**，17:58 重试才写成（走道 241,332 token） |
| Aster | 1 | `magpie/workbuddy/hy4free` | 11-05 14:24–14:26（`turn=null`：轮次结束后的自动压缩） | 没挡下一轮；但同一会话 12:38 / 14:22 两次成功已贴上限（15,950 / 11,957） |
| Ferry | 1 | `magpie/auto/step-5-preview` | 11-05 21:22–21:25（turn 6） | 那一轮失败，21:37 重试成功（输出 12,252） |
| Cole | 8 | `magpie/workbuddy/hy4free` | 11-05 21:36–22:28（turn 2/3/4/6 + 手动 `/compact`；另有 1 次 aborted） | **卡死约 1.6 h**，23:13 换成 deepseek 后一次成功 |

- 15 次失败每次都是硬生成 **150–340 s** 后才报错（**合计约 58 分钟**），且是失败闭合：没有「写了一半也能用」的降级。
- Tome 那次（11-04）就是 `.scratch/local` 整理那场会话；Aster 那次是非 admission 路径，所以没锁住他。
- 「卡死」判定：失败发生在 admission（`turn=N`）⇒ 该轮在发出请求前就失败；下一轮重复。Cole 的 6 次里 4 次是 admission，2 次手动。

## 为什么偏偏是 hy4free：上限 × 输出预算

成功摘要的实测（`usage.outputTokens`，**含 reasoning**；输入是 `shadowedTokenCount`）：

| 模型 | 输入 token | 上限 | 输出 token | 其中 reasoning 文本 | 结果 |
| --- | --- | --- | --- | --- | --- |
| hy4free | 241,017 | 16,384 | **15,950** | 46,600 字符 | ok（贴上限） |
| hy4free | 241,209 | 16,384 | **11,957** | 24,429 字符 | ok |
| hy4free | 241,332 | 16,384 | **12,032** | 27,594 字符 | ok |
| hy4free | 265,826（Cole 会话重放） | 16,384 | **16,384** | 16,384（正文 0 字） | **length → 失败** |
| hy4free | 265,826（同上，11-06 复测） | 65,536 | 18,804 | 11,423 | ok，326 s（**32K 就够**） |
| step-5-preview | 230,970 | 16,384 | **12,252** | 35,339 字符 | ok（贴上限） |
| step-5-preview | 140,608–243,853 | 16,384 | 2,533–5,846 | — | ok（多数远低于上限） |
| deepseek-v4.1-flash | 229,009–285,624 | 16,384 | 2,293–3,078 | — | ok |
| deepseek-v4.1-flash | 511,920（凑量重放，指示性） | 16,384 | 5,756 | — | ok |

⇒ 三个模型同一个 16K 上限：deepseek 有 5 倍余量；step-5-preview 偶发贴顶；hy4free 在 24 万输入时就在 12–16K 之间掷骰子，26.5 万输入必超。**所以「16K 太小」是错的，「上限与模型思考量不匹配」才是对的**，全局抬上限会把大多数模型的摘要成本一起抬上去。

## 现在的风险面（11-06 09:39）

- 成员最新 header：Cole / Tome / Ferry / Iris / Tars / Vera / Gardener 已是 `magpie/auto/deepseek-v4.1-flash`；Reeve 是 `auto/kimi-k3.1-pro`；**Aster 仍是 `workbuddy/hy4free`**（唯一还在危险模型上的活跃成员）。Momo 是 `gpt-6-astra`，Terra 是 `step-5-preview`，但都久未活跃。
- 09:28 有 4 个成员被 wake-recycle 换代（Vera / Iris / Aster / Tome），Aster 的新会话上下文是干净的、模型没换——**下次长到 ~24 万还会贴顶**。
- 阈值读数：web-dev 配置文件现在写 `memberCompaction.tokens: 300000`，落盘时间 11-06 09:31:50（昨晚是 512,000）。**未确认**这是不是 Human 今早改的；若不是，说明有第二个写者，要查。

## 阈值读数（11-06 更正）

- Human 已确认：**300K 是他 11-05 自己设定的**（不是迁移回退，也不是我没找到的写者）。11-06 09:28 重启后 Host 从盘上加载的就是 300K，09:31:50 的设置布局迁移只是把同一份值重写了一遍。
- 影响：比默认 256K 高、比昨晚口径里的 512K 低。Cole 当前 ~28.5 万，离 300K 只剩 1.5 万；他模型已是 deepseek-flash，真触发也写得出摘要。Aster 仍挂 hy4free，下次长到 ~24 万仍会贴 16K 上限。
- 结论：**不是设置持久化缺陷**，这条疑点关闭；「临时措施」现在的形状是 300K（不是 512K）。
