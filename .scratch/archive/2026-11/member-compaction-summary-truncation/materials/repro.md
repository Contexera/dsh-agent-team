# 复现：两条独立路径

本现象**不需要**起 Team 实例就能复现——压缩摘要就是一次普通的 chat completion 调用，直接打模型网关即可。会话日志取证用来确认「哪个成员、用的哪个模型、上限多少」。

## 路径 A：会话日志取证（判断「中的是谁、用的哪个模型」）

1. 会话文件：`~/.dsh/sessions/--<workspace 路径编码>--/<session-dir>/session.v4.jsonl.zstd`。
   - **必须是 MULTI-FRAME zstd**：用 `zstd -dc`；Node 的 `zlib.zstdDecompress` 只解第一帧且不报错（见 `../../operations/session-log-scanning-pitfalls.md` 的同族坑，那边是私有笔记里的说法，公开版要点：别用只解第一帧的库）。
2. 找成员：`{"type":"session/title","data":{"title":"<handle>"}}`。
3. 找失败：`{"type":"compaction/end","data":{"turn":N,"error":"summarization truncated at the token cap …"}}`，同时能算出每次耗时（`compaction/start` 与 `compaction/end` 的 `time` 差；实测 224–338 s = 慢模型在硬生成）。
4. 找**真路由**：`{"type":"request/header","data":{"header":{"config":{"provider",…,"model",…,"maxTokens"}}}}`。
   ⚠ `model/selection` 事件**不是**路由——路由钉在最后一次成功请求上，这正是死锁的观察面。
5. 找**成功**压缩的元数据：`{"type":"compaction/summary","data":{"provider","model","maxTokens","usage","shadowedTokenCount"}}`。这一步能直接读出「上限是多少」「摘要实际花了多少 token」，是判断「上限够不够」的现成证据。

## 路径 B：直接重放摘要调用（判断「这个模型在这个上限下写不写得出来」）

`materials/replay-compaction.py`：

```sh
python3 replay-compaction.py <session.v4.jsonl> <输入 token 预算> <provider/model> <max_tokens>
# 例：
python3 replay-compaction.py /tmp/cole.jsonl 266000 workbuddy/hy4free 16384
```

它做四件事：解压日志 → 把事件投影成 OpenAI 风格 messages（user / assistant(tool_calls) / tool）→ 末尾追加 Harness 的 `COMPACTION_INSTRUCTION` 原文 → 打 `http://127.0.0.1:3425/v1/chat/completions`（本地 magpie 网关，无需鉴权），打印 `finish_reason` / `completion_tokens` / `reasoning_tokens` / 正文字符数。

### 四个必须知道的细节（否则读数是错的）

1. **reasoning 要回放**：Harness 重放的 assistant 消息带 reasoning 内容（`requiresReasoningContentOnAssistantMessages` 那类 provider 尤其如此），脚本把它放进 `reasoning_content`。不回放会显著低估输入规模。
2. **reasoning token 计入 `max_tokens`**：所以「16,384 上限 + 16,384 reasoning + 0 正文」是完全自洽的读数，不是 provider 的 bug。
3. **`auto/…` 是路由组**：同一 `auto/deepseek-v4.1-flash` 可能落到不同后端（`opencode-go/…`、`tokenrhythm/…` 等），`/v1/models` 里各后端的 `context_window`/`max_output_tokens` 不同；复现结论要写清实际落到哪个后端（响应里的 `model` 字段）。
4. **别用「文件里第一个 model 事件」给整段贴标签**：一个会话文件可能包含多次模型切换与多代 rollover（同族坑见 `../../operations/session-log-scanning-pitfalls.md`）。

### 判定口诀

同一个输入、同一个上限，**换模型**读数翻转 ⇒ 模型行为差异（本次结论）。
同一个模型，**加上限**从红转绿 ⇒ 上限不足。
两者都不行 ⇒ 去看输入是否超窗（那是另一类错误 `CONTEXT_WINDOW_EXCEEDED`，不是本现象）。
