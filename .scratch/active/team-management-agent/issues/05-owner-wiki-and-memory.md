# 05 — 团队管理的 wiki、记忆、笔记与 skills

**What to build:** 管理会话用内置 wiki 解释 Team 用法、成员管理和一条完整组队示例，在 DSH home 下自己的目录使用 `memory.md`、`notes/` 和可配置的 `skills/`。复用 Team 已有的目录、记忆索引和按会话发现 skills 的方式。
**Blocked by:** 01
**Status:** pending

- [ ] wiki 内容来自现行维护文档；Human 问「我该怎么开始」时，能看到从选 Workspace、建成员到创建 Project、分配 owner 的完整路径。首版不把整理其他成员的私有文件列入 wiki 验收。
- [ ] 管理会话能加载内置 wiki 和自己目录的 skill。新增或移除一个私有 skill 后，后续轮次能发现变化，不必换会话或改 preset。私有 skill 同名时不覆盖内置 skill；Member 和普通会话的目录不受影响。
- [ ] `memory.md` 只作参考，验证可重放、16 KiB 上限、转义和超限警告。用 notes 保存一条详细记录：上下文只出现记忆索引，需要时能从索引读到 note。
- [ ] 重启、归档后重开和「新开对话」继续使用同一份 memory、notes 和私有 skills。普通 Session 和 Member 不会收到管理会话的记忆；现有 Member 的记忆行为仍一致。
- [ ] dev profile 人工验收一次入门问答，以及「记下一个习惯、保存一条 note、安装一个自己的 skill，换会话后还能使用」。更新团队管理记忆和 skills 的维护入口。
