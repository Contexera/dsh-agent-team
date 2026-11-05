# 02 — vendored SQLite 对齐 RC 存储契约

**What to build:** Team 的自有 SQLite 后端在 DSH 0.2.2-rc.1 上满足完整存储契约，既有 ledger 可打开、重放和继续写入，发布包仍不依赖宿主未提供的 SQLite 包。
**Blocked by:** None — can start immediately
**Status:** done

- [x] vendored 实现与同版上游重新同步，批量删除、兼容版本写入和 domain 错误处理与上游一致，不只补类型占位。
- [x] 对照依赖与 fork 来源同为 `0.2.2-rc.1`；保留下来的本地差异均有明确理由，发布布局没有新增上游 SQLite 运行时依赖。
- [x] 新契约的批量删除由真实后端测试覆盖，既有 Team ledger 的持久化、重放、重启恢复和继续写入保持通过。
- [x] RC typecheck、相关存储测试和 artifact 检查通过。
