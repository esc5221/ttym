#!/usr/bin/env node
/**
 * Capture a de-identified fixture from a ttym runtime dir.
 *
 * Reads only. Keeps every structural fact — counts, ids, layout trees, which
 * meta keys exist, snapshot sizes, which manifests are stale — and drops the
 * content: screens become recorded lengths, cwds lose the username, agent
 * session ids become deterministic fakes, and every command becomes /bin/sh
 * so a test materializing this can never spawn a real agent.
 *
 *   node scripts/capture-fixture.mjs ~/.ttym/run packages/server/fixtures/prod.json
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const [srcDir, outFile] = process.argv.slice(2);
if (!srcDir || !outFile) {
  console.error('usage: capture-fixture.mjs <runtime-dir> <out.json>');
  process.exit(1);
}

const fake = (value, prefix) =>
  value == null ? value : `${prefix}-${createHash('sha1').update(String(value)).digest('hex').slice(0, 8)}`;
const scrubPath = (p) => (typeof p === 'string' ? p.replace(/\/Users\/[^/]+/, '/Users/user') : p);

const read = (name) => JSON.parse(readFileSync(resolve(srcDir, name), 'utf8'));
const files = readdirSync(srcDir);

// ── workspaces.json: keep the trees verbatim, scrub free-text names ──
const ws = read('workspaces.json');
const workspaces = {
  version: ws.version,
  workspaces: ws.workspaces.map((w, i) => ({
    ...w,
    name: `ws-${i + 1}`,
    project: w.project === 'default' ? 'default' : `proj-${i + 1}`,
    members: (w.members ?? []).map((m) => ({ ...m })),
  })),
};

// ── session meta: keys + shape, values sanitized ──
const metas = files.filter((f) => /^meta-\d+\.json$/.test(f)).map((f) => {
  const id = Number(f.match(/\d+/)[0]);
  const meta = read(f);
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/SessionId$/.test(key)) out[key] = fake(value, 'agent');
    else if (key === 'cwd') out[key] = scrubPath(value);
    else if (key === 'workspaceName') out[key] = value == null ? value : 'ws';
    else if (typeof value === 'string' && value.includes('/Users/')) out[key] = scrubPath(value);
    else out[key] = value;
  }
  return { id, meta: out };
});

// ── snapshots: sizes and geometry only; content is regenerated at materialize ──
const snapshots = files.filter((f) => /^snapshot-\d+\.json$/.test(f)).map((f) => {
  const id = Number(f.match(/\d+/)[0]);
  const snap = read(f);
  return {
    id,
    cols: snap.cols,
    rows: snap.rows,
    screenBytes: (snap.screen ?? '').length,
    cwd: scrubPath(snap.cwd),
    createdAt: snap.createdAt,
    savedAt: snap.savedAt,
    hasCheckpointFields: typeof snap.appliedThroughOffset === 'number',
    cmdLen: Array.isArray(snap.cmd) ? snap.cmd.length : 1,
  };
});

// ── manifests: which exist and which are stale (pid dead / socket gone) ──
const manifests = files.filter((f) => /^session-\d+\.json$/.test(f)).map((f) => {
  const id = Number(f.match(/\d+/)[0]);
  const m = read(f);
  let alive = false;
  try { process.kill(m.pid, 0); alive = true; } catch {}
  return {
    id,
    cols: m.cols,
    rows: m.rows,
    aliveAtCapture: alive,
    socketPresent: existsSync(resolve(srcDir, `session-${id}.sock`)),
    generation: m.generation ? 'present' : 'absent',
  };
});

const nextId = Number(readFileSync(resolve(srcDir, 'next-id'), 'utf8').trim());

const fixture = {
  capturedAt: new Date().toISOString(),
  source: 'production ~/.ttym/run (de-identified)',
  nextId,
  workspaces,
  metas,
  snapshots,
  manifests,
};

writeFileSync(outFile, JSON.stringify(fixture, null, 1));
console.log(`fixture: ${outFile}`);
console.log(`  workspaces ${workspaces.workspaces.length}  members ${workspaces.workspaces.reduce((a, w) => a + w.members.length, 0)}`);
console.log(`  metas ${metas.length}  snapshots ${snapshots.length}  manifests ${manifests.length} (stale ${manifests.filter((m) => !m.aliveAtCapture).length})`);
