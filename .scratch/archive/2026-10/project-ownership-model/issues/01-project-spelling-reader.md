# 01 — 读得懂 Project 写法的发布

**What to build:** 一个可以单独发布的版本：行为、用语与写入格式都不变，但打开 ledger 时同时读得懂改名后的 Project 写法（`project:` ref、`projectRef` / `project` / `projectRefs` 字段、`team/project-*` kind），读进内存后与原 Channel 写法完全相同。稳定 profile 升到这个版本后，开发 profile 跑 02 写进共享 ledger 的记录，稳定版仍能打开。

**Blocked by:** None — can start immediately

**Status:** complete

- [x] 解码层用一个归一化函数处理两种写法；只改约定字段名、这些字段里的 ref 前缀和顶层 kind，正文与其他字段不动；两种写法同时出现在同一对象时按非法记录拒绝
- [x] 每种 operation kind 的存储形状改写成 Project 写法后，解码结果与原写法逐项相等（因此 replay、幂等重试与 collision 行为相同）
- [x] `CHANGELOG.md` 写明本版本是改名前的兼容发布，稳定 profile 需先升到它

## 验收方式

`npm test` 通过。发布后稳定 profile 装上它，再让开发 profile 使用 02。
