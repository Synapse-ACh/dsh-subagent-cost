# dsh-subagent-cost

A DSH (DeepSeek Harness) Web plugin: counts the **subagent sessions your conversation spawned**, sums their tokens, prices them in CNY, and groups them by the parent conversation's **turn**.

```
● 3 subagents · ¥0.42
```

Click the pill and you get a panel:

```
Subagent usage                                  ¥0.4213
3 subagents · 546.0k tokens · 1 running            [refresh]
──────────────────────────────────────────────────────────
Turn 2 · 15:20 · 2 subagents      405.9k tokens · ¥0.9735
  [study-worker] Study bceacfbf · Part 1/9 · Rev…   63.3k  ¥0.2102
  [standard]     another child …                    27.9k  ¥0.0897
──────────────────────────────────────────────────────────
Estimated with DeepSeek V4.1 peak/off-peak pricing (CNY / 1M tokens)
```

The pill's dot: blue = some subagent still running, green = all finished, grey = this conversation has not spawned any, red = read failed.

「子智能体用量」界面说明见文末 [中文说明](#中文说明)。

## Install

The plugin is not on npm; install straight from GitHub:

```
dsh plugin --profile <your-profile> add github:bianshuyang3-prog/dsh-subagent-cost
```

or, from a clone, point the plugin manager at the directory:

```
plugin_manager action:install_bundle target:<absolute path to this repo>
```

Refresh the browser page once after installing — the client half is loaded by the Web UI.

## How "one task" is decided

By **turn of the parent conversation**. The parent session log carries `subagent/catalog` events that name each `childId`, and `turn/start` events that carry `turn`; every catalog event is attributed to the most recent `turn/start` before it. So "you send one message → every subagent it dispatched" naturally forms one group, and multiple batches inside one conversation do not bleed into each other.

For older parent logs without catalog events the plugin falls back to `ctx.subagents.listChildren(parentId)`; those children land under "unattributed turn".

## Metering and pricing

- A subagent is an **independent session**; its cost only counts the `assistant/message.data.usage` samples it produced itself.
- Forked child sessions (`isSeeded`) replay the parent's events as a seed. Those tokens are on the parent's bill, so folding starts after `inheritedEventCount`.
- The pricing module is vendored from `@kidli1412/dsh-session-cost`'s `lib/cost.js` (MIT): each event is priced at the peak/off-peak window **in force at that event's timestamp** (Beijing time, weekdays 09:00–12:00 and 14:00–18:00 are peak), per `provider/model`.
- Token buckets are disjoint: `inputTokens` is cache-miss input, `cacheReadTokens` is billed at the cache-hit rate (~1/50 of the miss rate), `cacheWriteTokens` at the write rate, `outputTokens` at the output rate.
- The numbers are **estimates**: same billing rules as the official invoice, but not the invoice (retries and failed requests are not represented).

## Data sources and performance

The host half registers exactly one read-only endpoint:

```
GET /api/subagent-cost/summary?session=<parent session id>
```

with a loopback check (peer socket must be 127.0.0.1/::1 and the `Host` header must be local) — anything else gets 403.

- Parent session: `ctx.sessionQuery.readSession(parentId)` (live preferred, persisted fallback). Read once, for catalog events and turn boundaries.
- Child sessions: **read straight from disk**, `$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`, split on the zstd frame magic (`28 B5 2F FD`) and decompress frame by frame. This is the pitfall the plugin exists to dodge: Node's `zstdDecompressSync` / `createZstdDecompress()` stop after the **first** frame (a 53 KB log yields 279 bytes), so without frame-by-frame decoding every total comes out 0.
- Falls back to `sessionQuery.readSession` in three cases: log file missing, undecodable, or a forked child (`isSeeded`, needs `inheritedEventCount` to skip the seed). Replay is persisted and serialized at ~130 ms per session — 38 children take ~5 s — hence fallback only.
- Measured: for a parent with 38 subagents and 546k tokens, the disk path takes 0.19 s and `sessionQuery` takes 9.7 s; both paths agree to the last digit (545,792 tokens / ¥1.32122364).
- Incremental: each child keeps a fold state (`state.consumed`) and only new events are processed; a child whose log ends with `turn/end` is frozen and revalidated every 5 minutes. A 30 s poll therefore never re-scans whole logs.

## Layout

```
lib/index.js      host half: registers /api/subagent-cost/summary
lib/client.js     client half: a hand-written __ModuleLoader__ bundle (dock pill + panel)
lib/aggregate.js  pure functions: turn/catalog scan, child folding, summary
lib/cost.js       vendored pricing module (from @kidli1412/dsh-session-cost, MIT)
test/local-summary.mjs  offline check: aggregates $DSH_HOME/sessions directly
```

Offline check (no harness needed):

```
node test/local-summary.mjs                    # picks the parent with the most subagents
node test/local-summary.mjs <parent-session-id>  # explicit parent
```

## 中文说明

统计**当前会话派发出去的子智能体**用了多少 token、折合多少钱（CNY），并按「父会话的轮次」分组。

- **显示**：对话输入框下方状态条（`conversation.composer.dock`）多一个药丸 `● 3 个子智能体 · ¥0.42`；点击展开面板，按轮次列出每个子智能体（`[agentPreset]` 标签 · label · token 数 · 估算费用），底部是本次合计。药丸圆点：蓝＝有子智能体在运行，绿＝全部结束，灰＝本会话没派发过，红＝读取失败。
- **「一次任务」怎么切**：按父会话的 turn 切。父会话日志里 `subagent/catalog` 事件带 `childId`，`turn/start` 事件带 `turn`，每条 catalog 归到它之前最近的那个 `turn/start`——「你发一条消息 → 它派出的所有子智能体」自然成组。
- **计量**：子智能体是独立 session，只算它自己 `assistant/message.data.usage` 的用量；fork 出来的子会话（`isSeeded`）把父会话事件当 seed 重放，这部分从 `inheritedEventCount` 之后才开始折叠。计价模块 vendored 自 `@kidli1412/dsh-session-cost`（MIT），逐条事件按发生时刻判峰谷。
- **数据来源**：宿主半只注册 `GET /api/subagent-cost/summary?session=<父会话 id>`（带 loopback 校验，非本机 403）。子会话直接读磁盘日志 `$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`，按 zstd 帧魔数 `28 B5 2F FD` 切开逐帧解压——Node 自带的 `zstdDecompressSync`/`createZstdDecompress()` 只解第一帧（53KB 日志只出 279 字节），不逐帧解压统计全是 0。文件缺失、解不开、或 fork 子会话时才回落 `sessionQuery.readSession`。
- **性能**：38 个子智能体、54.6 万 token 的父会话，走磁盘 0.19s，走 `sessionQuery` 9.7s，两边结果完全一致。每个子会话保留 fold 状态只处理新事件，已结束的每 5 分钟才重新校验，所以 30 秒轮询不会反复重扫日志。
- **数字是估算**：与官方账单口径一致，但不等价于账单（重试、失败请求不在此列）。

## Credits

- Pricing and usage-attribution semantics: `@kidli1412/dsh-session-cost` (MIT), itself mirroring the `tokenUsage` projection of `dsh-token-meter`, with a nod to `dsh-usage-stats` (MIT © Ychris12138).
- Parent/child mapping leans on the harness's own `subagent/catalog` session events.

## License

MIT — see [LICENSE](LICENSE).
