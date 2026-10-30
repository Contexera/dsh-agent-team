# 设计依据与小范围核对

核对日期：2026-10-20。本文是审查设计材料，不是全仓质量报告。

## 1. 顶尖专家还会做什么

### 先检查题目的前提

800 行和 200 字符是可执行的维护预算，不是上下文窗口的精确容量，也不是代码好坏的证明。专家会检查：文件职责是否集中、入口是否好找、一次真实修改需要理解多少跨文件约束。为了达标把实现切成许多转发文件，可能让维护更困难。

搜索直觉也不能完全转成名字黑名单。局部循环变量与公开领域名称承担不同责任；`index.ts` 是常规入口，`@contexera/dsh-agent-team/types` 是本仓库已经存在的公开子路径。只有出现具体搜索歧义、误导调用或修改遗漏，才有改名依据。

### 检查检查工具本身

脚本存在、package script 调用、CI 实际执行、分支保护强制通过，是四件不同的事。pre-commit 只提供早反馈，不能取代服务端检查。专家会用合法和非法的输入验证检查器，核对是否漏检、误报、跳过文件、可通过抬高基线掩盖退化。

### 先确定独立于实现的正确答案

当前代码定义现有行为，却不自动证明行为正确。测试期望应来自调用方契约、用户可观察行为、已有缺陷复现或匹配版本的 Harness 契约，而不是复制被测函数的计算。若产品要求不明确，先记录歧义，不擅自把某个实现选择判为错误。

### 用因果实验，不用数字替代结论

选少量高风险路径，先让基线通过，再只改实现注入一种真实错误，观察测试是否因预期断言失败，最后还原复跑。编译失败、基础设施超时、不执行到变异点，都不能算业务测试成功识错。一个变异存活也不自动证明测试无效：需要区分等价变异、不可达输入与真实漏检。

### 量化处理成本，允许保留现状

评估拆分、改名或新增检查时，比较能消除的具体风险和新增维护成本。公开 API 的更名必须计入调用方迁移；不为满足字面阈值破坏稳定入口。检查器用语法结构能正确处理的问题，优先复用现有 TypeScript 能力，而不是再写一个模糊正则。尚未证明有收益的规则不强制入 CI。

## 2. 从哪些原始材料入手

| 材料 | 用途 | 限制 |
| --- | --- | --- |
| 固定快照的源码、真实导入与调用关系 | 确认职责、入口、运行路径和公开面 | 文档路径只作导航，不代替读取实现 |
| 原始测试断言、fixture、mock、跳过设置、Vitest 配置 | 判断测试观察了什么、遗漏什么 | 测试数量和覆盖率不能证明期望正确 |
| `package.json`、CI YAML、hook 安装配置、检查器源码 | 还原实际执行链与文件范围 | workflow 存在不等于分支保护强制 |
| 同一 revision 的实际命令输出和失败断言 | 验证检查运行、业务错误确实被观察到 | 不能混用旧日志、另一个快照的结果 |
| ledger 存储记录、operation 回执、重启后的投影、Session/tool 注册状态 | 比较对外结果与持久化事实 | 只用隔离环境和不含私人信息的输入 |
| 真实 Web profile、浏览器 console/DOM、卸载和重进后的普通 DSH 页面 | 证明组合路径工作，而非仅证明模拟件自洽 | 单张截图不能证明生命周期行为 |
| `git log/show/blame` 与对应修复 diff、Issue/PR 原文 | 找到真实故障模式、检查期望被放宽的理由 | 历史只是证据，不是现行规范；GitHub 读取优先 `gh` |
| 锁定依赖、匹配版本 Harness 源码/测试与官方文档 | 验证插件使用的扩展点与契约 | 不把最新版文档套到已锁定版本 |

已有 `docs/`、scratch 审计材料、memory 只用于定位和解释意图。怀疑的行为必须回到源码、实际输入输出和原始历史核对。

## 3. 具体方法与工具

- **固定证据版本**：`git rev-parse`、`git status`、binary diff 哈希、lockfile 和相关 untracked 文件内容哈希；实验在包含同一快照的隔离副本中执行。仅从 HEAD 创建的 worktree 不包含当前未提交改动，不能直接当作当前工作区。
- **全量机械盘点**：`git ls-files -z` 加 Node/Python，分开统计生产代码、测试、脚本、声明、生成物和 vendor；记录物理行数、最长行和超过 200 字符的行。不能用压行或移入排除目录改善指标。
- **搜索与修改路径实验**：从真实维护任务的自然语言描述开始，用 `rg` 和 TypeScript 符号/导入关系找入口、实现和测试。让不知答案的 reader 记录首次搜索词、误命中和必须理解的文件；一个样本只能证明一次观察，不声称普遍优越。
- **基于风险的路径抽样**：优先持久化/重放/幂等与权限、普通 Session 与 Team preset 隔离、Remote/slot 进入退出与恢复。每条路径做完“要求—实现—断言—反例”后才扩展，不做按目录均分的泛读。
- **定向变异与故障注入**：现有 Vitest CLI、一次性实现 patch、临时 storage adapter、可控制的异步完成顺序。StrykerJS 仅在证明与当前 Vitest/构建兼容且值得成本后采用，不先增加依赖或追求全仓分数。
- **检查器正负对照**：临时 fixture 树覆盖阈值边界、已有超限基线、不合法跨包导入、允许的类型导入、合法领域名称等。真实 CLI 的退出码和定位信息才算证据，复制正则到 REPL 不等于测了检查器。
- **执行链核对**：`gh run view`/`gh api` 只读查看真实运行与 branch protection/rulesets；权限不足明确记录。不得为了测试触发规则推送 master、修改保护或创建 PR。
- **真实组合验证**：只有选中的 Client/装配结论需要时运行 `npm run test:browser`。按维护文档使用临时 profile，检查 desktop/390×844、键盘焦点、loading/error/empty 与普通 DSH 恢复；不触碰真实资料或相邻 Harness 的已有工作。

## 4. 什么能独立支撑结果

| 结论 | 可独立复查的证据 | 不能替代它的东西 |
| --- | --- | --- |
| 文件确实超限 | 固定快照、扫描规则、全量清单、可复跑计数 | 目测、只列最大的几个文件 |
| 名称/拆分影响维护 | 真实任务、盲查记录、调用关系、可比的前后操作记录 | 个人偏好、命名黑名单、行数下降 |
| 测试可以识别指定错误 | 独立期望来源、green→注入→目标断言 red→还原 green、实现和测试哈希 | 覆盖率、测试总数、编译失败、改期望凑绿 |
| 检查器能约束规则 | 合法样本通过、非法样本失败、稳定退出码与定位 | 脚本文件存在、说明文档声称覆盖 |
| CI 是合并门 | 实际 run 的 job/step 与适用分支的 required checks/rulesets | workflow 名称、PR 页面显示绿色 |
| 插件在产品中工作 | 匹配版本的真实 profile、持久化结果、浏览器操作和恢复证据 | 仅模拟服务、仅截图、仅单测 |

另一位 agent 的反驳只能帮助发现证据漏洞，不能代替上述实验。有限测试无法证明“没有所有未知缺陷”；报告必须写明已检验命题与未覆盖范围。

## 当前仓库的小范围事实

### 快照和环境

- Team HEAD：`001f8f1f00fea518ba95cfea24370f97e0b2f1f6`。
- 盘点时已有 tracked diff 的 SHA-256：`32b73b7dffe806ecc76df3448a6490d921ef9541aa43bcdaa0e781f9a9603bc2`。此值不包含 untracked 内容，正式审查不能仅靠它固定完整快照。
- 相邻 Harness HEAD：`687f282e8625c6b8d11ff58211a90524be2e4317`，tag `dsh-v0.2.1-rc.2`。相邻仓库还有 untracked 内容，未触碰。
- Node `v24.15.0`，pnpm `11.7.0`。
- Nowledge Mem 状态检查返回 HTTP 502；此次未能读取历史记忆，没有因此推断历史决策。

### 机械盘点

范围：`git ls-files packages scripts` 中当前工作区存在的 TS/TSX/JS/MJS/CJS/MTS/CTS/CSS 文件。按 `splitlines()` 计算物理行（含空行与注释），按 Unicode code point 数量计算字符；测试文件在 tests 组，`scripts/team-ui.e2e.ts` 在 scripts 组。只统计 tracked 路径，不代表所有未跟踪文件。

| 分类 | 文件数 | 超过 800 行的文件数 | 超过 200 字符的行数 |
| --- | ---: | ---: | ---: |
| 生产代码（含 CSS） | 103 | 7 | 207 |
| 测试 | 90 | 5 | 311 |
| 脚本 | 28 | 1 | 42 |
| 声明文件 | 4 | 0 | 0 |
| 已跟踪 vendor 文件 | 3 | 0 | 0 |

代表文件：`packages/agent-team/src/ledger.ts` 4,762 行；Host `src/index.ts` 4,003 行；`scripts/team-ui.e2e.ts` 3,865 行；`packages/agent-team/tests/member-lifecycle.spec.ts` 5,506 行。以上是定位信号，不是拆分建议。

### 检查执行链

主 agent 已复读 `package.json`、`.github/workflows/ci.yml` 与边界检查实现：

- CI 两个 job 在 Linux/Windows 上都执行安装、build、facade 生成、typecheck、`npm test`。不能简化成“CI 只跑类型与测试”。
- `npm test` 串联 Typert 生成、facades/docs/core-skills/boundaries/versions/comments 检查和 Vitest。
- 当前 workflow 未执行 `lint`、`duplication`、`test:browser`、`check:artifact`、`check:public-baseline`；browser 是明确保留的本地验收。是否该改变，需要结合失效场景和成本证明。
- master 的 docs-only push 存在 `paths-ignore`；PR 触发未配置该过滤。不能把 master 的跳过推断为文档 PR 不跑检查。
- 本地 `core.hooksPath` 无配置，`.git/hooks` 没有非 sample hook，scout 未找到 hook 安装机制。此事实不代表服务端也没有合并门。
- 尚未读取 GitHub required checks 或实际 run，因此不声称 CI “不可绕过”。

### 优先验证路径

| 路径 | 已定位的源码/测试 | 后续要验证的命题 |
| --- | --- | --- |
| 持久化、重放和幂等 | `packages/agent-team/src/index.ts`、`ledger.ts`；`loader-composition.spec.ts`、`operation-protocol.spec.ts`、`storage-sqlite-compat.spec.ts` | 重试不产生额外 durable effect；失败边界与重启后的记录/回执一致；权限拒绝无副作用 |
| Team preset 隔离 | `cordis.patch.yml`、`member-runtime.ts`；`member-tool-policy.spec.ts` | Team 行为不泄漏到普通 Session，兄弟 Member 配置不互相影响 |
| Client 注册与恢复 | `packages/client-agent-team/src/client/index.ts`；`slots.client.spec.ts`、`scripts/team-ui.e2e.ts` | Remote 延迟或失败可观察；重复进入退出与卸载后普通 DSH 正常恢复 |

scout 提到边界检查可能漏掉 re-export/side-effect import 等形式。主 agent 复读源码确认正则仅处理部分 import 语法，但本轮没有对真实 CLI 做完整 fixture 验证，也没有评估该遗漏的实际危害，因此只保留为待验证命题。不要把 scout 对其“已明确排除”的解释当事实：脚本注释并未明确说明这些语法形态被排除。

## 本轮没有完成的工作

没有运行完整测试、变异实验、浏览器流程、GitHub 强制检查核对或全仓审查；没有安装工具、修改 CI/hooks、提交或推送。两个 scout 返回的是有限范围的定位信息，不是完整审计背书。
