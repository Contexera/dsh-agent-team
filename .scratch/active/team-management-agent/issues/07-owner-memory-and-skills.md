# 07 — 团队管理的记忆、笔记与私有 skills

**What to deliver:** 管理会话在 `$DSH_HOME/agent-team/owner/` 下使用自己的 `memory.md`、`notes/` 和可配置的 `skills/`，复用 Team 已有的目录、记忆索引和按会话发现 skills 的方式；重启、归档后重开和「新开对话」都沿用同一份目录。内置 wiki 内容不在本票。

**Blocked by:** 02

**Status:** pending

**Required context:** [设计快照](../spec.md) 的「记忆、笔记与 skills」；[Harness 能力](../materials/harness-support.md) 的记忆与 skills 行；`packages/agent-team/src/member-context.ts` 的 16 KiB/转义/警告逻辑、`member-runtime.ts` 的 `initializePrivateMemory`、`member-skills.ts` 的 `mountMemberSkillProvider`、`scripts/check-core-skills.mjs`。

**Boundaries:** 不写内置 wiki 内容（08）；不新增编辑界面；不改 Member 或普通 Session 的记忆/skills 行为；不把管理会话的 skills 挂给其他会话；不重开 02 的入口决策。

- [ ] 管理会话通过独立于 `memberForAgent` 的记忆上下文入口读取 `memory.md`，初始模板面向团队管理（不写 `# Member memory`）；验证可重放、16 KiB 上限、转义和超限警告。用 notes 保存一条详细记录：上下文只出现记忆索引，需要时能从索引读到 note。
- [ ] 管理会话能加载独立的内置 skills 目录（与成员的 `core-skills/` 分开并纳入静态检查）和自己目录的 `owner/skills/`。新增或移除一个私有 skill 后，后续轮次能发现变化，不必换会话或改 preset。私有 skill 同名时不覆盖内置 skill；Member 和普通会话的目录不受影响。
- [ ] 重启、归档后重开和「新开对话」继续使用同一份 memory、notes 和私有 skills。普通 Session 和 Member 不会收到管理会话的记忆；现有 Member 的记忆行为仍一致。
- [ ] dev profile 人工验收一次入门问答，以及「记下一个习惯、保存一条 note、安装一个自己的 skill，换会话后还能使用」；更新团队管理记忆和 skills 的维护入口。

**Evidence to return:** 变更文件、记忆/发现/隔离测试命令及结果、dev profile 验收记录、未验证范围。
