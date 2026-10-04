# jev 真机实测：门控的判断质量与端到端行为

**目的**：补上 ticket 03 唯一没做的实测——jev 判"继续""那个呢？"这类回指的能力；顺带用真 jev 驱一次**已交付**的 `ContextPressurePolicy.onPreStep`，验证请求形状、deadline、分类与投出的指令。

**环境（2026-10-04）**：key 由 human 在 Thread 里给，只在命令行 env（`TYPESAFE_API_KEY`）传入，**没有落盘**；脚本与结果文件在 `dsh-plugins/packages/jev/artifacts/gate-probe/`（`artifacts/` 已 gitignore，且文件里没有 key）。模型 `/systemone` 自报 `jev-1.13.0`。探测脚本用 `attempts: 1`：门控自带 5s deadline，重试对它是不可见的，所以量单次原始延迟。请求形状照 `pressure.ts` 抄：`state.recent_user_input`（最近 5 条、各截 2000 字符）+ `state.current_input`（截 2000 字符），`questions.related = { type: 'noul', instructions: GATE_QUESTION, criteria }`。

## 一、判断质量（20 次真实调用）

| 形状 | 样本 | noul | 门控判定 |
| --- | --- | --- | --- |
| 回指 | 「继续」 | 0.93 / 0.93 / 0.93（3 次） | related → 不换代 |
| 回指 | 「刚才说的还没弄完吧」 | 0.95 | related |
| 回指 | 「继续，顺便把 changeset 也更新了」 | 0.93 | related |
| 回指（跨语言） | 「go on」/ 英文上文 +「continue」 | 0.93 / 0.94 | related |
| **回指（票面点名）** | **「那个呢？」** | **0.53 / 0.55 / 0.52（3 次）** | **undecidable → 不换代** |
| 新工作 | 「nginx 的 TLS 证书配置」 | 0.04 / 0.04 / 0.04 | unrelated → 扣住换代 |
| 新工作 | 「订一张明天去上海的高铁票」 | 0.02 | unrelated |
| 新工作 | 「写个 Python 批量转 webp 的脚本」 | 0.04 | unrelated |
| 裸应答 | 「嗯」/「好的」 | 0.77 / 0.91 | related |
| 裸应答 | 「？」 | 0.42 | undecidable（离 0.4 阈值只差 0.02） |
| 指代悬空 | 「那个 PR 呢？」（上文无 PR） | 0.55 | undecidable |
| 边缘 | 上文为空 +「继续」 | 0.45 | undecidable（没有误扣） |

**延迟**：min 279 / median 320 / max 579 ms；20 次全部远低于 5s deadline（约 9× 余量）。**用量**：每次 input 346–457 tokens、output 20 tokens。

## 二、已交付策略 + 真 jev（`ContextPressurePolicy.onPreStep`）

| 场景 | 决策 | 耗时 | 记录 |
| --- | --- | --- | --- |
| 150K + 31min +「继续」（related 0.93） | `continue` | 533ms | 记一条 related |
| 150K + 31min +「nginx TLS」（unrelated 0.04） | **`hold`** | 287ms | 投 1 条换代指令 + 记一条 |
| 150K + 31min +「那个呢？」（带内 0.54） | `continue` | 292ms | 记一条"没settle" |
| judge 抛错 | `continue` | ~0ms | 记一条"没答" |
| judge 永不返回 ×3 | `continue` | **5001 / 5004 / 5001ms** | 引擎自己的 deadline 兜住 |
| 用量 100K（<128K） | `continue` | 0ms | judge 根本没调 |
| 间隔 1min（<30min） | `continue` | 0ms | judge 根本没调 |
| 不装 judge | `continue` | 1ms | 门控整条不启用 |

**投出的指令原文（实测，截取）**：

> Context pressure: 150000 tokens are still in context after 31 minutes away, and the request below does not continue your recent work. **Held request, delivered into the next generation: 帮我看一下 nginx 的 TLS 证书配置，快过期了** Write a handoff covering your objective, …

即：换代方案唯一必须补的"引用扣住输入的原文"在真路径上确实带上了。

## 三、结论

1. **5s deadline 不是风险点**：真机 p100 = 579ms。但引擎侧最坏仍会给**某一步的起动**加 5s（judge 挂住时，实测 3 次都在 5.0s 收口；更早一次跑到 7055ms，当时 load 0.06，未复现，原因不明）。
2. **判据可用**：明确回指 ≥0.93，新工作 ≤0.04，稳定可复现（重复 3 次的样本方差 ≤0.03）。
3. **带（0.4–0.6）不是稀有角落**：「那个呢？」稳定落在 0.52–0.55，「？」0.42。带内 = 不换代，是安全方向；但**票面点名的「那个呢？」拿不到这条 remedy**。
4. 「？」离 0.4 只差 0.02：模型版本一变可能翻到 unrelated，翻面后它会被扣住并触发一次换代。当前不做处理，留作观察项。
5. 要让「那个呢？」这类也换代，只能动阈值（如 0.6→0.5）或改问法；本轮**不改**，维持保守。
