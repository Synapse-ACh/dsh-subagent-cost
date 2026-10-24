/**
 * subagent-cost — host half.
 *
 * Registers one loopback-only read-only endpoint:
 *
 *   GET /api/subagent-cost/summary?session=<parent session id>
 *
 * which answers "how many subagents did this session spawn, what did each one
 * cost, and which turn spawned it". Everything it needs is already durable:
 *
 *   - the parent→child relation is read from the PARENT log (`subagent/catalog`
 *     events carry childId/label/mode/childCreatedAt — see lib/aggregate.js);
 *   - each child's tokens are folded from that child's own event log with the
 *     same `assistant/message.data.usage` semantics and the same CNY price
 *     table as @kidli1412/dsh-session-cost (vendored in lib/cost.js, MIT);
 *   - both sides are read through the harness `sessionQuery` service, whose
 *     `readSession` prefers the LIVE session and falls back to the persisted
 *     log. That is what makes ended subagents readable without decoding
 *     multi-frame zstd by hand (Node's zstd stream stops after the first frame
 *     of `session.v4.jsonl.zstd`; the service replays the whole log instead).
 *
 * Cost is O(new events): each child keeps a fold state keyed by its session id
 * and only the events appended since the last fold are processed. A finished
 * child (log ends with `turn/end`) is frozen and only revalidated every
 * FREEZE_REVALIDATE_MS, so a dock polling every 30 s does not re-read the same
 * logs forever.
 *
 * @module subagent-cost
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DEFAULT_PRICING } from './cost.js';
import {
  buildSummary,
  childUsage,
  foldChildEvents,
  newChildState,
  scanCatalog,
} from './aggregate.js';

/** Stable Cordis plugin name. */
const name = 'subagent-cost';

/** Services required before this plugin activates. */
const inject = ['webServer'];

/** Route of the dock's data source. */
const SUMMARY_PATH = '/api/subagent-cost/summary';

/** How long a finished child stays frozen before one revalidation read. */
const FREEZE_REVALIDATE_MS = 5 * 60 * 1000;

/** How many child logs one request may replay at once. */
const CHILD_READ_CONCURRENCY = 16;

/** Write a JSON response. */
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/**
 * Loopback fence, primary on the PEER SOCKET address (never the
 * client-controllable Host header). IPv4-mapped IPv6 is normalized.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const a = address.toLowerCase();
  if (a === '::1') return true;
  const ipv4 = a.startsWith('::ffff:') ? a.slice(7) : a;
  const octets = ipv4.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close <= 1) return null;
    const suffix = host.slice(close + 1);
    if (suffix !== '' && !/^:\d+$/.test(suffix)) return null;
    return host.slice(1, close);
  }
  const firstColon = host.indexOf(':');
  const lastColon = host.lastIndexOf(':');
  if (firstColon !== lastColon) return host;
  if (lastColon === -1) return host.replace(/\.$/, '');
  if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
  return host.slice(0, lastColon).replace(/\.$/, '');
}

function isLoopbackHostHeader(req) {
  const hostName = hostNameOf(req.headers.host);
  return hostName === 'localhost' || isLoopbackAddress(hostName) || hostName === '[::1]';
}

/** Refuse non-loopback callers and non-GET methods before any work. */
function rejectForeignCaller(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
    return true;
  }
  const peer = req.socket?.remoteAddress;
  if (isLoopbackAddress(peer) && isLoopbackHostHeader(req)) return false;
  json(res, 403, { ok: false, error: 'forbidden' });
  return true;
}

/**
 * Prefix shared by every per-session log file the harness writes.
 * `session.v4.jsonl.zstd` is the current name; the plain names are older
 * formats still found on disk.
 */
const LOG_FILENAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl'];

/** Zstandard frame magic: 0x28 0xB5 0x2F 0xFD (little-endian u32 0xFD2FB528). */
const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** How long a built sessionId → logfile index stays usable. */
const INDEX_TTL_MS = 60 * 1000;

/** Directory holding every session directory, or null when unreadable. */
function sessionsRoot() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : typeof os.homedir === 'function' ? path.join(os.homedir(), '.dsh') : null;
  if (home === null) return null;
  const root = path.join(home, 'sessions');
  try {
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/**
 * Decode a log whose frames are concatenated, STOPPING AT THE LAST COMPLETE ONE.
 *
 * Node's `zstdDecompressSync` (like the stream) returns only the first frame and
 * silently drops the rest — a 53 KB log decodes to 279 bytes. The harness does
 * not write a frame table, so the only way in is to walk the frame magics and
 * decompress each frame on its own. A frame cut in half by a writer still in
 * flight throws; everything decoded before it is valid, and the caller sees a
 * log that simply ends earlier, which is exactly the "still running" shape.
 */
function decodeFrames(buffer) {
  const marks = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === FRAME_MAGIC[0] && buffer[i + 1] === FRAME_MAGIC[1] && buffer[i + 2] === FRAME_MAGIC[2] && buffer[i + 3] === FRAME_MAGIC[3]) {
      marks.push(i);
      i += 3;
    }
  }
  if (marks.length === 0) {
    try {
      return zlib.zstdDecompressSync(buffer);
    } catch {
      return Buffer.alloc(0);
    }
  }
  const parts = [];
  for (let k = 0; k < marks.length; k += 1) {
    const start = marks[k];
    const end = k + 1 < marks.length ? marks[k + 1] : buffer.length;
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
    } catch {
      // A frame cut in half by a writer still in flight. Everything decoded
      // before it is valid; stopping here yields a log that ends at the last
      // complete event, which reads as "still running" rather than "empty".
      break;
    }
  }
  return Buffer.concat(parts);
}

/** Parse one session log buffer into its header and its event list. */
function parseSessionLog(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  let header = null;
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (row !== null && typeof row === 'object' && row.type === 'session' && header === null) {
      header = row;
      continue;
    }
    events.push(row);
  }
  return { header, events };
}

/** Cached sessionId → absolute log path index. */
let logIndex = { builtAt: 0, files: new Map() };

/**
 * Map a session id to its log file on disk.
 *
 * The layout is `$DSH_HOME/sessions/<workspace>/<sessionId>/<log>`, and session
 * ids are directory names, so a two-level walk is enough; the result is cached
 * for a minute so a 30 s poll pays for it roughly every other time.
 */
function sessionLogFile(sessionId) {
  const now = Date.now();
  if (now - logIndex.builtAt > INDEX_TTL_MS) {
    const files = new Map();
    const root = sessionsRoot();
    if (root !== null) {
      let workspaces = [];
      try {
        workspaces = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        workspaces = [];
      }
      for (const workspace of workspaces) {
        if (!workspace.isDirectory()) continue;
        const workspacePath = path.join(root, workspace.name);
        let sessions = [];
        try {
          sessions = fs.readdirSync(workspacePath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const session of sessions) {
          if (!session.isDirectory()) continue;
          const dir = path.join(workspacePath, session.name);
          for (const filename of LOG_FILENAMES) {
            const file = path.join(dir, filename);
            try {
              if (fs.statSync(file).isFile()) {
                files.set(session.name, file);
                break;
              }
            } catch {
              // Keep looking at the next candidate name.
            }
          }
        }
      }
    }
    logIndex = { builtAt: now, files };
  }
  return logIndex.files.get(sessionId) ?? null;
}

/**
 * Read one child session straight from its log file.
 *
 * Returns null for anything the on-disk form cannot represent faithfully: a
 * missing file, an unreadable one, or a FORKED session (`isSeeded`), whose log
 * begins with a replay of the parent's conversation and therefore needs the
 * `inheritedEventCount` split that only `sessionQuery.readSession` reports.
 */
function readChildFromDisk(childId) {
  const file = sessionLogFile(childId);
  if (file === null) return null;
  let parsed;
  try {
    parsed = parseSessionLog(decodeFrames(fs.readFileSync(file)));
  } catch {
    return null;
  }
  if (parsed.header === null || parsed.events.length === 0) return null;
  if (parsed.header.isSeeded === true) return null;
  return { header: parsed.header, events: parsed.events };
}

/** Per-child incremental fold cache: childId → cache record. */
const childCache = new Map();

/**
 * Read one child session and price its usage, reusing the cached fold.
 *
 * The disk log is preferred — one multi-frame decode is a few milliseconds,
 * while `sessionQuery.readSession` replays through the persistence layer and
 * serializes (measured ~130 ms per child, so 38 children cost ~5 s on the first
 * poll). The service stays as the fallback for forked children, for sessions
 * whose file the walk did not find, and for anything the decoder refused.
 *
 * @param ctx - plugin context (resolves `sessionQuery` lazily).
 * @param childId - the child session id from a `subagent/catalog` event.
 * @returns `{header, usage, status, endedAt, cached}`
 */
async function readChild(ctx, childId) {
  const cached = childCache.get(childId) ?? null;
  const now = Date.now();
  if (cached !== null && cached.frozenAt !== null && now - cached.frozenAt < FREEZE_REVALIDATE_MS) {
    return { ...cached.result, cached: true };
  }
  let header = null;
  let events = null;
  let source = 'disk';
  const fromDisk = readChildFromDisk(childId);
  if (fromDisk !== null) {
    header = fromDisk.header;
    events = fromDisk.events;
  } else {
    const query = ctx.get('sessionQuery');
    const snapshot = await query.readSession(childId);
    const allEvents = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const inherited = Number.isInteger(snapshot?.inheritedEventCount) ? snapshot.inheritedEventCount : 0;
    // A FORKED child replays its parent's conversation as seed events; those
    // tokens were billed to the parent, so only the child's own tail counts.
    events = inherited > 0 ? allEvents.slice(inherited) : allEvents;
    header = snapshot?.session ?? null;
    source = 'query';
  }
  const consumed = Number.isInteger(cached?.state?.consumed) ? cached.state.consumed : 0;
  // A log that SHRANK (rewritten, or a stale disk file after the live session
  // overtook it) cannot be folded incrementally; rebuild from scratch.
  const state = events.length < consumed ? newChildState() : cached?.state ?? newChildState();
  const grew = events.length > (Number.isInteger(state.consumed) ? state.consumed : 0);
  if (grew || cached === null) foldChildEvents(state, events);
  const last = events.length ? events[events.length - 1] : null;
  const done = last !== null && (last.type === 'turn/end' || last.type === 'session/end');
  const usage = grew || cached === null ? childUsage(state, DEFAULT_PRICING) : cached.result.usage;
  const result = {
    header: header ?? cached?.result.header ?? null,
    usage,
    status: done ? 'done' : 'running',
    endedAt: done ? (last.time ?? null) : null,
    source,
    cached: false,
  };
  childCache.set(childId, {
    state,
    result,
    frozenAt: done ? now : null,
  });
  return result;
}

/**
 * Resolve the child list of a parent session.
 *
 * Primary source is the parent log's `subagent/catalog` events (they carry the
 * label, the mode, and the seq that pins the child to a turn). When a log has
 * none — an older session, or one whose parent never announced — fall back to
 * the subagent catalog service, which yields children without turn attribution.
 */
async function childEntriesOf(ctx, parentId, parentEvents) {
  const { entries } = scanCatalog(parentEvents);
  if (entries.length > 0) return { entries, source: 'log' };
  const subagents = ctx.get('subagents');
  if (subagents === void 0 || subagents === null || typeof subagents.listChildren !== 'function') {
    return { entries: [], source: 'none' };
  }
  try {
    const listed = await subagents.listChildren(parentId);
    return {
      source: 'catalog',
      entries: listed.map((row) => ({
        turnIndex: -1,
        turn: null,
        childId: row.id,
        label: typeof row.label === 'string' ? row.label : '',
        mode: typeof row.mode === 'string' ? row.mode : 'unknown',
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : null,
        announcedAt: null,
        seq: null,
      })),
    };
  } catch {
    return { entries: [], source: 'none' };
  }
}

/**
 * Run `fn` over `items` with at most `limit` promises in flight, preserving
 * the input order in the result. Used so a wide fan-out does not replay every
 * child log strictly one after another.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}

/** Build the full dock payload for one parent session. */
async function buildPayload(ctx, parentId) {
  const query = ctx.get('sessionQuery');
  if (query === void 0 || query === null || typeof query.readSession !== 'function') {
    return { error: 'no-session-query' };
  }
  const tParent = Date.now();
  const snapshot = await query.readSession(parentId);
  const parentMs = Date.now() - tParent;
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const { entries, source } = await childEntriesOf(ctx, parentId, events);
  const warnings = [];
  // A cold cache means one `readSession` replay per child; run them a few at a
  // time so a 40-worker fan-out does not replay every child log one by one.
  const tChildren = Date.now();
  const children = await mapLimit(entries, CHILD_READ_CONCURRENCY, async (entry) => {
    try {
      const child = await readChild(ctx, entry.childId);
      return { id: entry.childId, entry, header: child.header, usage: child.usage, status: child.status, endedAt: child.endedAt, source: child.source, cached: child.cached === true };
    } catch (error) {
      warnings.push(`child ${entry.childId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      return { id: entry.childId, entry, header: null, usage: null, status: 'unknown', error: 'unreadable' };
    }
  });
  const childrenMs = Date.now() - tChildren;
  const summary = buildSummary({ sessionId: parentId, events }, children);
  return {
    sessionId: parentId,
    parentEvents: events.length,
    parentStartedAt: snapshot?.session?.createdAt ?? null,
    childrenSource: source,
    currency: 'CNY',
    pricing: 'DeepSeek V4.1 peak/off-peak, CNY per 1M tokens',
    estimated: true,
    timings: { parentMs, childrenMs, children: entries.length, cached: children.filter((row) => row.cached === true).length },
    ...summary,
    warnings,
  };
}

/** GET handler of the summary route. */
async function handleSummary(ctx, req, res) {
  if (rejectForeignCaller(req, res)) return;
  const started = Date.now();
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const sessionId = url.searchParams.get('session');
    if (sessionId === null || sessionId === '') {
      json(res, 400, { ok: false, error: 'missing-session', message: '?session=<id> is required' });
      return;
    }
    const payload = await buildPayload(ctx, sessionId);
    if (payload.error === 'no-session-query') {
      json(res, 503, { ok: false, error: 'no-session-query', message: 'the sessionQuery service is not available in this host' });
      return;
    }
    json(res, 200, { ok: true, updatedAt: Date.now(), elapsedMs: Date.now() - started, ...payload });
  } catch (error) {
    ctx.logger?.warn?.(`subagent-cost: summary failed for ${req.url}: ${String(error)}`);
    json(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Plugin body: register the summary route.
 * @param ctx - plugin context carrying `webServer` (and, lazily, `sessionQuery`).
 */
function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SUMMARY_PATH,
    handler: (req, res) => handleSummary(ctx, req, res),
  }), 'subagent-cost: summary route');
}

export { apply, inject, name, SUMMARY_PATH, buildPayload, readChild, childCache };
