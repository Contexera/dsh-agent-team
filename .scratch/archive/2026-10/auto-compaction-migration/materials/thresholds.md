# 阈值测量：`auto: true` 在每条真实路由上的触发点与对齐方案

Task #117 · 测量人 @Vera · 2026-10-20 · 供 Reeve 的迁移调研引用
方法：读源码公式 + 读 profile 里每条路由的 `contextWindow`/`maxTokens`，逐条算。**未跑运行时**，是静态算术（公式有源码行号可核）。

## 0. 结论先行

1. **`auto: true` 单独打开，在 22 条路由里有 19 条等于"几乎不压缩"**（触发点在 55 万–84 万 token），因为默认 `thresholdRatio = 0.8`。
2. **现状是"封顶"策略，引擎是"比例"策略，两者形状不同**，不是调一个数就能对齐：现状 `handoffAt = min(200K, hardLimit-8K)`，引擎 `threshold = window × ratio`。窗口越大偏离越大。
3. **单靠一个全局 `thresholdRatio` 无法复现现状**：`0.2` 在大窗口上正好、在 20 万窗口上提前 4 倍触发；`0.8` 反之。**必须走 `modelPolicies` 按路由配**。
4. **20 万窗口那条路由（`opencode-zen-free/...-free`）在物理上限上就到不了 20 万**：`maxTokens=32000` + `headroom=65536` ⇒ `pressureBudget = 200000-32000-65536 = 102,464`，触发点被容量封死。这类路由只能接受更早触发，或调整 `headroomTokens`。

## 1. 引擎的触发公式（已核源码）

`packages/compaction/compaction-basic/src/config.ts`：

```
resolveCompactSpec(policy, contextWindow, reservedCompletionTokens)   // :153
  messageBudget    = contextWindow - reservedCompletionTokens         // :172
  pressureBudget   = messageBudget - headroomTokens                   // :181
  thresholdTokens  = floor(min(contextWindow * thresholdRatio, pressureBudget))   // :190
  retainTokens     = floor(messageBudget * retainRatio)               // :194
```

默认值（全部已核）：
| 参数 | 默认 | 位置 |
|---|---|---|
| `thresholdRatio` | `0.8` | `config.ts:20` |
| `retainRatio` | `0.16` | `config.ts:23` |
| `headroomTokens` | `65_536` | `config.ts:77` |
| `maxTokens` | `= headroomTokens` (即 65536) | `config.ts:78` |
| `compactionRetries` / `maxOverflowRetries` | `1` / `1` | `:108-109` |
| **`auto`** | **`true`** | `:110` |

- `reservedCompletionTokens` = **该路由的 `maxTokens`**（`index.ts:65-67`：`agent.session.requestHeader()?.config.maxTokens`，回退 adapter 默认，再回退 0）⇒ 下面按 profile 里各路由声明的 `maxTokens` 算。
- **`auto` 默认本来就是 `true`**；是 Team preset 显式写了 `auto: false`（`cordis.patch.yml:191-193`）。
- **引擎没有第二道低于 `thresholdTokens` 的硬限**（`grep hardLimit` 在 compaction-basic `src/` 无命中）⇒ 触发完全由 `thresholdTokens` 决定。

## 2. 现状 Team 策略（对照组）

`packages/agent-team/src/index.ts:2384`：
```
hardLimit = min(256_000, window - 16_000)     // CONTEXT_HARD_LIMIT_CAP / SAFE_OUTPUT_RESERVE
handoffAt = min(200_000, hardLimit - 8_000)   // CONTEXT_HANDOFF_AT_CAP / HANDOFF_RESERVE
```
**这是"封顶"语义：窗口再大，也在 20 万提醒、25.6 万硬限。**

## 3. 逐条路由：默认值下的触发点

`ratio=0.8, headroom=65536, retainRatio=0.16`，`trigger@` 是首次自动压缩的 token 数。

| 路由 | window | maxTokens | **trigger@** | retain | 相对现 200K |
|---|---:|---:|---:|---:|---:|
| claude-opus-5 | 1,000,000 | 128,000 | **800,000** | 139,520 | +600,000 |
| claude-opus-4-8 | 1,000,000 | 128,000 | **800,000** | 139,520 | +600,000 |
| 52-claude/claude-opus-5-5 | 1,000,000 | 128,000 | **800,000** | 139,520 | +600,000 |
| justdowork/claude-opus-4-8 | 1,000,000 | 128,000 | **800,000** | 139,520 | +600,000 |
| **auto/deepseek-v4.1-flash ← Team 默认路由** | 1,000,000 | 128,000 | **800,000** | 139,520 | +600,000 |
| glm-5.3 / auto/glm-5.3 / auto/glm-5.3-flash / volcengine/glm-5.3 | 1,000,000 | 131,072 | 800,000 | 139,028 | +600,000 |
| auto/step-5-preview | 1,000,000 | 64,000 | 800,000 | 149,760 | +600,000 |
| deepseek-v4-flash | 1,000,000 | 256,000 | 678,464 | 119,040 | +478,464 |
| auto/gpt-6.1-sol | 922,000 | 128,000 | 728,464 | 127,040 | +528,464 |
| gpt-6-astra / group/kimi / volcengine/kimi-k3 / muse-spark-1.3-contributor | 1,048,576 | 131,072 | 838,860 | 146,800 | +638,860 |
| deepseek-v4.1-flash | 1,000,000 | 384,000 | 550,464 | 98,560 | +350,464 |
| volcengine/deepseek-v4.1-flash | 1,048,576 | 384,000 | 599,040 | 106,332 | +399,040 |
| gpt-5.6-sol / gpt-6.1-sol / gpt-6-astra(272K) | 272,000 | 128,000 | **78,464** | 23,040 | **−121,536** |
| opencode-zen-free/deepseek-v4.1-flash-free | 200,000 | 32,000 | **102,464** | 26,880 | **−97,536** |

**两类偏差方向相反**：大窗口路由迟到 3–4 倍；窄窗口路由（27.2 万、20 万）反而**比现在更早触发**（`0.8` 相对小窗口已经不低）。
⇒ **"开自动就安全"和"开自动会很激进"都不对，取决于路由。一刀切必然两头都错。**

## 4. 对齐现役 200K 需要什么

反解 `window × ratio = 200,000`（并检查容量是否够）：

| 路由族 | window | 需要的 `thresholdRatio` | 说明 |
|---|---:|---:|---|
| 1,000,000 窗口族（14 条） | 1,000,000 | **0.2000** | 正好 20% |
| 1,048,576 窗口族 | 1,048,576 | **0.1907** | |
| 922,000（auto/gpt-6.1-sol） | 922,000 | **0.2169** | |
| 272,000 族 | 272,000 | **物理不可达** | 容量上限 78,464 < 200K |
| 200,000 族 | 200,000 | **物理不可达** | 容量上限 102,464 < 200K |

**物理不可达的两族**：`pressureBudget = window - maxTokens - 65536` 已经把上限压死了。要让 27.2 万窗口触发在 20 万，得把 `headroomTokens` 降到几乎 0 或降 `maxTokens`——**但这会削减输出预算，不是纯配置调整，需单独决策**。
现实选择：这两族**接受更早触发**（27.2 万在 78K 触发，20 万在 102K 触发），或按你自己的判断配。

## 5. 推荐的 `modelPolicies` 草案

`modelPolicies` 按 **`provider` + `model` 精确匹配**（`config.ts:120-146`，`policy.provider === target.provider && policy.model === target.model`），所以每条要写全两段。**`provider` 段需按实际路由的 provider id 填**（上表只给了 model 名，provider 见 profile 各段）。

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    auto: true
    # 全局默认：对齐现役 200K（大窗口族的公共解）
    thresholdRatio: 0.2
    headroomTokens: 65536
    retainRatio: 0.16
    modelPolicies:
      # ── 1M 窗口族：0.2 正好 200K ──
      - provider: <p>            # 例：magpie
        model: auto/deepseek-v4.1-flash
        thresholdRatio: 0.2
      - provider: <p>
        model: claude-opus-5
        thresholdRatio: 0.2
      # …其余 1M 族同值，可省略（继承全局）

      # ── 1,048,576 族：0.1907 ──
      - provider: <p>
        model: volcengine/deepseek-v4.1-flash
        thresholdRatio: 0.1907

      # ── 922K ──
      - provider: <p>
        model: auto/gpt-6.1-sol
        thresholdRatio: 0.2169

      # ── 272K / 200K 族：物理不可达 200K，显式认领更早触发 ──
      - provider: <p>
        model: gpt-5.6-sol
        thresholdRatio: 0.29    # ≈78.9K 触发，留出余量；或按需调
      - provider: <p>
        model: opencode-zen-free/deepseek-v4.1-flash-free
        thresholdRatio: 0.51    # ≈102K 触发（已接近容量上限）
```

**关键提醒**：`retainRatio 0.16` 在大窗口上意味着**压缩后保留 14 万 token 原文**（`messageBudget × 0.16`）。阈值降到 20 万后，"压完剩 14 万"意味着**每次只压掉约 6 万**——可能频繁触发。若希望压一次管久些，`retainRatio` 要同步下调（例如 0.08 ⇒ 保留约 7.4 万，压掉约 12.6 万）。**这两个参数要一起看，不能只调阈值。**

## 6. 验证状态：数字已用真实引擎代码复算过

**以下不是手算** —— 我临时写了一个 vitest 探针，直接 import 引擎的 `resolveConfig` / `resolveTargetPolicy` / `resolveCompactSpec` 跑出真实值，跑完已删除（`git status` 确认探针无残留）：

```
ENGINE DEFAULT auto = true
thresholdRatio = 0.8   headroom = 65536   retainRatio = 0.16

auto/deepseek-v4.1-flash  win= 1000000  trigger= 800000  retain=139520
deepseek-v4.1-flash       win= 1000000  trigger= 550464  retain= 98560
volcengine/dsv4.1         win= 1048576  trigger= 599040  retain=106332
gpt-5.6-sol               win=  272000  trigger=  78464  retain= 23040
opencode-zen-free         win=  200000  trigger= 102464  retain= 26880
Tests 1 passed
```

⇒ 与本文表格逐项一致；**`auto` 的引擎默认值确实是 `true`** 也已由代码确认（`resolveConfig({}).auto === true`），不是从源码注释推的。
另：Harness 自己的测试 `compaction-basic.spec.ts:435` 有参考值 `[1_000_000, 256_000, 678_464, 119_040]`，与本文 `deepseek-v4-flash` 一行完全吻合——**两个独立来源互证**。

## 7. 仍未验的部分（说清楚边界）

- **provider id 未填**：table 只有 model 名；`modelPolicies` 要 `provider` + `model` 两段精确匹配，实际 provider 需从 profile 各路由段确认。**我没猜。**
- **未跑端到端触发**：我验的是"给定 window/maxTokens，引擎算出多少阈值"（纯函数，已复算），**没有**在真实会话里跑到 20 万 token 看它真的触发、以及 `reservedCompletionTokens` 是否真取到路由的 `maxTokens`（这点我是从 `index.ts:65-67` 读的，未实测）。要确认：跑一次真实会话，看日志有没有 `compaction (step pressure): shadowed ...`。
- **未评估能力影响**：阈值从 80 万拉到 20 万，模型可用上下文缩到 1/4——这对长任务的实际影响**我没有任何测量**，是产品判断，不属我的测量范围。

## 8. 一句话给决策者

**只把 `auto` 改成 `true` 不解决问题，反而在主力路由上把兜底推迟到 80 万 token。必须同时显式配 `thresholdRatio`（大窗口族约 `0.2`）并按路由分族配；27.2 万和 20 万两族受输出预算封顶，到不了 20 万，只能接受更早触发或单独决策。**
