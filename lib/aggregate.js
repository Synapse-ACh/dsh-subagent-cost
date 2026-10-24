/**
 * subagent-cost — pure aggregation half.
 *
 * Turns a parent session's event log plus its child session folds into the
 * per-turn / per-child summary the composer dock renders. Kept free of cordis
 * and of any I/O so it can be exercised against real logs from plain Node.
 *
 * Two facts drive the shape of this module (both verified against real logs
 * under `$DSH_HOME/sessions`):
 *
 * 1. Parent → child attribution does NOT need the disk layout to be guessed:
 *    every time a subagent session is created, the PARENT log receives a
 *    `subagent/catalog` event
 *      {type:"subagent/catalog", seq, time, data:{version, childId,
 *       childCreatedAt, mode:"continuable"|"one-shot"|..., label}}
 *    where `childId` is the child session id (a bare uuid for subagents).
 *
 * 2. "One task" is a parent TURN. `turn/start` carries `{turn}`, and events are
 *    in seq order, so a catalog entry belongs to the last turn/start before it.
 *    A fan-out that keeps creating children after its turn ended still lands in
 *    that turn, which is the intent (the turn launched the work).
 */
import {
  applyUsageDelta,
  computeCost,
  createCostState,
  totalTokens,
} from './cost.js';

/** An empty token bucket. */
export function emptyBuckets() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, total: 0 };
}

/** Turn the fold's buckets into a plain JSON row (adds `total`). */
export function bucketsRow(buckets) {
  const row = {
    inputTokens: buckets.inputTokens,
    outputTokens: buckets.outputTokens,
    cacheReadTokens: buckets.cacheReadTokens,
    cacheWriteTokens: buckets.cacheWriteTokens,
  };
  row.total = buckets.total ?? totalTokens(row);
  return row;
}

/** Add one bucket set into another (mutating). */
export function addBuckets(target, source) {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  return target;
}

/**
 * Read a parent session's turn boundaries and subagent catalog from its events.
 *
 * @param events - the parent session's events, in seq order.
 * @returns `{turns, entries}` where `turns` is `[{turn, startedAt, at}]` in
 *   event order (a resumed session can restart turn numbers, so the array
 *   index is the stable identity) and `entries` is
 *   `[{turnIndex, turn, childId, label, mode, createdAt, announcedAt, seq}]`
 *   deduplicated by childId (first announcement wins).
 */
export function scanCatalog(events) {
  const turns = [];
  const seen = new Set();
  const entries = [];
  let turnIndex = -1;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'turn/start') {
      turnIndex = turns.length;
      turns.push({ turn: event.data?.turn ?? turnIndex + 1, startedAt: event.time ?? null, at: turns.length });
      continue;
    }
    if (event.type !== 'subagent/catalog') continue;
    const data = event.data ?? {};
    const childId = typeof data.childId === 'string' ? data.childId : null;
    if (childId === null || seen.has(childId)) continue;
    seen.add(childId);
    entries.push({
      turnIndex,
      turn: turnIndex === -1 ? null : turns[turnIndex].turn,
      childId,
      label: typeof data.label === 'string' ? data.label : '',
      mode: typeof data.mode === 'string' ? data.mode : 'unknown',
      createdAt: typeof data.childCreatedAt === 'number' ? data.childCreatedAt : null,
      announcedAt: typeof event.time === 'number' ? event.time : null,
      seq: typeof event.seq === 'number' ? event.seq : null,
    });
  }
  return { turns, entries };
}

/**
 * Fold one child session's events into a cost state and price it.
 *
 * A child uses the SAME usage semantics as a normal session (`assistant/message`
 * carries `data.usage`; a repeated (turn, step) sample replaces the earlier
 * one), so this is just the shared fold from ./cost.js with a per-child
 * incremental state object.
 *
 * @param state - a `createCostState()` value, reused across incremental folds.
 * @param events - the child's new events (from `state.consumed` on).
 * @returns the fold's consumed count.
 */
export function foldChildEvents(state, events) {
  const from = Number.isInteger(state.consumed) ? state.consumed : 0;
  if (events.length > from) {
    applyUsageDelta(state, events.slice(from));
    state.consumed = events.length;
  }
  return events.length;
}

/** Describe one child's priced usage from its fold state. */
export function childUsage(state, pricing) {
  const cost = computeCost(state, pricing);
  return {
    tokens: { ...cost.tokens, total: cost.tokens.tokens },
    cost: cost.cost,
    models: cost.models.map((row) => ({
      model: row.model,
      tokens: row.tokens,
      cost: row.cost,
    })),
  };
}

/**
 * Build the dock payload.
 *
 * @param parent - `{sessionId, events}` of the parent session (unused events,
 *   kept for callers that also need the title).
 * @param children - `[{entry, header, usage, status}]` where `entry` is one
 *   `scanCatalog` entry, `header` the child's `SessionHeader` (may be null),
 *   `usage` the `childUsage()` result (may carry `error`), and `status`
 *   `'running' | 'done' | 'unknown'`.
 * @returns `{totals, turns, children}` — everything the client renders.
 */
export function buildSummary(parent, children) {
  const { turns, entries } = scanCatalog(parent.events ?? []);
  const byId = new Map(entries.map((entry) => [entry.childId, entry]));

  const rows = [];
  for (const child of children) {
    const id = child.id ?? child.entry?.childId ?? child.header?.id ?? null;
    if (id === null) continue;
    const entry = child.entry ?? byId.get(id) ?? null;
    const usage = child.usage ?? null;
    rows.push({
      id,
      label: entry?.label ?? '',
      mode: entry?.mode ?? child.header?.origin ?? 'unknown',
      preset: child.header?.agentPreset ?? null,
      depth: child.header?.delegationDepth ?? null,
      turn: entry?.turn ?? null,
      turnIndex: entry?.turnIndex ?? -1,
      startedAt: child.header?.createdAt ?? entry?.createdAt ?? null,
      endedAt: child.endedAt ?? null,
      status: child.status ?? 'unknown',
      error: child.error ?? usage?.error ?? null,
      tokens: usage?.tokens ?? emptyBuckets(),
      cost: usage?.cost ?? 0,
      models: usage?.models ?? [],
    });
  }

  // Turn groups: every turn in the log order, then the unattributed bucket.
  const groups = turns.map((turn, index) => ({
    index,
    turn: turn.turn,
    startedAt: turn.startedAt,
    children: [],
  }));
  const orphan = { index: -1, turn: null, startedAt: null, children: [] };
  for (const row of rows) {
    const group = row.turnIndex >= 0 ? groups[row.turnIndex] : undefined;
    (group ?? orphan).children.push(row);
  }

  const totals = { children: rows.length, tokens: emptyBuckets(), cost: 0 };
  for (const row of rows) {
    addBuckets(totals.tokens, row.tokens);
    totals.cost += row.cost;
  }
  totals.tokens.total = totalTokens(totals.tokens);

  const summarizeGroup = (group) => {
    const bucket = emptyBuckets();
    let cost = 0;
    for (const row of group.children) {
      addBuckets(bucket, row.tokens);
      cost += row.cost;
    }
    bucket.total = totalTokens(bucket);
    const times = group.children.map((row) => row.startedAt).filter((t) => typeof t === 'number');
    return {
      index: group.index,
      turn: group.turn,
      startedAt: group.startedAt ?? (times.length ? Math.min(...times) : null),
      children: group.children.length,
      tokens: bucket,
      cost,
    };
  };

  const turnRows = [...groups.map(summarizeGroup), ...(orphan.children.length ? [summarizeGroup(orphan)] : [])];
  rows.sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total);
  return { totals, turns: turnRows, children: rows };
}

/** Fresh fold state for one child session. */
export function newChildState() {
  return createCostState();
}
