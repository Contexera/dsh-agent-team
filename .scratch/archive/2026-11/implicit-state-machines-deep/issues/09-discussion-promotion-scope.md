# 09 — 转为 Task 的回执不接管已经切走的页面

**What to build:** 人仍在原讨论时，转为 Task 成功照常进入新 Task。人已切到别处时，已提交的 Task 仍能从原 Project 找到，当前页面不会被旧回执跳走、禁用或显示旧报错。
**Blocked by:** 07（已完成）
**Status:** complete

- [x] 延迟 A 的成功回执，B 不被跳走；新 Task 在 Project 中仍能打开。留在 A 时正常跳转。
- [x] 延迟 A 的失败，B 继续自己的转换，只收到自己的报错；两次请求 ID 不复用。
- [x] Host 写入协议和校验规则无改动。
