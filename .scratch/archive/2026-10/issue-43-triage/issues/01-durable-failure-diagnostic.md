# 01 — 失败诊断跨 Host 重启的行为（重验后：原判定不成立）

**What to build:** 无。原报告「失败原因重启即失」经重验**不成立**，本 ticket 关闭。

**Blocked by:** —
**Status:** complete（结论：不需要改）

## 重验结论

**原判定错了。** 我一开始报告说「`memberFailures` 是纯进程内 Map，所以重启后成员变回
`available`、诊断消失」——前半句对，**后半句错**。

实际行为：成员默认是 enabled 且 Inbox 里有待送事实，**重启会让它自己重新被唤醒**。
这次 wake 起一个回合，路由若仍是坏的，就又以同一个错误失败，
`agent/error` 再次填回 runtime 槽。**同一个持久来源（Session 日志）重新产出同一个诊断。**

实测（真实集成装配，Host 重启后）：

```
重启后立刻读：  presence=working  diagnostic=null   ← 已经被重启的 wake 唤醒
等该回合结束：  presence=error    diagnostic={"class":"runtime","detail":"gateway answered 401"}
```

## 所以最初那个 printk 是怎么来的

我最初那版测试在「重启后立刻读」，读到的是 `working`/`null`，
**就把它当成了「诊断丢失」**。那是读早了——它正在跑，还没轮到失败。
这是我自己的测量错误，不是产品缺陷。

## 曾走过的弯路（留档，避免重复）

为了让「重启后立刻就有错误态」成立，我写过一版
`restoreDurableTurnFailure`：在 `activateMember` 成功路径上读 Session 尾部的
`turn/end`，把失败填回 runtime 槽。

**代码是work的**，但两步内就被设计本身清掉：
激活成功后有一次 Inbox wake → 起回合 → `status: 'running'` →
`clearMemberFailure(memberId, 'runtime')` **按设计清空**。

那条清除是对的：正在跑的回合本身就是新证据。把「上次已结束回合的结果」
塞进「当前活跃回合状态」的槽里，位置和语义都冲突。

**最终 decision：回滚全部改动**，不留兼容层。
现在 `git diff` 里没有 `packages/agent-team/src/index.ts`。

## 留存的测试

`member-lifecycle.spec.ts` 里
`re-derives a Member's failed last turn when the Host restarts`
把真实行为钉住（重启后先 working，回合结束回到 error 且原因可读），
防止以后有人再把「读早了」当成缺陷改一遍。

## 对 issue #5 的影响

#5 原报告「`membersForClient` 不含失败原因」**判定的前半部分仍然成立**：
字段存在、客户端有渲染。但「原因会丢」不成立——只要成员还会被唤醒，就会重新产出。
真正的差别是**时间窗**：重启瞬间到该回合结束之间，确实短暂显示 working 而非 error。
这个属于设计本意（它正在重试），不是缺陷。
