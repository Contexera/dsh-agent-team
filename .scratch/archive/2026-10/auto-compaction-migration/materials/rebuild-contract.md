# 断 cc 时真正要建的边界在哪

Vera · 2026-10-20 · 读 cc 的 coordinator 源码得出，不是猜的。

## 一、好消息：host 侧已经全在了

cc 的 `Coordinator` 只依赖 **6 个 host 接口**（`grep -oE 'this\.host\.[a-zA-Z]+' coordinator.js | sort | uniq -c`）：

| 接口 | 调用次数 | 我们是否已实现 |
|---|---|---|
| `subjectForAgent` | 9 | ✅ `context-continuity-host.ts` |
| `log` | 7 | ✅ |
| `projectionForSubject` | 3 | ✅ |
| `agentForSubject` | 2 | ✅ |
| `rolloverIdentity` | 1 | ✅ |
| `executeTransition` | 1 | ✅ |

**六个全在 `packages/agent-team/src/context-continuity-host.ts`（395 行）里。**
⇒ 断 cc **不需要改 host 那一侧的接线**，要搬的是 coordinator 自己那 494 行里
Team 真正用到的逻辑（≈128 行是旧的 369 行里没有的，其余 16 个方法旧版就有）。

**这件事值得单独说**，因为它把 A 的边界收窄了：不是"重写整套换代机制"，
是"把 coordinator 的实现搬进本仓，保持这 6 个 host 接口不变"。
host 接口是天然的接缝——它已经是 Team 自己的代码，cc 只是接在它上面的引擎。

## 二、形状

```
现在：  index.ts(16 处调用) → ContextContinuityCoordinator(cc, 494行) → host 接口 → context-continuity-host.ts(395行)
之后：  index.ts(16 处调用) → 自持 coordinator(本仓)              → host 接口 → context-continuity-host.ts(395行，不动)
```

**`index.ts` 那 16 处调用点也不用改**——它们调的是方法名（`captureQueuedInput` 等），
只要本仓的实现提供同样的方法与语义。⇒ **改动被夹在 host 接口和 index.ts 之间**，
两端都是我们已有的、有测试的代码。这是 A 里风险最低的切法。

## 三、必须原样保留的语义（重写时最容易丢的）

1. **投递对象在"投递时"读，不在"捕获时"记**（`agentForSubject` 在 `whenIdle()` 之后调用）。
   中间可能已换代；用旧 Agent 投递＝祖先把输入吞掉。
2. **先摘 hold 再 drain**（`returnHeldInput` 先 `holds.delete` 再 `drainCapturedInput`），
   否则第二次 turn end 重复投递同一批输入。
3. **`holdClaimedInput` 把 arm 和 capture 合成一次调用**——捕获在 hold 未 arm 时会被拒，
   顺序反了就丢掉 hold 本来要保的那批输入。
4. `handBackInput` 的六条分支（见 `handback-acceptance-matrix.md`）。

## 四、我没验的

- 这 6 个 host 接口的**语义是否真的够用**（cc 可能在某些分支上依赖接口的隐含约定，
  例如 `agentForSubject` 返回 `undefined` 的确切时机）。这是重写时最容易出问题的地方，
  建议每搬一个方法就跑一次对应测试，而不是全搬完再跑。
- cc 内部方法之间是否有我不知道的调用关系（我只读了方法签名与 `handBackInput` 全body）。
