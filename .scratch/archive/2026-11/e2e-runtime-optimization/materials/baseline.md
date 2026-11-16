# 当前测量与实验记录

## 串行基线

在提交 `8911169b` 上，使用：

```text
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
```

结果：9 个文件、21 个测试、200 张截图全部通过。

- Runner 总耗时：`193.353s`
- Vitest 总耗时：`191.81s`
- Vitest 测试耗时：`188.25s`
- staging：`706ms`
- evidence：`31ms`
- cleanup：`74ms`

按测试输出的主要测试耗时：

| Lane | 测试数 | 观测耗时 |
| --- | ---: | ---: |
| `team-journey` | 1 | `47.753s` |
| `team-manager` | 3 | `14.323s`、`10.930s`、`3.191s` |
| `team-main-stream-and-board` | 4 | `8.226s`、`3.673s`、`2.836s`、`2.634s` |
| `team-timeline-and-shell` | 3 | `8.075s`、`4.632s`、`2.902s` |
| `team-worker-lifecycle` | 2 | `9.012s`、`4.946s` |
| `team-settings-and-tools` | 2 | `6.410s`、`6.795s` |
| `team-inbox-and-recovery` | 2 | `9.335s`、`2.375s` |
| `team-subscriptions` | 2 | `4.938s`、`6.114s` |
| `team-worker-settings-and-thread` | 2 | `6.138s`、`4.393s` |

这些时间是测试输出的单测试时间，不等同于独立启动成本。当前 Runner 没有把每个 scenario 的启动、页面行为和清理耗时写入结构化 summary，后续需要补充。

## 并行实验

先运行两条 lane：

```text
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser -- team-manager team-timeline-and-shell --fileParallelism --maxWorkers=2
```

结果：6/6 测试、20 张截图通过，Runner `49.645s`。两条 lane 可以在独立 Vitest Worker 中同时运行。

再运行全量：

```text
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser -- --fileParallelism --maxWorkers=2
```

结果：7 个文件通过，`team-journey` 测试和 Manager 的 `afterAll` 清理 hook 超时；20/21 测试完成，Vitest 总耗时 `204.66s`，Runner summary 因失败过程没有保留完整截图证据。

判断：简单打开文件并行会引入机器资源竞争和清理超时，不能直接作为默认优化。下一步应先补充按 scenario 的启动/行为/清理测量，或设计带资源预算的调度；不能把 `fileParallelism` 默认打开。

## Lane 消融

运行除 `team-journey` 之外的 8 条 lane：

```text
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/run-browser-test.mjs team-inbox-and-recovery team-main-stream-and-board team-manager team-settings-and-tools team-subscriptions team-timeline-and-shell team-worker-lifecycle team-worker-settings-and-thread
```

结果：8 个文件、20 个测试通过，Runner `124.897s`，Vitest `123.84s`，96 张截图。与完整串行基线相比，`team-journey` 贡献约 `68s` 的总成本；它仍承担跨表面连续旅程、安装/进入/退出和普通 DSH 恢复，不能按“耗时最大”直接删除。

## 截图成本实验

临时保留 `sidebar-projects.png` 这个后续上传 fixture，跳过其他截图写盘。行为断言通过，但 Runner `50.500s`，正常 `team-journey` 单 lane 最近为 `47.889s`。截图写盘不是主要瓶颈，实验代码已撤回。
