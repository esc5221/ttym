import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TerminalMux, Terminal, LayoutView } from '@ttym/ui';
import type { SessionInfo } from '@ttym/ui';
import { formatCwd, memberNameBySession, layoutToSessionIds, workspaceLabel, removePane, type LayoutNode } from '@ttym/shared';
import { AGENT_COLORS, AgentState, Workspace, apiDeleteWorkspace, apiRemoveMember, closeBtnStyle, copySessionUrl, emptyPaneStyle, fetchSessionMeta, fetchWorkspaces, miniLinkBtnStyle, navigate, stripBtnStyle, workspaceDisplayLabel } from './app-shared.js';

type DashPanel = { kind: 'hover' } | { kind: 'live'; sid: number } | { kind: 'ws'; wsId: string };

export function DashboardPage({ mux, agentStates, localEchoEnabled, actionsSlot }: { mux: TerminalMux; agentStates: Record<number, AgentState>; localEchoEnabled: boolean; actionsSlot: HTMLElement | null }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessionCwds, setSessionCwds] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [hoveredSessionId, setHoveredSessionId] = useState<number | null>(null);
  const [compactLayout, setCompactLayout] = useState(() => window.innerWidth < 1080);
  // 우측 패널: hover 미리보기 ↔ live 터미널(행 클릭) ↔ workspace 분할 미니뷰(제목 클릭)
  const [panel, setPanel] = useState<DashPanel>({ kind: 'hover' });
  const [hoveredWsId, setHoveredWsId] = useState<string | null>(null);
  // 모핑 하이라이트: 행별 배경 대신 리스트에 단 하나 떠 있는 박스가
  // hover 대상의 rect로 미끄러진다. variant가 곧 "무엇을 보고 있나"다.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [hl, setHl] = useState<{ top: number; left: number; width: number; height: number; variant: 'row' | 'ws'; visible: boolean }>(
    { top: 0, left: 0, width: 0, height: 0, variant: 'row', visible: false },
  );

  const moveHl = useCallback((el: HTMLElement, variant: 'row' | 'ws') => {
    const container = listRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    setHl({
      top: rect.top - cRect.top + container.scrollTop,
      left: rect.left - cRect.left,
      width: rect.width,
      height: rect.height,
      variant,
      visible: true,
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, wsList] = await Promise.all([mux.listSessions(), fetchWorkspaces()]);
      const live = list.filter((s) => s.status !== 'dead');
      setSessions(live);
      setWorkspaces(wsList);
      const cwdEntries = await Promise.all(live.map(async (session) => {
        try {
          const meta = await fetchSessionMeta(session.id);
          return [session.id, typeof meta.cwd === 'string' ? meta.cwd : ''] as const;
        } catch {
          return [session.id, ''] as const;
        }
      }));
      setSessionCwds(Object.fromEntries(cwdEntries.filter(([, cwd]) => cwd)));
    } catch {}
    setLoading(false);
  }, [mux]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    return mux.onWorkspace((event) => {
      setWorkspaces((prev) => {
        if (event.deletedId) return prev.filter((w) => w.id !== event.deletedId);
        const next = event.workspace as unknown as Workspace | undefined;
        if (!next) return prev;
        const at = prev.findIndex((w) => w.id === next.id);
        if (at === -1) return [...prev, next];
        const copy = prev.slice(); copy[at] = next; return copy;
      });
    });
  }, [mux]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1080px)');
    const sync = () => setCompactLayout(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (sessions.length === 0) {
      setHoveredSessionId(null);
      return;
    }
    if (hoveredSessionId === null || !sessions.some((session) => session.id === hoveredSessionId)) {
      setHoveredSessionId(sessions[0]!.id);
    }
  }, [sessions, hoveredSessionId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanel({ kind: 'hover' });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 죽은 세션은 membership만 걷어낸다 — 트리 정리는 서버 몫.
  useEffect(() => {
    if (loading || sessions.length === 0) return;
    const aliveIds = new Set(sessions.map((s) => s.id));
    let changed = false;
    for (const ws of workspaces) {
      for (const id of layoutToSessionIds(ws.layout)) {
        if (id > 0 && !aliveIds.has(id)) {
          void apiRemoveMember(ws.id, id);
          ws.layout = removePane(ws.layout, id);
          changed = true;
        }
      }
    }
    if (changed) setWorkspaces([...workspaces]);
  }, [sessions, loading]);

  const createSession = useCallback(async () => {
    try {
      const id = await mux.createSession({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
      mux.detachSession(id);
      navigate({ page: 'session', id });
    } catch (e) {
      console.error('Failed to create session:', e);
    }
  }, [mux]);

  const terminateSession = useCallback(async (sid: number, wsId?: string) => {
    mux.destroySession(sid);
    if (wsId) await apiRemoveMember(wsId, sid);
    await refresh();
  }, [mux, refresh]);

  const deleteWorkspaceCascade = useCallback(async (ws: Workspace) => {
    for (const sid of layoutToSessionIds(ws.layout).filter((id) => id > 0)) mux.destroySession(sid);
    await apiDeleteWorkspace(ws.id);
    await refresh();
  }, [mux, refresh]);

  const aliveIds = new Set(sessions.map((s) => s.id));
  const assigned = new Set(workspaces.flatMap((w) => layoutToSessionIds(w.layout).filter((id) => id > 0)));
  const standalone = sessions.filter((s) => !assigned.has(s.id));
  const infoBySession = new Map(sessions.map((s) => [s.id, s] as const));

  const sessionRow = (sid: number, name?: string, wsId?: string) => {
    const info = infoBySession.get(sid);
    const agent = agentStates[sid];
    const color = agent?.kind ? AGENT_COLORS[agent.kind] : undefined;
    const selected = panel.kind === 'live' && panel.sid === sid;
    return (
      <div
        key={sid}
        className="reveal-parent"
        onClick={() => setPanel({ kind: 'live', sid })}
        onMouseEnter={(e) => { setHoveredSessionId(sid); setHoveredWsId(null); moveHl(e.currentTarget, 'row'); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
          borderRadius: 8, cursor: 'pointer', minWidth: 0,
          borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
          background: selected ? 'var(--hl)' : undefined,
        }}
      >
        <span
          className={agent?.active ? 'agent-dot-run' : undefined}
          style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                   background: color ?? 'transparent', opacity: agent?.active ? 1 : 0.4 }}
        />
        <span style={{ color: 'var(--text-dim)', fontSize: 11, minWidth: 24, flexShrink: 0 }}>#{sid}</span>
        <span style={{ color: color ?? 'var(--text)', fontWeight: 600, fontSize: 12, flexShrink: 0 }}>
          {name ?? '—'}
        </span>
        <span style={{ color: 'var(--text-dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {(sessionCwds[sid] ? `${formatCwd(sessionCwds[sid])} · ` : '') + (info ? info.cmd.join(' ') : '')}
        </span>
        <button
          className="reveal"
          onClick={(e) => { e.stopPropagation(); void terminateSession(sid, wsId); }}
          style={{ ...closeBtnStyle, marginLeft: 0, flexShrink: 0 }}
          title="terminate session"
        >×</button>
      </div>
    );
  };

  // workspace 분할 미니뷰 — 고정(ws)과 hover 양쪽에서 쓴다.
  const renderWsMini = (wsId: string) => {
    const target = workspaces.find((x) => x.id === wsId);
    if (!target) return <div style={{ color: 'var(--text-dim)', padding: 20, fontSize: 12 }}>workspace is gone</div>;
    const names = memberNameBySession(target.members);
    return (
      <div style={{ flex: 1, minHeight: 0 }}>
        <LayoutView
          layout={target.layout}
          splitterColor="var(--line)"
          splitterActiveColor="var(--accent)"
          renderPane={(sid) => sid <= 0 ? (
            <div key="empty" style={{ ...emptyPaneStyle, fontSize: 11 }}>empty</div>
          ) : (
            <div key={sid} style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
              <div
                onClick={() => setPanel({ kind: 'live', sid })}
                title="click: switch to live"
                style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', background: 'var(--bg2)', borderBottom: '1px solid var(--line)', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}
              >
                <span style={{ color: agentStates[sid]?.kind ? AGENT_COLORS[agentStates[sid]!.kind!] : 'var(--text-soft)', fontWeight: 700 }}>
                  {names.get(sid) || `#${sid}`}
                </span>
                <span style={{ color: 'var(--text-dim)' }}>#{sid}</span>
              </div>
              <div style={{ flex: 1, minHeight: 0, pointerEvents: 'none' }}>
                <Terminal mux={mux} attachId={sid} mode="readonly" fontSize={10} enableWebgl={false} />
              </div>
            </div>
          )}
        />
      </div>
    );
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: compactLayout ? 'minmax(0, 1fr)' : 'minmax(360px, 460px) minmax(0, 1fr)', fontFamily: 'var(--mono)' }}>
      <div
        ref={listRef}
        className="thin-scroll"
        onMouseLeave={() => setHl((prev) => ({ ...prev, visible: false }))}
        onScroll={() => setHl((prev) => (prev.visible ? { ...prev, visible: false } : prev))}
        style={{ borderRight: compactLayout ? 'none' : '1px solid var(--line)', background: 'var(--bg1)', padding: 14, overflowY: 'auto', minHeight: 0, position: 'relative' }}
      >
        <div
          className="morph-hl"
          style={{
            position: 'absolute',
            top: hl.top,
            left: hl.left,
            width: hl.width,
            height: hl.height,
            borderRadius: hl.variant === 'ws' ? 10 : 8,
            // 콘텐츠 위에 얹는 베일 — 카드가 불투명해도 항상 보인다.
            background: 'var(--hl)',
            border: hl.variant === 'ws' ? '1px solid var(--accent-dim)' : '1px solid transparent',
            opacity: hl.visible ? 1 : 0,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        />
        {actionsSlot ? createPortal(
          <>
            <button onClick={createSession} style={stripBtnStyle}>+ session</button>
            <button onClick={refresh} style={stripBtnStyle} title="refresh">↻</button>
          </>, actionsSlot) : null}

        {loading && workspaces.length === 0 ? (
          <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 8 }}>loading…</div>
        ) : null}

        {workspaces.map((ws) => {
          const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0 && aliveIds.has(id));
          const names = memberNameBySession(ws.members);
          const running = ids.filter((id) => agentStates[id]?.active).length;
          return (
            <div key={ws.id} style={{
              border: '1px solid var(--line)', borderRadius: 10, padding: 6, marginBottom: 10, background: 'var(--bg0)',
              borderLeft: panel.kind === 'ws' && panel.wsId === ws.id ? '2px solid var(--accent)' : '1px solid var(--line)',
            }}>
              <div
                className="reveal-parent"
                onClick={() => setPanel({ kind: 'ws', wsId: ws.id })}
                onMouseEnter={(e) => { setHoveredWsId(ws.id); moveHl(e.currentTarget.parentElement as HTMLElement, 'ws'); }}
                title="hover: preview split · click: pin · tap: open"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, color: 'var(--text-soft)', cursor: 'pointer' }}
              >
                {workspaceDisplayLabel(ws)}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {running > 0 ? (
                    <>
                      <span className="agent-dot-run" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--agent-claude)' }} />
                      <span style={{ color: 'var(--text-dim)', fontSize: 10.5 }}>{running}</span>
                    </>
                  ) : null}
                  <button
                    className="reveal"
                    onClick={(e) => { e.stopPropagation(); void deleteWorkspaceCascade(ws); }}
                    style={closeBtnStyle}
                    title="delete workspace · terminates its sessions"
                  >×</button>
                </span>
              </div>
              {ids.map((sid) => sessionRow(sid, names.get(sid), ws.id))}
            </div>
          );
        })}

        {standalone.length > 0 ? (
          <>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', margin: '14px 4px 8px' }}>
              standalone
            </div>
            {standalone.map((s) => sessionRow(s.id))}
          </>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: 'var(--bg0)' }}>
        <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg1)', fontSize: 11.5, color: 'var(--text-dim)', flexShrink: 0 }}>
          {panel.kind === 'live' ? (
            <>
              <span style={{ color: 'var(--text-soft)', fontWeight: 700 }}>live</span>
              <span>#{panel.sid}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button onClick={() => navigate({ page: 'session', id: panel.sid })} style={miniLinkBtnStyle}>open</button>
                <button onClick={() => void copySessionUrl(panel.sid)} style={miniLinkBtnStyle}>copy</button>
                <button onClick={() => setPanel({ kind: 'hover' })} style={miniLinkBtnStyle} title="back to preview (esc)">×</button>
              </span>
            </>
          ) : panel.kind === 'ws' ? (
            <>
              <span style={{ color: 'var(--text-soft)', fontWeight: 700 }}>workspace</span>
              <span>{(() => { const w = workspaces.find((x) => x.id === panel.wsId); return w ? workspaceDisplayLabel(w) : panel.wsId; })()}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button onClick={() => navigate({ page: 'workspace', id: panel.wsId })} style={miniLinkBtnStyle}>open</button>
                <button onClick={() => setPanel({ kind: 'hover' })} style={miniLinkBtnStyle} title="back to preview (esc)">×</button>
              </span>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--text-soft)' }}>preview</span>
              <span>{hoveredWsId !== null
                ? (() => { const w = workspaces.find((x) => x.id === hoveredWsId); return w ? workspaceDisplayLabel(w) : hoveredWsId; })()
                : hoveredSessionId !== null ? `#${hoveredSessionId}` : 'no session'}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                {hoveredSessionId !== null ? (
                  <>
                    <button onClick={() => setPanel({ kind: 'live', sid: hoveredSessionId })} style={miniLinkBtnStyle}>live</button>
                    <button onClick={() => navigate({ page: 'session', id: hoveredSessionId })} style={miniLinkBtnStyle}>open</button>
                    <button onClick={() => void copySessionUrl(hoveredSessionId)} style={miniLinkBtnStyle}>copy</button>
                  </>
                ) : null}
              </span>
            </>
          )}
        </div>
        {panel.kind === 'live' ? (
          // 행 클릭 = 그 자리에서 바로 쓰는 터미널. 단일 대형 뷰라 GPU 허용.
          <div style={{ flex: 1, minHeight: 0 }}>
            {/* 헤더가 말하는 그대로 '프리뷰'다 — readwrite로 두면 세션의 진짜
                뷰어와 cols 리사이즈 싸움이 나고, 축소가 아니라 잘림이 된다.
                조작은 workspace/세션 페이지의 영토. */}
            <Terminal mux={mux} attachId={panel.sid} mode="readonly" fontSize={10} enableWebgl={false} />
          </div>
        ) : panel.kind === 'ws' ? (
          renderWsMini(panel.wsId)
        ) : hoveredWsId !== null ? (
          renderWsMini(hoveredWsId)
        ) : hoveredSessionId !== null ? (
          // 호버도 클릭(live)과 같은 물건이다 — 예전엔 /screen 텍스트 덤프를
          // 5초 폴링으로 HTML화해 pre-wrap으로 재줄바꿈했고, 그게 "호버만
          // 다르게 보이는" 원인의 전부였다. 같은 readonly 터미널 하나로 통일.
          <div style={{ flex: 1, minHeight: 0, pointerEvents: 'none' }}>
            <Terminal mux={mux} attachId={hoveredSessionId} mode="readonly" fontSize={10} enableWebgl={false} />
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>
            hover a session to preview
          </div>
        )}
      </div>
    </div>
  );
}

// ───── 단일 세션 페이지 ─────

