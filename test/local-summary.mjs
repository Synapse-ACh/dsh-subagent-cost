// Offline validation of the plugin's pure aggregation against real logs.
// Usage: node test/local-summary.mjs [parentSessionId]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildSummary, childUsage, foldChildEvents, newChildState, scanCatalog } from '../lib/aggregate.js';
import { DEFAULT_PRICING } from '../lib/cost.js';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const ROOT = path.join(HOME, 'sessions');

function decodeZstdFrames(buf) {
  const idx = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) idx.push(i);
  }
  if (idx.length <= 1) return zlib.zstdDecompressSync(buf);
  const parts = [];
  for (let k = 0; k < idx.length; k += 1) {
    const start = idx[k];
    const end = k + 1 < idx.length ? idx[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))); } catch { /* skip */ }
  }
  return Buffer.concat(parts);
}

function readSessionDir(dir) {
  const names = fs.readdirSync(dir).filter((n) => /^session(?:\.v\d+)?\.jsonl(\.zstd?)?$/.test(n));
  if (!names.length) return null;
  names.sort((a, b) => Number((/\.v(\d+)\./.exec(b) || [0, 0])[1]) - Number((/\.v(\d+)\./.exec(a) || [0, 0])[1]));
  const name = names[0];
  const raw = /\.zstd?$/.test(name) ? decodeZstdFrames(fs.readFileSync(path.join(dir, name))) : fs.readFileSync(path.join(dir, name));
  const events = [];
  for (const line of raw.toString('utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* bad line */ }
  }
  const header = events[0]?.type === 'session' ? events.shift() : null;
  return { header, events };
}

function findSessionDir(id) {
  for (const ws of fs.readdirSync(ROOT)) {
    const candidate = path.join(ROOT, ws, id);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const target = process.argv[2];
let parentId = target;
if (!parentId) {
  // pick the parent with the most catalog entries
  let best = { id: null, n: 0 };
  for (const ws of fs.readdirSync(ROOT)) {
    const wsDir = path.join(ROOT, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const id of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, id);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      let snap;
      try { snap = readSessionDir(dir); } catch { continue; }
      if (!snap) continue;
      const n = snap.events.filter((e) => e.type === 'subagent/catalog').length;
      if (n > best.n) best = { id: snap.header?.id ?? id, n };
    }
  }
  parentId = best.id;
}

const parentDir = findSessionDir(parentId);
if (!parentDir) throw new Error(`no dir for ${parentId}`);
const parent = readSessionDir(parentDir);
const { entries, turns } = scanCatalog(parent.events);
console.log(`parent ${parentId}: ${parent.events.length} events, ${turns.length} turns, ${entries.length} catalog entries`);

const children = [];
for (const entry of entries) {
  const dir = findSessionDir(entry.childId);
  if (!dir) {
    children.push({ entry, header: null, usage: null, status: 'unknown', error: 'missing-log' });
    continue;
  }
  const snap = readSessionDir(dir);
  const state = newChildState();
  foldChildEvents(state, snap.events);
  const last = snap.events[snap.events.length - 1];
  const done = last?.type === 'turn/end' || last?.type === 'session/end';
  children.push({
    entry,
    header: snap.header,
    usage: childUsage(state, DEFAULT_PRICING),
    status: done ? 'done' : 'running',
    endedAt: done ? last.time : null,
  });
}

const summary = buildSummary({ sessionId: parentId, events: parent.events }, children);
const fmt = (n) => n.toLocaleString('en-US');
const yuan = (n) => '¥' + n.toFixed(4);

console.log(`\ntotals: ${summary.totals.children} children  ${fmt(summary.totals.tokens.total)} tok  ≈ ${yuan(summary.totals.cost)}`);
console.log(`  in ${fmt(summary.totals.tokens.inputTokens)} / cacheRead ${fmt(summary.totals.tokens.cacheReadTokens)} / out ${fmt(summary.totals.tokens.outputTokens)}`);
for (const turn of summary.turns) {
  const when = turn.startedAt ? new Date(turn.startedAt + 8 * 3600 * 1000).toISOString().slice(5, 19).replace('T', ' ') : '—';
  console.log(`  turn ${turn.turn ?? '(none)'} @${when}  ${turn.children} children  ${fmt(turn.tokens.total)} tok  ≈ ${yuan(turn.cost)}`);
}
console.log('\ntop children:');
for (const row of summary.children.slice(0, 6)) {
  console.log(`  ${String(row.preset ?? '?').padEnd(14)} ${String(row.label).slice(0, 46).padEnd(48)} ${fmt(row.tokens.total).padStart(9)} tok  ${yuan(row.cost).padStart(10)}  ${row.status}`);
  for (const model of row.models) console.log(`      ${model.model}: ${fmt(model.tokens)} tok  ${yuan(model.cost)}`);
}
