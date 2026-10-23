# Team Member 组合边界调研与长期方案

日期：2026-10-23

归档说明：用户最终确认本轮只拦截未声明工具，不拦截其他插件注入的 prompt，不修改上游。本文中的近期补充与长期方案均为未实施的候选建议，不构成本轮剩余工作或后续实施授权。

调研基线：本仓库 `0645983`；DSH `deepseek-harness` release `0.2.1-rc.2`，源码基线为 `687f282e86`。DSH 源码在本次环境中位于 `/tmp/agent-tmp/deepseek-harness`，该路径不是项目交付物。

## 结论

DSH **支持自定义 Agent preset**：preset 可以声明一组 plugin rows；这些 rows 可以注册自己的 prompt sections、prompt contexts、tools、skills 和其他运行能力。因此，`team-member` 现在采用的“显式 preset + Team 自己的 persona/tools”方向是正确的。

但 DSH 当前的 preset **不是封闭的 Agent model-surface，也不是 Plugin sandbox**：

- preset 的 `plugins` 列表控制 preset 自己挂载的 composition，不会阻止 Host 上其他 Plugin 继续运行；
- `agent.ctx` 仍处于 Host 的普通服务与事件体系中，其他 Plugin 可以在 `agent/created` 中向该 Agent 的 own scope 注册工具或 prompt；
- `tools.restrict()` 只过滤继承工具，不过滤 Agent own scope；
- `systemPrompt.assemble()` 之后，Agent loop 还会通过 `refreshContext()` 恢复 required contexts，因此 Team 在 assemble 阶段删掉的 required prompt 不能保证最终请求中消失；
- `complete: true` 只能约束最终 prompt sections，不能隔离 required contexts、tools、Plugin listeners 或 Plugin 内部状态。

所以，用户当前的核心判断成立：**仅凭当前公开 preset、prompt 和 tool API，不能实现“Member 的 prompt/tools 完全由所选 preset 决定，其他 Plugin 完全不能追加”的封闭边界。**

长期建议不是再堆一层 Team 专用过滤，而是向 DSH 提出一个窄范围的 **closed model-surface composition（封闭模型面组合）**：只封闭 Member 最终可见的 prompt、tools 和执行入口，不把它扩展成通用 Plugin 隔离框架。Host services 仍可通过显式依赖提供给 preset rows；普通 DSH Session 继续使用原有默认 preset 和 Plugin 配置。

## 1. 需求拆解

这里需要分开四个边界，不应统称为“Plugin isolation”：

| 边界 | 用户真正需要的结果 | 当前 DSH |
| --- | --- | --- |
| Preset roster | Member 只选中 `team-member` 的 rows；普通 Session 不选中 Team rows | 支持 |
| Prompt surface | 最终发送给 Member 的 sections、contexts、variables 由该 preset 决定 | 不完整 |
| Tool surface | 模型看到的 schema、lookup、direct/nested execution 与 preset 一致 | 只有部分公开能力；Team 当前用 bundle 补偿 |
| Plugin runtime | 其他 Plugin 的 service、listener、模块状态和副作用都不进入 Member | 不支持；当前需求也不应默认扩大到这里 |

必须把第三行和第四行分开。当前需求主要是前两项中的 prompt/tools；如果以后要求阻止任意 Plugin 的 listener、副作用或内部状态，则那是新的运行域问题，不能用 preset YAML 或 tool allow-list 解决。

## 2. DSH 当前已经支持什么

### 2.1 Preset 可以自定义 Plugin 列表

上游 `@deepseek-ai/dsh-agent-preset-registry` 文档把 preset 定义为：通过声明式 preset 选择 Agent 的 tools、prompt sections 和 skills；一个进程可以运行多套 composition。最小配置就是一个 registry 加一个 `@deepseek-ai/dsh-agent-preset` row，`config.plugins` 是该 preset 的 Plugin entry list。

来源：

- `packages/preset/agent-preset-registry/README.md:1-12,28-48`
- `packages/preset/agent-preset-registry/src/index.ts:77-120`

本仓库的 `cordis.patch.yml:24-197` 已经利用了这一能力，`team-member` 里面显式列出 persona、coding tools、Team tools、Member context、web 和 compaction。普通 Session 的 default preset 不会自动得到这些 rows。

### 2.2 Preset 可以提供 scoped prompt

`@deepseek-ai/dsh-persona` 是一个 scope-only Plugin。它在挂载 context 的 scope 注册 persona prefix/suffix；同名 scoped section 会 shadow global section。它还支持 `complete: true`，使该 persona 成为最终唯一的 prompt section。

来源：

- `packages/preset/persona/src/index.ts:1-15,29-45,56-75`
- `packages/core/system-prompt/src/index.ts:470-521,604-688`
- `packages/core/system-prompt/tests/system-prompt.spec.ts:242-270,497-523`

因此，“Team 有自己的 persona”是 DSH 已经支持的能力，不需要复制 DSH agent loop。

### 2.3 Preset 可以提供 scoped tools

Preset Plugin 在 preset scope 注册的工具会成为 Agent 的 ancestor-layer 工具。Agent scope 可以通过 `tools.restrict()` 缩小继承面；多个 restriction 取交集。

来源：

- `packages/preset/agent-preset-registry/src/index.ts:250-317`
- `packages/core/tools/src/index.ts:1098-1132,1164-1227`
- `docs/subsystems/tools.md:163-182`

但这里有一个关键限制：`tools.restrict()` 的语义是“过滤继承的 global/ancestor tools”，不是“封闭当前 Agent 的全部 tools”。Agent 自己注册的 tools 在 `view()` 中无条件进入 visible layer。

### 2.4 Preset 不是安全沙箱或独立 Plugin realm

上游 preset registry 的维护文档明确说明：Preset 不是 security sandbox；YAML 和 Plugin 仍能执行 Host code。文档还明确区分了 preset scope 与普通 Agent context：entry-local `isolate` 不会自动传递到 `agent.ctx`，普通 Context lookup 仍选择 Host realm。

来源：

- `packages/preset/agent-preset-registry/README.md:50-60,95-99`
- `packages/core/scope/src/index.ts:32-39,129-146`

这解释了为什么“把官方 Plugin 放在 Host、把 Team rows 放在 preset”仍不能自动阻止官方 Plugin 的 `agent/created` listener。

## 3. 当前污染链路

### 3.1 工具污染：own layer 不受 restriction

DSH 的工具视图大致是：

```text
global + preset ancestor tools
        │
        ├─ tools.restrict() 可以过滤
        │
Agent own tools
        │
        └─ 不受当前 scope restriction 过滤，直接进入 visible
```

上游源码的注释直接说明 restriction “never what its OWN layer registers”。官方 experimental Team tool Plugin 就是在 `agent/created` 中取得 `agent.ctx`，再向这个 own layer 注册 9 个工具。

来源：

- `packages/core/tools/src/index.ts:1164-1227`
- `packages/experimental/tool-agent-team/src/index.ts:167-192,410-431`
- 本仓库 `.scratch/archive/2026-10/member-tool-surface-control/REPORT.md:19-64,77-87`

`0645983` 的三层补偿——预先绑定 preset tool definitions、过滤 `system-prompt/assemble` 的 request schemas、用 `tools.guard()` 拒绝 direct/nested execution——正好针对这条链路。它解决的是“最终模型请求和执行”的边界，不改变 DSH own-layer 的底层语义。

### 3.2 Prompt 污染：assemble 不是最终 runtime context

DSH 的实际流程是：

```text
systemPrompt.assemble()
        │
        ├─ system-prompt/assemble waterfall
        │
        ▼
agent/pre-step 保存 assembly
        │
        ▼
step() 调 refreshContext(assembly)
        │
        ├─ 恢复当前 registry 中缺失的 required contexts
        │
        ▼
renderContextSections() → runtime context message → LLM request
```

上游 `SystemPrompt.assemble()` 的返回值虽然是 waterfall 后的权威 assembly，但 `refreshContext()` 会根据当前 scope registry 重新解析 contexts，并把缺失的 required entries 补回去。官方 `team:identity` 正是 `required: true` 的 context。

来源：

- `packages/core/system-prompt/src/index.ts:572-601,604-688`
- `packages/experimental/tool-agent-team/src/index.ts:173-188`
- `packages/core/agent-loop/src/agent.ts:267-288,400-434`

因此，Team 在 `system-prompt/assemble` 中删除 `team:identity`，不能证明最终模型请求不再包含它。`complete: true` 只在最终 sections 上生效；它不删除 required contexts。

### 3.3 `agent/request` 不能作为最终 prompt 过滤器

`agent/request` 的公开类型是 `({ turn, step, signal }) => LlmCallConfig`。它用于选择或调整 provider/model 等 LLM config，发生在 prompt admission 之前，但没有 PromptAssembly 或 messages 参数。

来源：

- `packages/core/agent/src/runtime-types.ts:325-337`
- `packages/core/agent-loop/src/agent.ts:563-612`

所以把 prompt 清理放进 `agent/request` 不是可靠方案；它既不能改变已构建的 system prompt，也不能阻止后续 `refreshContext()` 补回 required context。

## 4. 为什么几个直觉方案不够

### 4.1 仅使用 `complete: true`

能解决：其他 Plugin 的普通 prompt sections 不再出现在最终 sections。

不能解决：

- required `team:identity` 仍可由 `refreshContext()` 恢复；
- tool providers 仍会参与 assembly；
- Plugin listener、service 和模块状态仍在运行；
- direct/nested execution 仍需要单独的 policy。

结论：`complete: true` 是 persona 选项，不是 Member composition boundary。

### 4.2 使用 `suppressRuntimeContext()`

它只抑制 optional runtime contexts；上游 `refreshContext()` 对 required context 仍保留。官方 `team:identity` 标记为 required，因此不能靠这个 API 删除。

来源：

- `packages/core/system-prompt/src/index.ts:525-536,582-601,681-687`

### 4.3 用同名 placeholder 抢占官方 prompt/tool

同一 scope 内的同名 section 或 tool 注册会直接抛错。官方 Plugin 的安装在 `agent/created` 期间失败，失败继续向上游传播，最终可能导致 Member Agent 创建回滚。

来源：

- `packages/core/system-prompt/src/index.ts:402-416`
- `packages/core/tools/src/index.ts:746-750`
- 本仓库 `.scratch/archive/2026-10/member-tool-surface-control/REPORT.md:111-119`

这会把“提示污染”变成“Member 无法激活”，不符合需求。

### 4.4 只使用 `tools.guard()`

Guard 是执行时的单调拒绝，可以防止官方工具 body 运行；但 `tools.schemas()` 和 `systemPrompt` assembly 不查 guard，因此模型仍会看到 schema。当前提交必须同时保留 request filter 和 execution guard。

来源：

- `packages/core/tools/src/index.ts:724-732,1134-1162,1500-1538`

### 4.5 继续依赖 preset 的 `isolate`

`cordis:group` 的 isolate 能隔离指定 service realm，但不改变 `agent.ctx` 的 Host Context lookup，也不阻止 Host Plugin 监听 Agent 生命周期。它不适合被当作“其他 Plugin 不会进入 Member”的证明。

来源：

- `packages/preset/agent-preset-registry/README.md:56-60`
- 本仓库 `cordis.patch.yml:1-18`

## 5. 对当前 Team 实现的判断

### 已经正确的部分

1. `team-member` 是显式 opt-in preset，普通 DSH 对话没有 Team tools 或 Team persona。
2. `0645983` 把工具策略从“有 allow-list 才限制”改成“每个 Member 默认限制为 preset baseline”，符合需求。
3. Host-global tool、迟到 own-scope tool、同名替换已经分别有 request filter 和 execution guard。
4. 暂停、恢复、Host restart、能力更新和普通 Agent 的现有行为不应被官方 experimental Team Plugin 的存在阻断。
5. 移除“发现官方 Team prompt 就拒绝运行”是正确的：它只是把一个未解决的兼容问题变成了 Member activation failure。

对应来源：

- 本仓库 `packages/agent-team/src/member-runtime.ts:95-161`
- 本仓库 `packages/agent-team/tests/member-tool-policy.spec.ts`
- 本仓库 `.scratch/archive/2026-10/member-tool-surface-control/spec.md:6-30`

### 仍然不满足的部分

1. 官方 `team:policy` 和 `team:identity` 仍可能进入 Member 最终 context。
2. 任意其他 Plugin 的 prompt contributions 没有 owner/allow-list 约束。
3. `working_directory` 仍是 preset 之外的显式特例。它是有意保留的产品能力，但严格说不满足“所有工具都由 preset 声明”。
4. `member-runtime.ts` 通过 scope parent 与 `ToolDefinition` 对象身份推断 preset ownership，这不是 DSH 的正式 ownership contract。
5. 当前 guard 只保证 exact Member，不定义 delegated child Agent 的继承边界。

## 6. 推荐方案

### 6.1 现在：明确产品契约，保留当前实现

当前发布线建议把契约写成：

> `team-member` preset 提供 Team Member 的声明式基础 model surface；Team 在当前 DSH 公开 API 上对 tools 做最终请求过滤和执行拒绝。普通 Session 不继承 Team preset。其他 Plugin 的运行时 prompt contributions 尚未被 DSH 公开 API 隔离，因此与官方 experimental Team 同时启用不属于已支持组合。

这比把当前实现称为“Plugin isolation”准确，也不会把 `0645983` 的成果贬低成临时补丁。

当前不建议：

- 再加入 prompt name conflict 阻断；
- 伪造官方 `subagent/descriptor` 来绕过官方 Team membership；
- monkey-patch `SystemPrompt` 或 Agent loop；
- 为所有第三方 Plugin 建立 Team 自己的通用 deny registry；
- 在没有上游最终请求 seam 的情况下承诺“其他 Plugin 完全不能影响 Member”。

### 6.2 近期：用测试把剩余缺口固定下来

不改变产品行为的情况下补齐三类证据：

1. 在官方 Plugin 先加载、后加载两种组合中，直接记录 Member 的 `assembly.sections`、`assembly.contexts`、最终 adapter request 和 runtime context sections，明确锁定 `team:policy`/`team:identity` 当前仍可见。
2. 保留普通 Agent 的对照断言：官方工具和官方 identity 仍然只在普通 Agent 的原有配置中出现。
3. 增加一个后注册 `system-prompt/assemble` middleware 的 fixture，证明当前 Team filter 不是 Harness 保证的 final policy；如果它能重新加入内容，记录为限制而不是用更深的本地 listener 链掩盖。

这组测试的目的不是宣布泄漏可接受，而是防止未来误以为 `0645983` 已经解决了 prompt 隔离。

### 6.3 近期：消除 `working_directory` 的隐含特例

用户目标是“工具完全由选定 preset 声明”。当前 `working_directory` 是唯一明确的产品例外。优先验证把 `@deepseek-ai/dsh-tool-working-directory` 作为 `team-member` preset row 挂载是否能在实际 Web bundle 中正常工作：

- 如果可以，改为由 preset row 提供，删除 `member-runtime.ts` 对该名字的特殊 ownership 分支；
- 如果必须由 Host global 提供，则把它正式命名为一个显式 Host bridge，而不是继续把它描述成 preset 工具，并把该例外写入需求契约。

上游 tool catalog 确认 `working_directory` 有独立的 `@deepseek-ai/dsh-tool-working-directory` consumer；是否能在本 bundle 的真实安装组合中 scoped mount，需要用真实 profile/browser 组合验证，不能只凭包名判断。

来源：

- 上游 `docs/tool-catalog.md:46`
- 本仓库 `packages/agent-team/src/member-runtime.ts:119-131`
- 本仓库 `docs/team-collaboration/boundaries.md:32`

### 6.4 长期：向 DSH 增加一个窄范围的 closed model-surface composition

这不是“Plugin 完全隔离框架”，而是一个 Agent 级别的模型面契约。目标只有一个：**最终进入某个 Agent 的 prompt、tool schema 和 tool execution，必须来自该 Agent 选定的 composition，或来自显式声明的 Harness bridge。**

上游提案可以抽象成下面的伪配置。它不是当前 DSH API：

```yaml
- id: preset-team-member
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: team-member
    composition:
      modelSurface: closed
    plugins:
      - name: '@deepseek-ai/dsh-persona'
      - name: '@contexera/dsh-agent-team/tools'
      - name: '@deepseek-ai/dsh-tool-bash'
      - name: '@deepseek-ai/dsh-tool-fs'
```

这个 `closed` 需要由 DSH core 完成以下保证：

1. **Preset 是 model-facing contribution 的完整来源。**
   - preset rows 的 sections、contexts、variables、tool providers 是允许面；
   - Host global 的 model-facing contributions 默认不进入 closed Agent；
   - Agent own scope 的迟到 contributions 默认不进入 closed Agent，除非通过 preset composition 许可的注册路径添加。

2. **所有 model-facing contribution 经过同一个 composition policy。**
   - `assemble()` 和 `refreshContext()` 使用同一份 policy；
   - required context 只能从允许的 composition registry 恢复，不能把任意当前 scope registration 无条件补回；
   - tools 的 schema、lookup、direct execution、nested execution 使用同一份 policy；
   - policy 在最终请求构建前生效，后续 middleware 不能重新加入被拒绝的内容。

3. **Preset row 与 contribution 有可验证的归属。**
   - DSH 需要知道一个 section/context/tool provider 属于哪个 composition，而不能让 Team 再通过 `scopeParentOf()` 和对象身份猜测；
   - preset 内 Plugin 的合法 Agent-scoped registration 要带 composition token，Host Plugin 通过 `agent/created` 直接写入 Member scope 的注册则没有该 token；
   - 同一套归属信息同时用于诊断和最终过滤。

4. **Host services 仍然可以显式提供给 preset rows。**
   - `agents`、`sessions`、`llm`、`workingDirectory`、storage 等是运行所需的 Host services，不等于 model-facing contribution；
   - 这使 Team preset 可以正常工作，但不让 Host 上的其他 Plugin 自动把自己的 prompt/tools 注入 Member；
   - 不需要把每个 Member 变成独立进程，也不需要复制 Agent loop。

5. **普通 Session 不改变。**
   - 默认 preset 继续按现有 Plugin 配置运行；
   - 只有声明 `modelSurface: closed` 的 Agent 才采用封闭策略；
   - 非 closed Agent 继续保持当前兼容语义。

6. **resume、suspend/resume 和 child Agent 有明确语义。**
   - Session 记录 preset identity/revision 和 closed policy；
   - resume 使用同一 policy；
   - child Agent 要么继承父 composition，要么显式选择另一个 composition，不能静默回到 Host global；
   - Team 若暂时不支持 delegated child，应在 Host 层明确拒绝创建，而不是让 child scope 处于未定义状态。

这里最重要的是“最终模型面封闭”，不是“任意 Plugin 不能运行”。一个 Host Plugin 仍可能做非模型面的监听或服务工作；如果以后要阻止这些副作用，才需要另一个更重的 Agent realm 设计。

### 6.5 上游 API 应该避免的方向

不建议把需求实现成以下形式：

- 一个全局 `pluginIsolation` 大框架，试图隔离所有 Context、service、fiber、文件、网络和模块状态；
- 每个 preset 复制一套完整 Host service graph；
- 允许 Team 在运行时按名字维护所有第三方 prompt/tool 的 deny list；
- 只提供 `prompt.complete`，却不修改 `refreshContext` 和最终 tool execution policy；
- 只提供一个“最后一个 middleware”约定，但不在 DSH core 中保证它确实是最后一步。

这些方向要么超出当前需求，要么会把每个外部 Plugin 的适配成本转移到 Team bundle，最终仍不能给出闭合契约。

## 7. 方案比较

| 方案 | Prompt 隔离 | Tool 隔离 | 普通 Session | 维护成本 | 判断 |
| --- | --- | --- | --- | --- | --- |
| 继续使用 `0645983` | 否；只记录限制 | 是最终请求/执行层的本地补偿 | 保持 | 低 | 当前唯一不改上游的可交付方案 |
| Team 继续增加各种 deny/冲突/monkey-patch | 不可靠 | 逐步变成第二套 runtime policy | 有回归风险 | 高 | 不推荐 |
| 重新配置 profile，把所有 model-facing rows 移到普通 preset | 可以在受控 profile 中减少污染 | 可以减少 global tool 继承 | 保持 | 中 | 可作为运维 workaround，不能约束任意已安装 Plugin |
| DSH closed model-surface composition | 可以 | 可以，且是同一最终 policy | 保持 | 中 | 长期推荐 |
| 完整 per-Member Plugin runtime/sandbox | 可以 | 可以 | 可保持 | 很高 | 超出当前需求，暂不做 |

## 8. 推荐落地顺序

```text
现在
  保留 0645983
  ↓
  文档明确“工具面控制 ≠ 任意 Plugin 隔离”
  ↓
  补 Member prompt 泄漏的直接回归证据
  ↓
  验证 working_directory 能否成为 preset row

未来的 DSH 扩展
  ↓
  先定义 closed model-surface 的 session/Agent contract
  ↓
  为 prompt/tool contribution 增加 composition ownership
  ↓
  让 assemble + refreshContext + execute 共用最终 policy
  ↓
  用 Team、官方 experimental Team、迟到自定义 Plugin 做组合测试
  ↓
  Team bundle 迁移到上游 seam，删除本地重复过滤和 ownership 猜测
```

迁移时应删除本地补偿，而不是让 Team policy 与 DSH closed policy 长期并存。当前仓库的默认规则是一个概念一个权威来源；上游提供真正的最终 policy 后，`member-runtime.ts` 中按 scope 和对象身份推断 ownership 的代码、assembly 过滤和重复 guard 应按实际覆盖范围逐项删除或只保留必要的防御性检查。

## 9. 最终回答

对“DSH 是否支持 Plugin 完全自定义 preset，包括 prompt 与 tools”的准确回答是：

> **支持自定义 preset 的声明内容，但不支持把 preset 变成对 Host/其他 Plugin 的封闭模型运行域。** 你可以声明 preset 自己的 Plugin、prompt 和 tools；但当前公开 API 没有保证其他 Plugin 不能通过 Agent lifecycle、own scope 或 required context 把内容追加到该 Agent。`0645983` 已经把工具的最终请求和执行边界补上，但 prompt 仍缺一个 DSH core 的最终 composition policy。

因此本项目现在不应继续扩大 Team 自己的隔离代码。正确的长期方向是：

1. 当前发布线保持 `0645983` 的工具控制，并诚实标记官方 Team 混装的 prompt 限制；
2. 近期补齐可重复的 prompt 污染证据和 `working_directory` 的 preset 归属验证；
3. 后续向 DSH 提出“closed model-surface composition”，只解决 preset 对最终 prompt/tools 的封闭性，不先做通用 Plugin sandbox；
4. 上游 seam 成熟后一次迁移，删除 Team 自己猜测 Plugin ownership 的补偿层。
