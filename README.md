# dsh-subagent-cost

A DSH (DeepSeek Harness) Web plugin: counts the **subagent sessions your conversation spawned**, sums their tokens, prices them in CNY, and groups them by the parent conversation's **turn**.

一个 DSH（DeepSeek Harness）网页插件：统计本会话派出的**子智能体会话**，汇总它们的 token 与人民币花费，并按父会话的 **turn** 分组展示。

## Screenshots / 截图

The dock pill, in the composer toolbar / 输入框工具条上的药丸：

![Dock pill: 37 subagents · ¥1.30](https://raw.githubusercontent.com/Synapse-ACh/dsh-subagent-cost/main/assets/screenshot-dock.png)

The panel it opens, grouped by turn, with per-child tokens and cost / 点开后的面板，按 turn 分组、逐个列出 token 与花费：

![Per-turn summary panel: 37 subagents, 514.4k tokens, ¥1.2981](https://raw.githubusercontent.com/Synapse-ACh/dsh-subagent-cost/main/assets/screenshot-panel.png)

```
● 3 subagents · ¥0.42
```

Click the pill and you get a panel / 点开药丸得到这样的面板：

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

药丸上的圆点：蓝＝有子智能体在运行，绿＝全部结束，灰＝本会话没派发过，红＝读取失败。

## Install / 安装

From npm (recommended):

```
# cli / web profiles
dsh plugin --profile <profile> add dsh-subagent-cost
```

Straight from GitHub, if you want the tip of `main`:

```
dsh plugin --profile <profile> add github:Synapse-ACh/dsh-subagent-cost
```

From a DSH conversation both specs work through the plugin manager:

```
plugin_manager action:install_bundle target:dsh-subagent-cost
plugin_manager action:install_bundle target:github:Synapse-ACh/dsh-subagent-cost
```

The Desktop profile is managed by the Electron app, so the `dsh plugin --profile …` CLI refuses it — use the in-app plugin manager (paste `dsh-subagent-cost` into its install field) or the tool above.

Prefer a local checkout? `git clone` the repo and pass the absolute path of the directory instead of the spec.

Refresh the browser page once after installing: the host half restarts by itself, but the client half (the dock pill) is loaded by the Web UI and needs a reload.

推荐直接用 npm 安装（`dsh plugin --profile <profile> add dsh-subagent-cost`），想跟 `main` 最新代码就用 `github:Synapse-ACh/dsh-subagent-cost`；在对话里也可以让 `plugin_manager` 装这两个 spec 中的任意一个。Desktop profile 由 Electron 应用托管，`dsh plugin --profile …` 命令行会拒绝它——请用应用内的插件管理器，把 `dsh-subagent-cost` 粘进安装框，或者用上面的工具调用。想用本地仓库的话，`git clone` 之后把该目录的绝对路径当作 spec 传进去。装完刷新一次浏览器页面：宿主半会自己重启，但客户端半（药丸）是 Web UI 加载的，需要 reload。

## How "one task" is decided / 「一次任务」怎么切

By **turn of the parent conversation**. The parent session log carries `subagent/catalog` events that name each `childId`, and `turn/start` events that carry `turn`; every catalog event is attributed to the most recent `turn/start` before it. So "you send one message → every subagent it dispatched" naturally forms one group, and multiple batches inside one conversation do not bleed into each other.

For older parent logs without catalog events the plugin falls back to `ctx.subagents.listChildren(parentId)`; those children land under "unattributed turn".

按**父会话的 turn** 切。父会话日志里带 `childId` 的是 `subagent/catalog` 事件，带 `turn` 的是 `turn/start` 事件；每条 catalog 事件归到它之前最近的那个 `turn/start`——「你发一条消息 → 它派出的所有子智能体」自然成一组，同一会话里的多批派工不会互相串。更早的父会话日志没有 catalog 事件时，插件回落到 `ctx.subagents.listChildren(parentId)`，这些子智能体落到「未归轮」分组下。

## Metering and pricing / 计量与计价

- A subagent is an **independent session**; its cost only counts the `assistant/message.data.usage` samples it produced itself.
- Forked child sessions (`isSeeded`) replay the parent's events as a seed. Those tokens are on the parent's bill, so folding starts after `inheritedEventCount`.
- The pricing module is vendored from `@kidli1412/dsh-session-cost`'s `lib/cost.js` (MIT): each event is priced at the peak/off-peak window **in force at that event's timestamp** (Beijing time, weekdays 09:00–12:00 and 14:00–18:00 are peak), per `provider/model`.
- Token buckets are disjoint: `inputTokens` is cache-miss input, `cacheReadTokens` is billed at the cache-hit rate (~1/50 of the miss rate), `cacheWriteTokens` at the write rate, `outputTokens` at the output rate.
- The numbers are **estimates**: same billing rules as the official invoice, but not the invoice (retries and failed requests are not represented).

- 子智能体是**独立 session**，只算它自己产生的 `assistant/message.data.usage`。
- fork 出来的子会话（`isSeeded`）会把父会话事件当 seed 重放，这些 token 已经记在父会话账单上，所以折叠从 `inheritedEventCount` 之后才开始。
- 计价模块 vendored 自 `@kidli1412/dsh-session-cost` 的 `lib/cost.js`（MIT）：逐条事件按**该事件发生时刻**生效的峰谷时段计价（北京时间工作日 09:00–12:00、14:00–18:00 为高峰），按 `provider/model` 取价。
- token 各桶互不重叠：`inputTokens` 是未命中缓存的输入，`cacheReadTokens` 按命中缓存价（约为未命中价的 1/50），`cacheWriteTokens` 按写入价，`outputTokens` 按输出价。
- 数字是**估算**：与官方账单计价规则一致，但不等价于账单（重试和失败请求不在此列）。

## Data sources and performance / 数据来源与性能

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

宿主半只注册一个只读端点 `GET /api/subagent-cost/summary?session=<父会话 id>`，带 loopback 校验（对端 socket 必须是 127.0.0.1/::1，且 `Host` 头是本机）——其余一律 403。

- 父会话：`ctx.sessionQuery.readSession(parentId)`（活会话优先，否则读持久化），只读一次，用于取 catalog 事件和 turn 边界。
- 子会话：**直接读磁盘**，`$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`，按 zstd 帧魔数（`28 B5 2F FD`）切开逐帧解压。这正是本插件要绕开的坑：Node 自带的 `zstdDecompressSync` / `createZstdDecompress()` 只解**第一帧**（53 KB 的日志只出 279 字节），不逐帧解压统计会全是 0。
- 三种情况回落到 `sessionQuery.readSession`：日志文件缺失、解不开、或 fork 出来的子会话（`isSeeded`，需要 `inheritedEventCount` 跳过 seed）。重放是持久化且串行的，约 130 ms/会话——38 个子会话约 5 s——所以只做兜底。
- 实测：38 个子智能体、54.6 万 token 的父会话，走磁盘 0.19 s，走 `sessionQuery` 9.7 s，两边结果逐位一致（545,792 tokens / ¥1.32122364）。
- 增量：每个子会话保留 fold 状态（`state.consumed`），只处理新事件；日志以 `turn/end` 结尾的子会话会被冻结，每 5 分钟才重新校验。所以 30 秒轮询不会反复重扫整份日志。

## Layout / 目录结构

```
lib/index.js      host half: registers /api/subagent-cost/summary
lib/client.js     client half: a hand-written __ModuleLoader__ bundle (dock pill + panel)
lib/aggregate.js  pure functions: turn/catalog scan, child folding, summary
lib/cost.js       vendored pricing module (from @kidli1412/dsh-session-cost, MIT)
test/local-summary.mjs  offline check: aggregates $DSH_HOME/sessions directly
```

- `lib/index.js` — 宿主半：注册 `/api/subagent-cost/summary`。
- `lib/client.js` — 客户端半：手写的 `__ModuleLoader__` bundle（药丸 + 面板）。
- `lib/aggregate.js` — 纯函数：turn/catalog 扫描、子会话折叠、汇总。
- `lib/cost.js` — vendored 计价模块（来自 `@kidli1412/dsh-session-cost`，MIT）。
- `test/local-summary.mjs` — 离线校验：直接聚合 `$DSH_HOME/sessions`。

## Offline check / 离线校验

No harness needed / 不需要启动 harness：

```
node test/local-summary.mjs                    # picks the parent with the most subagents / 选子智能体最多的父会话
node test/local-summary.mjs <parent-session-id>  # explicit parent / 指定父会话
```

## Credits / 致谢

- Pricing and usage-attribution semantics: `@kidli1412/dsh-session-cost` (MIT), itself mirroring the `tokenUsage` projection of `dsh-token-meter`, with a nod to `dsh-usage-stats` (MIT © Ychris12138).
- Parent/child mapping leans on the harness's own `subagent/catalog` session events.

计价与用量归属口径来自 `@kidli1412/dsh-session-cost`（MIT），它本身对齐 `dsh-token-meter` 的 `tokenUsage` 投影，并参考了 `dsh-usage-stats`（MIT © Ychris12138）；父子关系依赖 harness 自带的 `subagent/catalog` 会话事件。

## License / 许可

MIT — see [LICENSE](LICENSE) / 见 [LICENSE](LICENSE)。
