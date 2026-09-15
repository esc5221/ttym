import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  insertPane,
  splitPane,
  removePane,
  presetLayout,
  isLayoutPreset,
  layoutSessionIds,
  layoutFromSessionIds,
} from '@ttym/shared';

// ───── Layout Tree Types ─────

export interface PaneNode {
  type: 'pane';
  sessionId: number;
}

export interface SplitNode {
  type: 'split';
  axis: 'row' | 'col';
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;

/** 작업 지도에서의 배치 — 요약기가 쓰고 지도 뷰가 읽는다. 없으면 미분류. */
export interface WorkspaceMapAnnotation {
  stream?: string;
  column?: number;
  order?: number;
  updatedAt?: number;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  layout: LayoutNode;
  members: WorkspaceMemberInfo[];
  map?: WorkspaceMapAnnotation;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceMemberInfo {
  sessionId: number;
  name: string;
  role?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: 3;
  workspaces: WorkspaceInfo[];
  /** stream 이름의 순서. 없으면 workspace 등장 순으로 만든다 (구 파일). */
  streams?: string[];
}

/** stream 없는 workspace의 이름. 웹·CLI와 같은 문자열이어야 한다 — 이 이름은 목록에 넣지 않는다. */
export const UNSORTED_STREAM = '미분류';


/** v2 시절 파일: project 필드가 있었다 — 로드 시 폐기된다. */
interface V2WorkspaceInfo extends WorkspaceInfo {
  project?: string;
}

interface V2StoreFile {
  version: 2;
  workspaces: V2WorkspaceInfo[];
}

// ───── WorkspaceStore ─────


export interface WorkspaceChangeEvent {
  generation: number;
  workspace?: WorkspaceInfo;
  deletedId?: string;
  /** 탭 재배치: 전체 id 순열. 부분 diff가 아니라 순서 전체를 다시 말한다. */
  order?: string[];
  /** stream 목록이 바뀜: 전체 순서. 만들기·순서·이름·제거 모두 이것으로 말한다. */
  streams?: string[];
}

export class WorkspaceStore {
  private workspaces = new Map<string, WorkspaceInfo>();
  /**
   * stream 이름과 순서. 진실은 여전히 각 workspace의 map.stream이고, 이 목록은
   * (1) workspace가 하나도 없는 stream을 살려두고 (2) 순서를 등장 순이 아니라
   * 정한 순서로 만든다. workspace에 목록에 없는 이름이 붙으면 뒤에 붙여
   * 항상 합집합을 유지한다 — 요약기와 --stream이 이 경로로 들어온다.
   */
  private streams: string[] = [];
  /** Runtime only: never written to workspaces.json, so the format is unchanged. */
  private lastDiagnostics = new Map<string, string[]>();
  private readonly filePath: string;
  private dirty = false;
  private savePromise: Promise<void> | null = null;
  private saveQueued = false;

  constructor(runtimeDir: string) {
    this.filePath = resolve(runtimeDir, 'workspaces.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as StoreFile | V2StoreFile;
      let entries: Array<WorkspaceInfo & { project?: string }> = [];
      if ((data as StoreFile).version === 3 && Array.isArray((data as StoreFile).workspaces)) {
        entries = (data as StoreFile).workspaces;
      } else if ((data as V2StoreFile).version === 2 && Array.isArray((data as V2StoreFile).workspaces)) {
        entries = (data as V2StoreFile).workspaces; // project 필드는 아래에서 폐기
        this.dirty = true; // 첫 save가 v3로 승격
      }
      const saved = (data as StoreFile).streams;
      this.streams = Array.isArray(saved) ? saved.filter((s) => typeof s === 'string' && s.trim() && s !== UNSORTED_STREAM) : [];
      for (const entry of entries) {
        const { project: _dropped, ...ws } = entry;
        // 이름이 곧 주소다(project 소멸의 대가) — 파일에 중복이 있으면 뒤의 것이
        // -2, -3…을 받고 경고를 남긴다. 조용히 한쪽을 삼키지 않는다.
        let name = ws.name;
        for (let n = 2; this.hasName(name); n++) name = `${ws.name}-${n}`;
        if (name !== ws.name) {
          console.warn(`[ws ${ws.id}] duplicate name "${ws.name}" → "${name}"`);
          this.dirty = true;
        }
        this.workspaces.set(ws.id, this.normalizeWorkspace({ ...ws, name }));
        this.adoptStream(ws.map?.stream);
      }
      // 구버전 파일은 다음 변경을 기다리지 않고 부팅 즉시 승격한다.
      if (this.dirty) void this.save();
    } catch {}
  }

  private hasName(name: string, exceptId?: string): boolean {
    for (const ws of this.workspaces.values()) {
      if (ws.id !== exceptId && ws.name === name) return true;
    }
    return false;
  }

  async save(): Promise<void> {
    if (this.savePromise) {
      this.saveQueued = true;
      await this.savePromise;
      if (!this.dirty) return;
    }

    this.savePromise = (async () => {
      do {
        this.saveQueued = false;
        const data: StoreFile = {
          version: 3,
          workspaces: Array.from(this.workspaces.values()),
          streams: this.streams,
        };
        const tmpPath = this.filePath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(data, null, 2));
        await rename(tmpPath, this.filePath);
        this.dirty = false;
      } while (this.saveQueued || this.dirty);
    })();

    try {
      await this.savePromise;
    } finally {
      this.savePromise = null;
    }
  }

  private changeListeners = new Set<(event: WorkspaceChangeEvent) => void>();
  private changeGeneration = 0;

  /** Every mutation announces the whole workspace — full tree, never a diff.
   *  A diff protocol desynchronizes forever after one missed frame; the tree
   *  is small enough to resend whole with a generation to order by. */
  onChange(listener: (event: WorkspaceChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(change: { workspace?: WorkspaceInfo; deletedId?: string; order?: string[]; streams?: string[] }): void {
    const event: WorkspaceChangeEvent = { generation: ++this.changeGeneration, ...change };
    for (const listener of this.changeListeners) {
      try { listener(event); } catch {}
    }
  }

  /** 예약됐지만 아직 끝나지 않은 저장. 종료 시 이것을 기다리면 유실이 없다. */
  private inFlight: Promise<void> | null = null;

  private scheduleSave(): void {
    if (!this.dirty) {
      this.dirty = true;
      // Debounce: save on next tick to batch rapid changes
      this.inFlight = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          if (!this.dirty) { resolve(); return; }
          this.save().catch(() => {}).finally(resolve);
        });
      });
    }
  }

  /**
   * 예약된 저장이 끝날 때까지 기다린다.
   *
   * 변경은 microtask 로 미뤄지므로, 부른 쪽이 곧바로 파일을 읽거나 디렉터리를
   * 지우면 저장이 그 뒤에 도착한다. 테스트에서 afterEach 가 임시 디렉터리를
   * 지운 뒤 rename 이 ENOENT 로 터지던 것이 이 경합이었다. 서버 종료 경로에서도
   * 같은 이유로 마지막 변경이 유실될 수 있다.
   */
  async flush(): Promise<void> {
    // 예약된 것과 진행 중인 것을 먼저 비운다.
    while (this.inFlight || this.savePromise) {
      const queued = this.inFlight;
      const running = this.savePromise;
      await queued?.catch(() => {});
      await running?.catch(() => {});
      if (this.inFlight === queued) this.inFlight = null;
      if (!this.dirty && !this.inFlight && !this.savePromise) break;
    }
    // 아직 안 쓴 변경이 남아 있으면 여기서 쓴다. 이 경로가 없으면 종료 직전에
    // 들어온 변경이 예약조차 되기 전이라 통째로 사라진다.
    if (this.dirty) await this.save().catch(() => {});
  }

  list(): WorkspaceInfo[] {
    return Array.from(this.workspaces.values());
  }

  /**
   * 탭 순서 = Map 삽입순 = workspaces.json 배열순. 재배치는 순열 전체를 받아
   * Map을 다시 짓는다 — id 집합이 현재와 정확히 일치하지 않으면 거부
   * (동시 생성/삭제와 교차한 낡은 순열이 workspace를 증발시키는 사고 방지).
   */
  reorder(ids: string[]): boolean {
    const current = new Set(this.workspaces.keys());
    if (ids.length !== current.size || !ids.every((id) => current.has(id))) return false;
    const rebuilt = new Map<string, WorkspaceInfo>();
    for (const id of ids) rebuilt.set(id, this.workspaces.get(id)!);
    this.workspaces = rebuilt;
    this.scheduleSave();
    this.emitChange({ order: ids });
    return true;
  }


  get(id: string): WorkspaceInfo | undefined {
    return this.workspaces.get(id);
  }

  create(
    id: string,
    name: string,
    layout: LayoutNode,
    members: WorkspaceMemberInfo[] = [],
    map?: WorkspaceMapAnnotation,
  ): WorkspaceInfo {
    if (this.hasName(name)) throw new Error(`workspace name already exists: ${name}`);
    const now = Date.now();
    const ws = this.normalizeWorkspace({
      id,
      name,
      layout,
      members,
      ...(map ? { map: { ...map, updatedAt: now } } : {}),
      createdAt: now,
      updatedAt: now,
    });
    this.workspaces.set(id, ws);
    this.scheduleSave();
    this.emitChange({ workspace: ws });
    if (this.adoptStream(ws.map?.stream)) this.emitChange({ streams: this.streams.slice() });
    return ws;
  }

  update(
    id: string,
    patch: { name?: string; layout?: LayoutNode; members?: WorkspaceMemberInfo[]; preset?: string; map?: WorkspaceMapAnnotation | null },
  ): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    if (patch.name !== undefined) {
      if (this.hasName(patch.name, id)) throw new Error(`workspace name already exists: ${patch.name}`);
      ws.name = patch.name;
    }
    if (patch.layout !== undefined) ws.layout = patch.layout;
    if (patch.preset !== undefined && isLayoutPreset(patch.preset)) {
      // tmux select-layout: re-attach the same members to a fresh tree —
      // membership order decides who gets the main pane, sessions untouched.
      ws.layout = presetLayout(patch.preset, ws.members.map((m) => m.sessionId));
    }
    if (patch.members !== undefined) ws.members = patch.members;
    if (patch.map !== undefined) ws.map = patch.map === null ? undefined : { ...patch.map, updatedAt: Date.now() };
    this.reconcileWorkspace(ws);
    ws.updatedAt = Date.now();
    this.scheduleSave();
    this.emitChange({ workspace: ws });
    if (this.adoptStream(ws.map?.stream)) this.emitChange({ streams: this.streams.slice() });
    return ws;
  }

  // ───── streams ─────

  /** 목록에 없는 이름이면 뒤에 붙인다. 붙였으면 true. 빈 이름·미분류는 목록에 안 넣는다. */
  private adoptStream(name: string | undefined): boolean {
    const s = name?.trim();
    if (!s || s === UNSORTED_STREAM || this.streams.includes(s)) return false;
    this.streams.push(s);
    this.scheduleSave();
    return true;
  }

  listStreams(): string[] {
    return this.streams.slice();
  }

  /** 빈 stream 만들기. 이미 있으면 false. */
  addStream(name: string): boolean {
    const s = name.trim();
    if (!s || s === UNSORTED_STREAM || this.streams.includes(s)) return false;
    this.streams.push(s);
    this.scheduleSave();
    this.emitChange({ streams: this.streams.slice() });
    return true;
  }

  /**
   * 순서 바꾸기. 현재 목록과 같은 집합이어야 한다 — 탭 reorder와 같은 이유로
   * (동시 생성과 교차한 낡은 순열이 stream을 증발시키지 않게) 다르면 거부.
   */
  reorderStreams(names: string[]): boolean {
    const current = new Set(this.streams);
    if (names.length !== current.size || !names.every((n) => current.has(n))) return false;
    this.streams = names.slice();
    this.scheduleSave();
    this.emitChange({ streams: this.streams.slice() });
    return true;
  }

  /**
   * 이름 바꾸기 = 그 이름을 가진 workspace 전부의 map.stream을 고쳐 쓰는 것.
   * `to`가 이미 있으면 합쳐진다 — from은 목록에서 사라지고 to는 제자리.
   * 없으면 from의 자리에 to가 들어간다. 돌아오는 것은 바뀐 workspace 수.
   */
  renameStream(from: string, to: string): { ok: true; moved: number; merged: boolean } | { ok: false; error: string } {
    const src = from.trim();
    const dst = to.trim();
    if (!src || !dst) return { ok: false, error: 'from and to required' };
    if (src === UNSORTED_STREAM || dst === UNSORTED_STREAM) return { ok: false, error: `"${UNSORTED_STREAM}" is not a stream name` };
    const at = this.streams.indexOf(src);
    if (at === -1) return { ok: false, error: `unknown stream: ${src}` };
    if (src === dst) return { ok: true, moved: 0, merged: false };
    const merged = this.streams.includes(dst);
    if (merged) this.streams.splice(at, 1);
    else this.streams[at] = dst;
    const moved = this.retagWorkspaces(src, dst);
    this.scheduleSave();
    this.emitChange({ streams: this.streams.slice() });
    return { ok: true, moved, merged };
  }

  /** stream을 없앤다. 그 안의 workspace는 지우지 않고 미분류로 보낸다. */
  removeStream(name: string): { ok: true; moved: number } | { ok: false; error: string } {
    const s = name.trim();
    const at = this.streams.indexOf(s);
    if (at === -1) return { ok: false, error: `unknown stream: ${s}` };
    this.streams.splice(at, 1);
    const moved = this.retagWorkspaces(s, undefined);
    this.scheduleSave();
    this.emitChange({ streams: this.streams.slice() });
    return { ok: true, moved };
  }

  /** map.stream이 `from`인 workspace 전부를 `to`로. 각각 변경 이벤트를 낸다. */
  private retagWorkspaces(from: string, to: string | undefined): number {
    let n = 0;
    const now = Date.now();
    for (const ws of this.workspaces.values()) {
      if (ws.map?.stream?.trim() !== from) continue;
      ws.map = { ...ws.map, stream: to, updatedAt: now };
      ws.updatedAt = now;
      n++;
      this.emitChange({ workspace: ws });
    }
    return n;
  }

  addMember(id: string, member: Omit<WorkspaceMemberInfo, 'createdAt' | 'updatedAt'>): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    for (const other of this.workspaces.values()) {
      if (other.id === id) continue;
      if (other.members.some((entry) => entry.sessionId === member.sessionId)) {
        throw new Error(`session ${member.sessionId} already belongs to workspace ${other.id}`);
      }
    }
    this.assertUniqueMemberName(ws, member.name, member.sessionId);

    const now = Date.now();
    const existing = ws.members.find((entry) => entry.sessionId === member.sessionId);
    if (existing) {
      existing.name = member.name;
      existing.role = member.role;
      existing.tags = member.tags ?? existing.tags ?? [];
      existing.updatedAt = now;
    } else {
      ws.members.push({
        sessionId: member.sessionId,
        name: member.name,
        role: member.role,
        tags: member.tags ?? [],
        createdAt: now,
        updatedAt: now,
      });
    }

    ws.layout = insertPane(ws.layout, member.sessionId);
    this.reconcileWorkspace(ws);
    ws.updatedAt = now;
    this.scheduleSave();
    this.emitChange({ workspace: ws });
    return ws;
  }

  splitRight(
    id: string,
    targetSessionId: number | undefined,
    member: Omit<WorkspaceMemberInfo, 'createdAt' | 'updatedAt'>,
    direction: 'right' | 'left' | 'down' | 'up' = 'right',
  ): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    this.assertUniqueMemberName(ws, member.name, member.sessionId);

    const now = Date.now();
    ws.members.push({
      sessionId: member.sessionId,
      name: member.name,
      role: member.role,
      tags: member.tags ?? [],
      createdAt: now,
      updatedAt: now,
    });

    // A real split now: the target pane is replaced by a two-way split and
    // keeps its slot size, so nothing else in the layout moves.
    const axis = direction === 'down' || direction === 'up' ? 'col' as const : 'row' as const;
    const before = direction === 'left' || direction === 'up';
    ws.layout = targetSessionId === undefined
      ? insertPane(ws.layout, member.sessionId)
      : splitPane(ws.layout, targetSessionId, member.sessionId, axis, 0.5, before);
    this.reconcileWorkspace(ws);
    ws.updatedAt = now;
    this.scheduleSave();
    this.emitChange({ workspace: ws });
    return ws;
  }

  removeMember(id: string, sessionId: number): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    ws.members = ws.members.filter((entry) => entry.sessionId !== sessionId);
    ws.layout = removePane(ws.layout, sessionId);
    this.reconcileWorkspace(ws);
    ws.updatedAt = Date.now();
    this.scheduleSave();
    this.emitChange({ workspace: ws });
    return ws;
  }

  renameMember(id: string, sessionId: number, name: string): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    this.assertUniqueMemberName(ws, name, sessionId);
    const member = ws.members.find((entry) => entry.sessionId === sessionId);
    if (!member) return null;
    member.name = name;
    member.updatedAt = Date.now();
    this.reconcileWorkspace(ws);
    ws.updatedAt = Date.now();
    this.scheduleSave();
    this.emitChange({ workspace: ws });
    return ws;
  }

  delete(id: string): boolean {
    const deleted = this.workspaces.delete(id);
    if (deleted) {
      this.scheduleSave();
      this.emitChange({ deletedId: id });
    }
    return deleted;
  }

  private normalizeWorkspace(ws: WorkspaceInfo): WorkspaceInfo {
    const normalized: WorkspaceInfo = {
      ...ws,
      members: Array.isArray(ws.members) ? ws.members.map((member) => ({ ...member })) : [],
    };
    this.reconcileWorkspace(normalized);
    return normalized;
  }

  /**
   * Bring `members` in line with the layout without losing anything.
   *
   * This used to rebuild the list purely from the layout's leaves, so a member
   * the layout did not mention was dropped — name, role and tags with it, and
   * without a word. Two members holding the same name silently became one.
   *
   * Every mutation path now updates both sides together, so a mismatch means
   * something outside those paths wrote the file or a bug did. Either way the
   * answer is to report it, not to quietly pick a winner.
   */
  private reconcileWorkspace(ws: WorkspaceInfo): void {
    const placed = layoutSessionIds(ws.layout);
    const now = Date.now();
    const bySession = new Map(ws.members.map((member) => [member.sessionId, member]));
    const usedNames = new Set<string>();
    const reconciled: WorkspaceMemberInfo[] = [];
    const problems: string[] = [];

    const claimName = (preferred: string | undefined, ordinal: number): string => {
      if (preferred && !usedNames.has(preferred)) {
        usedNames.add(preferred);
        return preferred;
      }
      const fresh = this.nextMemberName(usedNames, ordinal);
      if (preferred) problems.push(`duplicate name "${preferred}" renamed to "${fresh}"`);
      usedNames.add(fresh);
      return fresh;
    };

    // Members the layout places, in layout order.
    placed.forEach((sessionId, index) => {
      const existing = bySession.get(sessionId);
      bySession.delete(sessionId);
      reconciled.push({
        sessionId,
        name: claimName(existing?.name, index + 1),
        role: existing?.role,
        tags: existing?.tags ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing?.updatedAt ?? now,
      });
    });

    // Anything left over is a member the layout does not show. Keep it — its
    // name and role are the only record that it exists.
    for (const orphan of bySession.values()) {
      problems.push(`member "${orphan.name}" (session ${orphan.sessionId}) is not placed in the layout`);
      reconciled.push({ ...orphan, name: claimName(orphan.name, reconciled.length + 1) });
    }

    ws.members = reconciled;

    if (problems.length > 0) {
      this.lastDiagnostics.set(ws.id, problems);
      console.warn(`[ws ${ws.name}] ${problems.join('; ')}`);
    } else {
      this.lastDiagnostics.delete(ws.id);
    }
  }

  /** Problems the last reconcile found for a workspace, if any. Not persisted. */
  diagnostics(id: string): string[] {
    return this.lastDiagnostics.get(id) ?? [];
  }

  private nextMemberName(usedNames: Set<string>, start: number): string {
    let index = start;
    while (usedNames.has(`term-${index}`)) index += 1;
    return `term-${index}`;
  }

  private assertUniqueMemberName(ws: WorkspaceInfo, name: string, sessionId: number): void {
    const duplicate = ws.members.find((member) => member.name === name && member.sessionId !== sessionId);
    if (duplicate) throw new Error(`member name already exists: ${name}`);
  }
}


