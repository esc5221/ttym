import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE, navigate, type Workspace } from './app-shared.js';

/**
 * 작업 지도 — 메인 화면의 두 번째 얼굴.
 *
 * 서버가 조립한 /api/map(워크스페이스 배치 + 세션별 AI 요약)을 그리기만 한다.
 * 요약 생산은 CLI(`ttym map refresh`, claude -p) 몫 — 웹은 얇은 창.
 * 디자인은 docs/local/work-map-260813.html의 타이포그래픽 트리 그대로.
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
  height:100%; overflow-y:auto;
  padding:calc(var(--wu)*1.8) calc(var(--wu)*2.6);
}
.wmap header { display:flex; margin-bottom:calc(var(--wu)*1.2); }
/* 범례는 평소 점+숫자로 축약, 호버하면 우측 고정점 기준으로 왼쪽으로 모핑 확장.
   전역 transition:none!important를 의도적으로 뚫는다 — 이 확장이 그 예외다. */
.wmap .legend { margin-left:auto; color:var(--wm-dim); font-size:calc(var(--wu)*0.85); white-space:nowrap; cursor:default; }
.wmap .legend i { font-style:normal; }
.wmap .legend .w {
  display:inline-block; vertical-align:bottom; overflow:hidden;
  max-width:0; opacity:0;
  transition:max-width .32s cubic-bezier(.4,0,.2,1), opacity .28s ease !important;
}
/* max-width는 실제 내용 폭에 근접해야 곡선 전체가 쓰인다 — 크게 잡으면 초반에 스냅된다. */
.wmap .legend:hover .w { max-width:9ch; opacity:1; }
.wmap .legend:hover .w.stamp { max-width:26ch; }
.wmap .legend .stamp { color:var(--wm-faint); }
/* 최우측 고정 — 범례가 어느 쪽으로 늘어나든 이 버튼은 제자리다. */
.wmap header .refresh {
  flex-shrink:0; margin-left:calc(var(--wu)*0.9);
  background:none; border:none; padding:2px; cursor:pointer;
  color:var(--wm-dim); display:inline-flex; align-items:center;
}
.wmap header .refresh:hover { color:var(--wm-tx); }
.wmap header .refresh.busy { color:var(--wm-run); cursor:default; }
.wmap header .refresh.busy svg { animation:wmap-spin 1s linear infinite !important; }
@keyframes wmap-spin { to { transform:rotate(360deg); } }

/* 폭이 주는 만큼 열이 접힌다: 3 → 2 → 1. 열 배정은 정렬 힌트로만 쓴다. */
.wmap main { columns:3; column-gap:calc(var(--wu)*3.0); }
@media (max-width:1500px) { .wmap main { columns:2; } }
@media (max-width:920px)  { .wmap main { columns:1; } }
.wmap .stream { break-inside:avoid; margin-bottom:calc(var(--wu)*2.4); }
.wmap .stream > h2 {
  font-size:calc(var(--wu)*0.95); font-weight:700; color:var(--wm-tx); margin:0;
  padding-bottom:calc(var(--wu)*0.5); margin-bottom:calc(var(--wu)*1.1);
  border-bottom:1px solid var(--wm-line);
}
.wmap .ws { margin-bottom:calc(var(--wu)*1.6); }
.wmap .ws:last-child { margin-bottom:0; }
.wmap .wsh { color:var(--wm-soft); font-size:calc(var(--wu)*0.85); margin-bottom:calc(var(--wu)*0.2); }
.wmap .wsh b { color:var(--wm-tx); font-weight:700; }
.wmap .wsh .d { color:var(--wm-faint); margin-left:calc(var(--wu)*0.6); }

/* 트리 괘선은 문자 대신 선으로 — 두 줄로 감겨도 세로선이 끊기지 않는다. */
.wmap .s { position:relative; display:flex; align-items:baseline; cursor:pointer; border-radius:4px; padding-left:calc(var(--wu)*1.15); }
.wmap .s::before { content:''; position:absolute; left:calc(var(--wu)*0.3); top:0; height:100%; width:1px; background:var(--wm-faint); }
.wmap .s.last::before { height:0.9em; }
.wmap .s::after { content:''; position:absolute; left:calc(var(--wu)*0.3); top:0.9em; width:calc(var(--wu)*0.5); height:1px; background:var(--wm-faint); }
.wmap .s:hover { background:color-mix(in srgb, var(--wm-tx) 5%, transparent); }
.wmap .s .id { color:var(--wm-soft); width:calc(var(--wu)*3.4); flex-shrink:0; }
.wmap .s .id::before { content:'●'; font-size:calc(var(--wu)*0.62); margin-right:calc(var(--wu)*0.45); vertical-align:calc(var(--wu)*0.08); }
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
.wmap .empty-hint { color:var(--wm-dim); margin-top:calc(var(--wu)*4); text-align:center; }
.wmap .empty-hint code { color:var(--wm-soft); }
`;

function ensureMapCss() {
  if (document.getElementById('wmap-css')) return;
  const el = document.createElement('style');
  el.id = 'wmap-css';
  el.textContent = MAP_CSS;
  document.head.appendChild(el);
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

interface StreamGroup {
  name: string;
  column: number;
  order: number;
  workspaces: MapWorkspace[];
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

  // 수동 동기화: 요약기를 돌리고(서버가 CLI 스폰) 끝나면 즉시 다시 그린다.
  const runRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch(`${API_BASE}/api/map/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
    } catch {}
    await load();
    setRefreshing(false);
  }, [load]);

  const view = useMemo(() => {
    if (!data) return null;
    const sessionById = new Map(data.sessions.map((s) => [s.id, s]));
    const inWorkspace = new Set<number>();
    for (const w of data.workspaces) for (const m of w.members) inWorkspace.add(m.sessionId);

    // stream으로 묶고, 열은 그 stream 소속 workspace들의 column 다수결
    const streams = new Map<string, StreamGroup>();
    for (const w of data.workspaces) {
      const name = w.map?.stream || 'unsorted';
      let g = streams.get(name);
      if (!g) { g = { name, column: w.map?.column ?? 3, order: w.map?.order ?? 99, workspaces: [] }; streams.set(name, g); }
      g.workspaces.push(w);
      g.order = Math.min(g.order, w.map?.order ?? 99);
    }
    for (const g of streams.values()) {
      g.workspaces.sort((a, b) => (a.map?.order ?? 99) - (b.map?.order ?? 99));
    }
    const ordered = [...streams.values()].sort((a, b) => a.column - b.column || a.order - b.order);
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
    return { sessionById, ordered, standalone, counts, newestSummary, summarized };
  }, [data]);

  if (!data || !view) {
    return <div className="wmap"><div className="empty-hint">loading…</div></div>;
  }

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

  return (
    <div className="wmap">
      <header>
        <span className="legend">
          <i style={{ color: 'var(--wm-claude)' }}>●</i> <span className="w">claude{'\u00A0'}</span>{view.counts.claude}&nbsp;&nbsp;
          {view.counts.codex > 0 ? <><i style={{ color: 'var(--wm-codex)' }}>●</i> <span className="w">codex{'\u00A0'}</span>{view.counts.codex}&nbsp;&nbsp;</> : null}
          <i style={{ color: 'var(--wm-zsh)' }}>●</i> <span className="w">shell{'\u00A0'}</span>{view.counts.zsh}&nbsp;&nbsp;
          <i style={{ color: 'var(--wm-wait)' }}>—</i> <span className="w">waiting{'\u00A0'}</span>{view.counts.wait}
          {view.newestSummary > 0 ? <span className="w stamp">{'\u00A0'}· summarized {ago(view.newestSummary, now)}</span> : null}
        </span>
        <button
          className={`refresh${refreshing ? ' busy' : ''}`}
          onClick={() => void runRefresh()}
          disabled={refreshing}
          aria-label="refresh summaries"
          title="refresh summaries"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
      </header>

      {!view.summarized ? (
        <div className="empty-hint">
          no summaries yet — run <code>ttym map refresh</code> once to fill this map.
        </div>
      ) : null}

      <main>
        {view.ordered.map((g) => (
          <div className="stream" key={g.name}>
            <h2>{g.name}</h2>
            {g.workspaces.map((w) => (
              <div className="ws" key={w.id}>
                <div className="wsh">
                  <b style={{ cursor: 'pointer' }} onClick={() => navigate({ page: 'workspace', id: w.id })}>{w.name}</b>
                  <span className="d">{shortDate(w.createdAt)}</span>
                </div>
                {w.members.map((m, i) => renderSession(m.sessionId, m.name, i === w.members.length - 1, w.id))}
              </div>
            ))}
          </div>
        ))}
        {view.standalone.length > 0 ? (
          <div className="stream">
            <h2>standalone</h2>
            <div className="ws">
              {view.standalone.map((s, i) => renderSession(s.id, undefined, i === view.standalone.length - 1))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
