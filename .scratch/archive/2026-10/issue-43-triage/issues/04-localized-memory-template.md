# 04 — 私有记忆模板的语言，需要先定一件事

**What to build:** 把 issue 7 中「`memory.md` 模板是英文占位」这一半解决掉。但怎么做，取决于下面这个尚未定的前提。

**Blocked by:** None — Operator 选定做法 A
**Status:** complete

## 挡在这里的问题

模板是 **Host 侧**写的（`initializePrivateMemory`，`packages/agent-team/src/member-runtime.ts`，
`writeFile` 加 `wx`）。而界面语言是 **Client 侧**按浏览器语言判定的
（`packages/client/locale/src/client/index.ts` 的 `detectBrowserLocale`，读 `navigator.language`）。

调研没找到 Host 侧可读的界面语言来源：Harness 里没有成文的
`uiLanguage` / `interfaceLanguage` 服务，`navigator.language` 在 Node 下又会报
宿主机器自身的语言。所以「Host 直接按界面语言挑模板」这条路目前走不通，
除非让 Client 把语言传下来——那是新增 Remote 参数，属于契约改动。

## 两种做法

**做法 A（推荐）：模板语言中性化**
把 `- <what this Member owns, and does not own>` 这类英文散文，改成语言中性的结构标记
（标题仍可读，占位用尖括号形式本来就不是给人类读的完整句子）。
成本最低，不涉及跨端契约，也不是「传语言」这种半吊子方案。
模型本身是多语的，它会按成员实际使用的语言去填。

**做法 B：Client 把界面语言传给 Host**
`addMember` 增加可选语言提示，Host 据此挑模板。
成本：新增 Remote 字段（契约改动）；且同一 DSH home 里成员由不同语言的会话创建时，
模板会不一致。

倾向 A：中文化这条抱怨的本质是「中文界面里出现英文散文」，而模板本来就是骨架 + 占位，
不是面向终端用户的成品文案。去掉英文散文即可解决观感，不必为此引入语言传递。

## 无论选哪个都做

- [x] Client 创建表单：`agentDescriptionPlaceholder` 从「留空则暂无描述」改成举例引导
- [x] 中英文 locale 都改
- [x] 已存在的 `memory.md` 不动（`wx` 语义保持；用 suspend/resume 往返验证）
- [x] 测试：骨架是结构标记而非英文散文；已有文件不被后续激活覆盖
- [x] CHANGELOG `Unreleased` 记一条

**做法 A 的落地形态**（`member-runtime.ts:352`）：
`## Identity and role` / `## Durable rules` / `## In hand` / `## Notes index` 四个标题保留，
把尖括号里的英文散文句换成短结构标签 `<scope>` / `<rule>` / `<work in hand>`，
首行只留一句指向 `member-memory-manager` skill 的指引（详细规则都在 skill 里，模板不重复）。
`notes/<cluster>/README.md` 那行是路径约定，保留。

注：这里说的「语言中性」= 去掉英文散文句、只留结构标签；标题与标签本身仍是英文，
这与 ticket 的「标题仍可读」一致。memory.md 不进 UI（`privateMemoryPath` 在传给前端时被 `Omit` 掉），
读者是模型。

## 报告中要纠正的一点

「空描述 = 成员没有人设」**不成立**。每次 pre-step 都注入 `renderMemberIdentity()`，
加上私有记忆、Workspace 列表、时间上下文，以及 preset 里那段很长的 `persona` 前缀。
空描述只是少了半句职责描述。所以 description 保持可选，本 ticket 只做引导，不做必填。
