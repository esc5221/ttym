import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * Boot against the shape and scale of the real deployment.
 *
 * Every failure that has actually bitten this project surfaced on production
 * data, not on toy inputs: the layouts were flattened before anyone noticed,
 * the b45f036e reboot lost sessions through the missing shutdown index, and
 * the v3 swap raced two servers. This suite materializes a de-identified
 * capture of that runtime dir — 7 workspaces, 180 snapshots, 241 metas, the
 * shutdown index absent — and pins what boot must do with it.
 *
 * The capture stores structure only. Screens are regenerated at recorded
 * sizes, and every command was rewritten to /bin/sh at capture time, so this
 * can never spawn a real agent.
 */
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/prod-2026-08-06.json'), 'utf8'),
);

function materialize(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'workspaces.json'), JSON.stringify(FIXTURE.workspaces, null, 2));
  writeFileSync(resolve(dir, 'next-id'), String(FIXTURE.nextId));

  for (const { id, meta } of FIXTURE.metas) {
    writeFileSync(resolve(dir, `meta-${id}.json`), JSON.stringify(meta, null, 2));
  }

  for (const snap of FIXTURE.snapshots) {
    // A screen of the recorded size — content is irrelevant to boot, scale is not.
    const line = 'x'.repeat(78) + '\r\n';
    const screen = line.repeat(Math.ceil(snap.screenBytes / line.length)).slice(0, snap.screenBytes);
    writeFileSync(resolve(dir, `snapshot-${snap.id}.json`), JSON.stringify({
      version: 1,
      id: snap.id,
      cmd: ['/bin/sh'],
      cols: snap.cols,
      rows: snap.rows,
      cwd: '/tmp',
      createdAt: snap.createdAt,
      savedAt: snap.savedAt,
      screen,
      meta: FIXTURE.metas.find((m: { id: number }) => m.id === snap.id)?.meta ?? {},
    }));
  }

  for (const m of FIXTURE.manifests) {
    // Dead pid, absent socket: exactly what a reboot leaves behind.
    writeFileSync(resolve(dir, `session-${m.id}.json`), JSON.stringify({
      id: m.id,
      pid: 999_999_999,
      childPid: 999_999_998,
      cmd: ['/bin/sh'],
      cols: m.cols,
      rows: m.rows,
      socket: resolve(dir, `session-${m.id}.sock`),
      createdAt: Date.now() - 60_000,
    }));
  }
}

function referencedIds(): Set<number> {
  const ids = new Set<number>();
  for (const ws of FIXTURE.workspaces.workspaces) {
    for (const m of ws.members) ids.add(m.sessionId);
  }
  return ids;
}

describe('boot against the production fixture', () => {
  const dir = `/tmp/ttym-fixture-${process.pid}`;
  let manager: SessionManager | null = null;

  afterEach(async () => {
    manager?.destroyAll();
    manager = null;
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores exactly the workspace-referenced sessions, at real scale', async () => {
    materialize(dir);
    process.env.TTYM_RUNTIME_DIR = dir;
    try {
      manager = new SessionManager();
      const store = new WorkspaceStore(dir);
      await store.load();
      const allowlist = new Set<number>();
      for (const ws of store.list()) for (const m of ws.members) allowlist.add(m.sessionId);

      await manager.boot(allowlist);

      const restored = manager.list().map((s) => s.id).sort((a, b) => a - b);
      const snapshotIds = new Set(FIXTURE.snapshots.map((s: { id: number }) => s.id));
      const expected = [...referencedIds()].filter((id) => snapshotIds.has(id)).sort((a, b) => a - b);

      // The allowlist is what saved the b45f036e reboot from spawning 132 PTYs:
      // 180 snapshots on disk, only referenced ones come back.
      //
      // Referenced-but-uncovered sessions exist in this capture (981, 998,
      // 999): the pre-A3 build deleted their snapshots at its last boot and
      // they stayed idle after, so a reboot cannot bring them back. That gap
      // is real production state — A3 stopped the deletion, but the fix only
      // protects sessions once a server carrying it has run.
      const uncovered = [...referencedIds()].filter((id) => !snapshotIds.has(id));
      expect(uncovered.length).toBeGreaterThan(0);
      expect(restored).toEqual(expected);
      expect(FIXTURE.snapshots.length).toBeGreaterThan(restored.length * 5);

      // Stale manifests — every one of them, after a reboot — are swept.
      for (const m of FIXTURE.manifests) {
        const kept = manager.list().some((s) => s.id === m.id);
        if (!kept) expect(existsSync(resolve(dir, `session-${m.id}.json`))).toBe(false);
      }
    } finally {
      delete process.env.TTYM_RUNTIME_DIR;
    }
  }, 60_000);

  it('loads every workspace without losing a member — A4 against real data', async () => {
    materialize(dir);
    const store = new WorkspaceStore(dir);
    await store.load();

    const before = FIXTURE.workspaces.workspaces;
    const after = store.list();
    expect(after.length).toBe(before.length);

    for (const ws of before) {
      const loaded = after.find((w) => w.id === ws.id)!;
      expect(loaded, ws.id).toBeDefined();
      // Same members, same names — reconcile may reorder but must not drop.
      expect(loaded.members.map((m) => m.sessionId).sort()).toEqual(
        ws.members.map((m: { sessionId: number }) => m.sessionId).sort(),
      );
      expect(new Set(loaded.members.map((m) => m.name))).toEqual(
        new Set(ws.members.map((m: { name: string }) => m.name)),
      );
    }
  });

  it('round-trips the store file as version 2 — the rollback door stays open', async () => {
    materialize(dir);
    const store = new WorkspaceStore(dir);
    await store.load();
    await store.save();

    const written = JSON.parse(readFileSync(resolve(dir, 'workspaces.json'), 'utf8'));
    expect(written.version).toBe(2);
    expect(written.workspaces.length).toBe(FIXTURE.workspaces.workspaces.length);

    // A second store — standing in for the previous server build's reader —
    // must load what this one wrote.
    const again = new WorkspaceStore(dir);
    await again.load();
    expect(again.list().length).toBe(FIXTURE.workspaces.workspaces.length);
  });
});
