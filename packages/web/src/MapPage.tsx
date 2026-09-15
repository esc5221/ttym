import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  API_BASE, navigate, streamOf, UNSORTED_STREAM,
  apiUpdateWorkspace, apiAddStream, apiRenameStream, apiRemoveStream, apiReorderStreams,
  type Workspace,
} from './app-shared.js';

/**
 * 작업 지도 — 메인 화면의 두 번째 얼굴, 이제 보드.
 *
 * 세로 칸 하나가 stream이다. workspace 카드를 칸 사이로 끌어 옮기면 그 workspace의
 * stream이 바뀌고(map.stream), 칸 머리를 좌우로 끌면 stream 순서가 바뀐다
 * (streams 목록). 맨 끝 "+ new stream"으로 빈 stream을 만든다. 카드 안의 세션
 * 요약은 그대로 — 서버가 조립한 /api/map(요약 + 배치)을 읽고, 정리는 workspace·
 * stream 엔드포인트로 되돌린다. 요약 생산은 여전히 CLI(`ttym map refresh`) 몫.
 *
 * 드래그는 라이브러리 없이 마우스로. 탭 줄의 재배치와 같은 문법(4px 문턱,
 * 중점 넘기기, elementFromPoint로 드롭 대상 찾기) — 세로 칸일 뿐이다.
 */

interface MapSummary {
  title?: string;
  note?: string;
  status?: 'wait' | 'run' | 'done' | 'warn' | null;
  statusNote?: string;
  atSeq?: number;
  updatedAt?: number;
}

interface MapSessionRow {
  id: number;
  cmd: string[];
  createdAt: number;
  lastSeq: number;
  agentKind: string | null;
  agentActive: boolean;
  summary: MapSummary | null;
  stale: boolean;
}

interface MapWorkspace extends Workspace {
  map?: { stream?: string; column?: number; order?: number; updatedAt?: number };
}

interface MapData {
  generatedAt: number;
  workspaces: MapWorkspace[];
  streams: string[];
  sessions: MapSessionRow[];
}

const MAP_CSS = `
.wmap {
  --wm-tx:var(--text, #d4d4d4); --wm-soft:#9a9a9a; --wm-dim:#616161; --wm-faint:#464646;
  --wm-line:var(--line, #333336);
  --wm-claude:var(--agent-claude, #e8a34e); --wm-zsh:#6e6e6e; --wm-codex:var(--agent-codex, #6fb3c9);
  --wm-wait:#e5c07b; --wm-done:#8fbf7f; --wm-run:#6aa9e0; --wm-warn:#e06c75;
  --wu:15px;
  color:var(--wm-tx);
  font-family:var(--mono);
  font-size:calc(var(--wu)*0.92); line-height:1.75;
  height:100%; display:flex; flex-direction:column;
  padding:calc(var(--wu)*1.4) calc(var(--wu)*1.8) 0;
}
.wmap header { display:flex; align-items:center; margin-bottom:calc(var(--wu)*1.0); flex-shrink:0; }
.wmap .legend { margin-left:auto; color:var(--wm-dim); font-size:calc(var(--wu)*0.85); white-space:nowrap; cursor:default; }
.wmap .legend i { font-style:normal; }
.wmap .legend .w {
  display:inline-block; vertical-align:bottom; overflow:hidden;
  max-width:0; opacity:0;
  transition:max-width .32s cubic-bezier(.4,0,.2,1), opacity .28s ease !important;
}
.wmap .legend:hover .w { max-width:9ch; opacity:1; }
.wmap .legend:hover .w.stamp { max-width:26ch; }
.wmap .legend .stamp { color:var(--wm-faint); }
.wmap header .refresh {
  flex-shrink:0; margin-left:calc(var(--wu)*0.9);
  background:none; border:none; padding:2px; cursor:pointer;
  color:var(--wm-dim); display:inline-flex; align-items:center;
}
.wmap header .refresh:hover { color:var(--wm-tx); }
.wmap header .refresh.busy { color:var(--wm-run); cursor:default; }
.wmap header .refresh.busy svg { animation:wmap-spin 1s linear infinite !important; }
@keyframes wmap-spin { to { transform:rotate(360deg); } }

/* 보드: stream 칸이 가로로 늘어서되, 화면 폭을 넘으면 아래로 접힌다(wrap) —
   오른쪽으로 튀어나가는 가로 스크롤 대신 세로 스크롤. 칸 하나가 stream, 그 안에
   workspace 카드(박스). 칸은 넉넉히(약 330px) — 한글 요약이 세 단어쯤 한 줄에.
   칸이 길면 칸 안에서 스크롤해 줄들의 높이를 고르게 맞춘다(들쭉날쭉 방지). */
.wmb-board {
  flex:1; min-height:0; display:flex; flex-wrap:wrap; gap:calc(var(--wu)*1.6);
  align-content:flex-start; align-items:flex-start; overflow-x:hidden; overflow-y:auto;
  padding-bottom:calc(var(--wu)*1.2);
}
.wmb-col {
  flex:0 0 auto; width:calc(var(--wu)*24);
  display:flex; flex-direction:column; border-radius:8px;
  border:1px solid transparent;
}
.wmb-col.lit { border-color:var(--wm-line); background:color-mix(in srgb, var(--wm-tx) 4%, transparent); }
.wmb-head {
  display:flex; align-items:baseline; gap:calc(var(--wu)*0.5);
  font-size:calc(var(--wu)*0.95); font-weight:700; color:var(--wm-tx);
  padding:calc(var(--wu)*0.35) calc(var(--wu)*0.5) calc(var(--wu)*0.5);
  border-bottom:1px solid var(--wm-line); margin-bottom:calc(var(--wu)*0.9);
  cursor:grab; user-select:none; flex-shrink:0;
}
.wmb-head.drag { cursor:grabbing; opacity:.5; }
.wmb-head .cnt { color:var(--wm-faint); font-weight:400; font-size:calc(var(--wu)*0.82); }
.wmb-head.unsorted { color:var(--wm-soft); cursor:default; }
.wmb-head input {
  background:var(--bg0, #1a1a1a); color:var(--wm-tx); border:1px solid var(--wm-line);
  border-radius:4px; padding:1px 5px; font-family:var(--mono);
  font-size:calc(var(--wu)*0.9); width:calc(var(--wu)*14); outline:none;
}
.wmb-cards { padding:0 calc(var(--wu)*0.5) calc(var(--wu)*0.5); }
.wmb-card {
  border:1px solid var(--wm-line); border-radius:7px;
  padding:calc(var(--wu)*0.6) calc(var(--wu)*0.8) calc(var(--wu)*0.65);
  margin-bottom:calc(var(--wu)*0.7); cursor:grab; background:color-mix(in srgb, var(--wm-tx) 2.5%, transparent);
}
.wmb-card:last-child { margin-bottom:0; }
.wmb-card.drag { opacity:.5; cursor:grabbing; }
.wmb-card .wsh { color:var(--wm-soft); font-size:calc(var(--wu)*0.85); margin-bottom:calc(var(--wu)*0.3); }
.wmb-card .wsh b { color:var(--wm-tx); font-weight:700; cursor:pointer; }
.wmb-card .wsh .d { color:var(--wm-faint); margin-left:calc(var(--wu)*0.5); }
.wmb-empty { color:var(--wm-dim); font-size:calc(var(--wu)*0.82); padding:calc(var(--wu)*0.4) calc(var(--wu)*0.6); }

.wmb-newcol { width:calc(var(--wu)*13); }
.wmb-newcol button {
  width:100%; text-align:left; background:none; border:1px dashed var(--wm-line);
  border-radius:8px; color:var(--wm-dim); font-family:var(--mono);
  font-size:calc(var(--wu)*0.9); padding:calc(var(--wu)*0.45) calc(var(--wu)*0.6); cursor:pointer;
}
.wmb-newcol button:hover, .wmb-newcol.lit button { color:var(--wm-tx); border-color:var(--wm-soft); }

/* 세션 트리 — 카드 안. 괘선은 선으로 그린다(두 줄로 감겨도 안 끊긴다). */
.wmap .s { position:relative; display:flex; align-items:baseline; cursor:pointer; border-radius:4px; padding-left:calc(var(--wu)*0.9); }
.wmap .s::before { content:''; position:absolute; left:calc(var(--wu)*0.3); top:0; height:100%; width:1px; background:var(--wm-faint); }
.wmap .s.last::before { height:0.9em; }
.wmap .s::after { content:''; position:absolute; left:calc(var(--wu)*0.3); top:0.9em; width:calc(var(--wu)*0.5); height:1px; background:var(--wm-faint); }
.wmap .s:hover { background:color-mix(in srgb, var(--wm-tx) 5%, transparent); }
.wmap .s .id { color:var(--wm-soft); min-width:calc(var(--wu)*2.4); padding-right:calc(var(--wu)*0.5); flex-shrink:0; }
.wmap .s .id::before { content:'●'; font-size:calc(var(--wu)*0.62); margin-right:calc(var(--wu)*0.35); vertical-align:calc(var(--wu)*0.08); }
.wmap .s.claude .id::before { color:var(--wm-claude); }
.wmap .s.zsh .id::before { color:var(--wm-zsh); }
.wmap .s.codex .id::before { color:var(--wm-codex); }
.wmap .s .what { color:var(--wm-soft); min-width:0; }
.wmap .s .what b { color:var(--wm-tx); font-weight:650; }
.wmap .s.off { opacity:.45; }
.wmap .st { white-space:nowrap; }
.wmap .st::before { content:'— '; color:var(--wm-faint); }
.wmap .st.wait { color:var(--wm-wait); }
.wmap .st.done { color:var(--wm-done); }
.wmap .st.run  { color:var(--wm-run); }
.wmap .st.warn { color:var(--wm-warn); }
.wmap .agestamp { color:var(--wm-faint); margin-left:calc(var(--wu)*0.5); font-size:calc(var(--wu)*0.78); }
.wmap .empty-hint { color:var(--wm-dim); font-size:calc(var(--wu)*0.82); margin-left:calc(var(--wu)*1.4); margin-right:calc(var(--wu)*0.6); }
.wmap .empty-hint code { color:var(--wm-soft); }
body.wmb-dragging { cursor:grabbing; user-select:none; }
`;

function ensureMapCss() {
  const el = document.getElementById('wmap-css');
  if (el) { el.textContent = MAP_CSS; return; }
  const style = document.createElement('style');
  style.id = 'wmap-css';
  style.textContent = MAP_CSS;
  document.head.appendChild(style);
}

function dotClass(kind: string | null): string {
  if (kind === 'claude-code') return 'claude';
  if (kind === 'codex') return 'codex';
  return 'zsh';
}

function shortDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function ago(ts: number | undefined, now: number): string {
  if (!ts) return '';
  const m = Math.floor((now - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

interface Column { name: string; workspaces: MapWorkspace[] }

/** 포인터 아래의 칸 이름. "+ new stream"이면 NEW_COL. 없으면 null. */
const NEW_COL = ' new';
function columnAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (el.closest('[data-wmb-newcol]')) return NEW_COL;
  const col = el.closest('[data-wmb-col]') as HTMLElement | null;
  return col?.dataset.wmbCol ?? null;
}

export function MapPage() {
  const [data, setData] = useState<MapData | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/map`);
      if (!res.ok) return;
      const body = await res.json() as MapData;
      setData(body);
      setNow(Date.now());
    } catch {}
  }, []);

  useEffect(() => {
    ensureMapCss();
    void load();
    const timer = setInterval(() => void load(), 30_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const runRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch(`${API_BASE}/api/map/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } catch {}
    await load();
    setRefreshing(false);
  }, [load]);

  // ── 편집: 낙관적으로 로컬을 먼저 고치고, 엔드포인트를 친 뒤 다시 읽는다.
  //    지도는 실시간이 아니라, 200ms 안착 정도의 깜빡임은 감수한다. ──
  const patchLocal = (fn: (d: MapData) => MapData) => setData((d) => (d ? fn(d) : d));
  const moveWorkspace = useCallback((wsId: string, stream: string | undefined) => {
    patchLocal((d) => ({
      ...d,
      streams: stream && !d.streams.includes(stream) ? [...d.streams, stream] : d.streams,
      workspaces: d.workspaces.map((w) => (w.id === wsId ? { ...w, map: { ...w.map, stream } } : w)),
    }));
    const w = data?.workspaces.find((x) => x.id === wsId);
    void apiUpdateWorkspace(wsId, { map: { stream, column: w?.map?.column, order: w?.map?.order } }).then(load);
  }, [data, load]);
  const createStream = useCallback((name: string) => {
    patchLocal((d) => ({ ...d, streams: d.streams.includes(name) ? d.streams : [...d.streams, name] }));
    void apiAddStream(name).then(load);
  }, [load]);
  const renameStream = useCallback((from: string, to: string) => {
    patchLocal((d) => ({
      ...d,
      streams: d.streams.includes(to) ? d.streams.filter((s) => s !== from) : d.streams.map((s) => (s === from ? to : s)),
      workspaces: d.workspaces.map((w) => (streamOf(w) === from ? { ...w, map: { ...w.map, stream: to } } : w)),
    }));
    void apiRenameStream(from, to).then(load);
  }, [load]);
  const removeStream = useCallback((name: string) => {
    patchLocal((d) => ({
      ...d,
      streams: d.streams.filter((s) => s !== name),
      workspaces: d.workspaces.map((w) => (streamOf(w) === name ? { ...w, map: { ...w.map, stream: undefined } } : w)),
    }));
    void apiRemoveStream(name).then(load);
  }, [load]);
  const reorderStreams = useCallback((names: string[]) => {
    patchLocal((d) => ({ ...d, streams: names }));
    void apiReorderStreams(names).then(load);
  }, [load]);

  const view = useMemo(() => {
    if (!data) return null;
    const sessionById = new Map(data.sessions.map((s) => [s.id, s]));
    const inWorkspace = new Set<number>();
    for (const w of data.workspaces) for (const m of w.members) inWorkspace.add(m.sessionId);

    // 칸 = streams 목록 순서. 목록에 없는 이름(낡은 데이터)은 뒤에, 미분류는 그 뒤.
    const byName = new Map<string, MapWorkspace[]>();
    for (const name of data.streams) byName.set(name, []);
    const extra: string[] = [];
    for (const w of data.workspaces) {
      const name = streamOf(w);
      let arr = byName.get(name);
      if (!arr) { arr = []; byName.set(name, arr); if (name !== UNSORTED_STREAM) extra.push(name); }
      arr.push(w);
    }
    for (const arr of byName.values()) arr.sort((a, b) => (a.map?.order ?? 99) - (b.map?.order ?? 99));
    const named = [...data.streams, ...extra];
    const columns: Column[] = named.map((name) => ({ name, workspaces: byName.get(name) ?? [] }));
    const unsorted = byName.get(UNSORTED_STREAM);
    if (unsorted && unsorted.length > 0) columns.push({ name: UNSORTED_STREAM, workspaces: unsorted });

    const standalone = data.sessions.filter((s) => !inWorkspace.has(s.id));
    const counts = { claude: 0, codex: 0, zsh: 0, wait: 0 };
    for (const s of data.sessions) {
      if (s.agentKind === 'claude-code') counts.claude++;
      else if (s.agentKind === 'codex') counts.codex++;
      else counts.zsh++;
      if (s.summary?.status === 'wait') counts.wait++;
    }
    const newestSummary = Math.max(0, ...data.sessions.map((s) => s.summary?.updatedAt ?? 0));
    const summarized = data.sessions.some((s) => s.summary);
    return { sessionById, columns, standalone, counts, newestSummary, summarized };
  }, [data]);

  // ── 드래그: 카드는 칸 사이로, 머리는 좌우로 ──
  const [dragCard, setDragCard] = useState<string | null>(null);
  const [dragHead, setDragHead] = useState<string | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const streamOrder = useMemo(() => (view ? view.columns.map((c) => c.name).filter((n) => n !== UNSORTED_STREAM) : []), [view]);

  const beginCardDrag = (wsId: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) { moved = true; suppressClick.current = true; setDragCard(wsId); document.body.classList.add('wmb-dragging'); }
      setLit(columnAt(ev.clientX, ev.clientY));
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('wmb-dragging');
      setDragCard(null); setLit(null);
      if (!moved) return;
      const at = columnAt(ev.clientX, ev.clientY);
      if (at === NEW_COL) setCreating({ wsId });
      else if (at !== null) moveWorkspace(wsId, at === UNSORTED_STREAM ? undefined : at);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const beginHeadDrag = (name: string, e: React.MouseEvent) => {
    if (e.button !== 0 || renaming !== null) return;
    const sx = e.clientX;
    let moved = false;
    let order = streamOrder.slice();
    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - sx) < 4) return;
      if (!moved) { moved = true; suppressClick.current = true; setDragHead(name); document.body.classList.add('wmb-dragging'); }
      const heads = [...document.querySelectorAll('[data-wmb-head]')] as HTMLElement[];
      const names = heads.map((h) => h.dataset.wmbHead!).filter((n) => n !== UNSORTED_STREAM);
      const from = names.indexOf(name);
      if (from === -1) return;
      let to = from;
      heads.forEach((el) => {
        const n = el.dataset.wmbHead!;
        const i = names.indexOf(n);
        if (i === -1) return;
        const r = el.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (i < from && ev.clientX < mid) to = Math.min(to, i);
        else if (i > from && ev.clientX > mid) to = Math.max(to, i);
      });
      if (to !== from) { order = names.slice(); order.splice(from, 1); order.splice(to, 0, name); setDragOrder(order); }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('wmb-dragging');
      setDragHead(null); setDragOrder(null);
      if (moved && order.join('\n') !== streamOrder.join('\n')) reorderStreams(order);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [mergeArmed, setMergeArmed] = useState(false);
  const [creating, setCreating] = useState<{ wsId?: string } | null>(null);
  const [createDraft, setCreateDraft] = useState('');
  const [menu, setMenu] = useState<{ name: string; x: number; y: number; armed: boolean } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const raf = requestAnimationFrame(() => { window.addEventListener('click', close); window.addEventListener('contextmenu', close); });
    return () => { cancelAnimationFrame(raf); window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); };
  }, [menu?.name]);

  if (!data || !view) {
    return <div className="wmap"><div className="empty-hint">loading…</div></div>;
  }

  const commitRename = () => {
    if (renaming === null) return;
    const to = renameDraft.trim();
    if (!to || to === renaming || to === UNSORTED_STREAM) { setRenaming(null); return; }
    if (streamOrder.includes(to) && !mergeArmed) { setMergeArmed(true); return; }
    renameStream(renaming, to);
    setRenaming(null);
  };
  const commitCreate = () => {
    const name = createDraft.trim();
    if (!name || name === UNSORTED_STREAM) { setCreating(null); return; }
    if (!streamOrder.includes(name)) createStream(name);
    if (creating?.wsId) moveWorkspace(creating.wsId, name);
    setCreating(null); setCreateDraft('');
  };

  const renderSession = (sid: number, name: string | undefined, isLast: boolean, wsId?: string) => {
    const s = view.sessionById.get(sid);
    if (!s) return null;
    const sum = s.summary;
    const title = sum?.title || name || `#${sid}`;
    const off = !s.agentKind && !sum?.note;
    const open = () => { if (wsId) navigate({ page: 'workspace', id: wsId }); else navigate({ page: 'session', id: sid }); };
    return (
      <div key={sid} className={`s ${dotClass(s.agentKind)}${off ? ' off' : ''}${isLast ? ' last' : ''}`} onClick={open}>
        <span className="id">{sid}</span>
        <div className="what">
          <b>{title}</b>
          {sum?.note ? <> {sum.note}</> : null}
          {sum?.status ? <> <span className={`st ${sum.status}`}>{sum.statusNote || sum.status}</span></> : null}
          {sum && s.stale ? <span className="agestamp">· {ago(sum.updatedAt, now)}</span> : null}
        </div>
      </div>
    );
  };

  // 드래그 중이면 임시 순서로 그린다 — 놓으면 서버 순서가 다시 온다.
  const cols = dragOrder
    ? [...dragOrder.map((n) => view.columns.find((c) => c.name === n)!).filter(Boolean),
       ...view.columns.filter((c) => c.name === UNSORTED_STREAM)]
    : view.columns;

  return (
    <div className="wmap">
      <header>
        <span className="legend">
          <i style={{ color: 'var(--wm-claude)' }}>●</i> <span className="w">claude{' '}</span>{view.counts.claude}&nbsp;&nbsp;
          {view.counts.codex > 0 ? <><i style={{ color: 'var(--wm-codex)' }}>●</i> <span className="w">codex{' '}</span>{view.counts.codex}&nbsp;&nbsp;</> : null}
          <i style={{ color: 'var(--wm-zsh)' }}>●</i> <span className="w">shell{' '}</span>{view.counts.zsh}&nbsp;&nbsp;
          <i style={{ color: 'var(--wm-wait)' }}>—</i> <span className="w">waiting{' '}</span>{view.counts.wait}
          {view.newestSummary > 0 ? <span className="w stamp">{' '}· summarized {ago(view.newestSummary, now)}</span> : null}
        </span>
        {!view.summarized ? <span className="empty-hint">no summaries yet — <code>ttym map refresh</code> or</span> : null}
        <button className={`refresh${refreshing ? ' busy' : ''}`} onClick={() => void runRefresh()} disabled={refreshing} aria-label="refresh summaries" title="refresh summaries">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
          </svg>
        </button>
      </header>

      <div className="wmb-board">
        {cols.map((g) => {
          const unsorted = g.name === UNSORTED_STREAM;
          const isRenaming = renaming === g.name;
          return (
            <div key={g.name} data-wmb-col={g.name} className={`wmb-col${lit === g.name ? ' lit' : ''}`}>
              {isRenaming ? (
                <div className="wmb-head">
                  <input
                    autoFocus value={renameDraft}
                    onChange={(e) => { setRenameDraft(e.target.value); setMergeArmed(false); }}
                    onBlur={() => setRenaming(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                      else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                    }}
                    style={mergeArmed ? { borderColor: 'var(--wm-wait)' } : undefined}
                    title={mergeArmed ? `Enter again: merge into ${renameDraft.trim()}` : 'Enter: rename · Esc: cancel'}
                  />
                  {mergeArmed ? <span style={{ color: 'var(--wm-faint)', fontSize: 10 }}>Enter again = merge</span> : null}
                </div>
              ) : (
                <div
                  data-wmb-head={g.name}
                  className={`wmb-head${unsorted ? ' unsorted' : ''}${dragHead === g.name ? ' drag' : ''}`}
                  onMouseDown={(e) => { if (!unsorted) beginHeadDrag(g.name, e); }}
                  onDoubleClick={() => { if (!unsorted) { setRenaming(g.name); setRenameDraft(g.name); setMergeArmed(false); } }}
                  onContextMenu={(e) => { e.preventDefault(); if (!unsorted) setMenu({ name: g.name, x: e.clientX, y: e.clientY, armed: false }); }}
                  title={unsorted ? '아직 stream이 없는 workspace' : `${g.name} · 더블클릭: 이름 · 드래그: 순서 · 우클릭: 메뉴`}
                >
                  <span>{g.name}</span>
                  <span className="cnt">{g.workspaces.length}</span>
                </div>
              )}
              <div className="wmb-cards">
                {g.workspaces.map((w) => (
                  <div
                    key={w.id} data-wmb-card={w.id}
                    className={`wmb-card${dragCard === w.id ? ' drag' : ''}`}
                    onMouseDown={(e) => { if ((e.target as HTMLElement).closest('.s')) return; beginCardDrag(w.id, e); }}
                    title="드래그: 다른 stream으로"
                  >
                    <div className="wsh">
                      <b onClick={(e) => { if (suppressClick.current) { suppressClick.current = false; e.stopPropagation(); return; } navigate({ page: 'workspace', id: w.id }); }}>{w.name}</b>
                      <span className="d">{shortDate(w.createdAt)}</span>
                    </div>
                    {w.members.map((m, i) => renderSession(m.sessionId, m.name, i === w.members.length - 1, w.id))}
                  </div>
                ))}
                {g.workspaces.length === 0 ? <div className="wmb-empty">empty</div> : null}
              </div>
            </div>
          );
        })}

        <div data-wmb-newcol className={`wmb-col wmb-newcol${lit === NEW_COL ? ' lit' : ''}`}>
          {creating ? (
            <div className="wmb-head">
              <input
                autoFocus value={createDraft}
                placeholder={creating.wsId ? 'new stream for card' : 'new stream'}
                onChange={(e) => setCreateDraft(e.target.value)}
                onBlur={() => setCreating(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitCreate(); }
                  else if (e.key === 'Escape') { e.preventDefault(); setCreating(null); setCreateDraft(''); }
                }}
                title="Enter: create · Esc: cancel"
              />
            </div>
          ) : (
            <button onClick={() => { setCreating({}); setCreateDraft(''); }} title="새 stream · 카드를 여기 놓아도 만든다">+ new stream</button>
          )}
        </div>

        {view.standalone.length > 0 ? (
          <div className="wmb-col">
            <div className="wmb-head unsorted"><span>standalone</span><span className="cnt">{view.standalone.length}</span></div>
            <div className="wmb-cards">
              <div className="wmb-card" style={{ cursor: 'default' }}>
                {view.standalone.map((s, i) => renderSession(s.id, undefined, i === view.standalone.length - 1))}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {menu ? (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 180), minWidth: 150, padding: 6, borderRadius: 8, border: '1px solid var(--line-strong, #555)', background: 'var(--bg1, #1e1e1e)', boxShadow: '0 12px 30px rgba(0,0,0,.45)', fontFamily: 'var(--mono)', fontSize: 12, zIndex: 60 }}
        >
          <div style={{ color: 'var(--wm-faint)', padding: '4px 8px', fontSize: 11 }}>{menu.name}</div>
          <button style={menuItem} onClick={() => { setMenu(null); setRenaming(menu.name); setRenameDraft(menu.name); setMergeArmed(false); }}>rename</button>
          {(() => {
            const i = streamOrder.indexOf(menu.name);
            const swap = (j: number) => { const o = streamOrder.slice(); [o[i], o[j]] = [o[j], o[i]]; setMenu(null); reorderStreams(o); };
            return (
              <>
                <button style={menuItem} disabled={i <= 0} onClick={() => swap(i - 1)}>move left</button>
                <button style={menuItem} disabled={i < 0 || i >= streamOrder.length - 1} onClick={() => swap(i + 1)}>move right</button>
              </>
            );
          })()}
          <div style={{ height: 1, background: 'var(--wm-line)', margin: '5px 6px 1px' }} />
          {(() => {
            const n = view.columns.find((c) => c.name === menu.name)?.workspaces.length ?? 0;
            return (
              <button
                style={{ ...menuItem, color: menu.armed ? 'var(--wm-warn)' : 'var(--wm-soft)' }}
                onClick={() => { if (n > 0 && !menu.armed) { setMenu({ ...menu, armed: true }); return; } setMenu(null); removeStream(menu.name); }}
              >
                {menu.armed ? 'confirm remove' : 'remove'}
                {n > 0 ? <span style={{ color: 'var(--wm-faint)', marginLeft: 6 }}>· {n} → {UNSORTED_STREAM}</span> : null}
              </button>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}

const menuItem: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px',
  background: 'transparent', border: 'none', color: 'var(--wm-soft)',
  fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer', borderRadius: 4,
};
