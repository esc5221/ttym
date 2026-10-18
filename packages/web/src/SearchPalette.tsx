import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as api from '@ttym/api';
import type { SearchAiState, SearchHit } from '@ttym/api';
import { API_BASE, navigate } from './app-shared.js';
import { SEARCH_KEY_LABEL, isSearchKey } from './search-key.js';

/**
 * 세션 찾기 팔레트 — ⌘K (Mac) · Ctrl+Shift+K (그 외).
 *
 * Ctrl+K를 안 쓰는 이유: 터미널에서 readline의 kill-line이라 가로채면 셸이 망가진다.
 *
 * 타이핑이 멈추면(80ms) 이 머신 안의 글자 겹침으로 곧바로 보여 준다(외부 전송 없음).
 * AI는 Enter를 눌렀을 때만 묻는다 — 타이핑마다 세션 목록이 외부로 나가지 않게. 답이 오면 결과를
 * 바꿔 끼우고, 그 뒤의 Enter가 선택한 세션을 연다. AI가 꺼져 있거나(키 없음) 실패하면
 * 글자 겹침 결과가 남고 아래 줄이 이유를 말하며, 다음 Enter가 바로 연다.
 */

const LEX_DELAY_MS = 80;
const AI_MIN_CHARS = 2;

type Status =
  | { kind: 'idle' }
  | { kind: 'lex' }
  | { kind: 'thinking' }
  | { kind: 'ai'; ai: Extract<SearchAiState, { state: 'ok' }> }
  | { kind: 'fallback'; ai: Exclude<SearchAiState, { state: 'ok' }> };

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const aiCtl = useRef<AbortController | null>(null);
  /** AI 답(또는 실패)이 도착한 질의. 같은 질의에서 Enter는 이때부터 "열기"가 된다. */
  const aiDoneFor = useRef<string | null>(null);

  const close = useCallback(() => {
    aiCtl.current?.abort(); aiDoneFor.current = null;
    setOpen(false); setQuery(''); setHits([]); setSel(0); setStatus({ kind: 'idle' });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isSearchKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    aiCtl.current?.abort(); aiDoneFor.current = null;
    const q = query.trim();
    if (!q) { setHits([]); setSel(0); setStatus({ kind: 'idle' }); return; }
    const ctl = new AbortController();
    const lexTimer = window.setTimeout(() => {
      api.searchSessions(API_BASE, q, 'lex', ctl.signal).then((r) => {
        if (aiDoneFor.current === q) return;
        setHits(r.hits); setSel(0); setStatus({ kind: 'lex' });
      }, () => {});
    }, LEX_DELAY_MS);
    return () => { ctl.abort(); window.clearTimeout(lexTimer); };
  }, [query, open]);

  const runAi = useCallback((q: string) => {
    aiCtl.current?.abort();
    const ctl = new AbortController();
    aiCtl.current = ctl;
    setStatus({ kind: 'thinking' });
    api.searchSessions(API_BASE, q, 'ai', ctl.signal).then((r) => {
      if (ctl.signal.aborted) return;
      aiDoneFor.current = q;
      const ai = r.ai;
      if (ai?.state === 'ok') { setHits(r.hits); setSel(0); setStatus({ kind: 'ai', ai }); }
      else setStatus(ai ? { kind: 'fallback', ai } : { kind: 'lex' });
    }, (err) => {
      if (ctl.signal.aborted) return;
      aiDoneFor.current = q;
      setStatus({ kind: 'fallback', ai: { state: 'error', error: String(err?.message ?? err), ms: 0 } });
    });
  }, []);

  const pick = useCallback((hit: SearchHit | undefined) => {
    if (!hit) return;
    close();
    // pane=<세션>은 데스크톱에서 그 pane에 포커스를 주고, 폰에서는 그 세션을 전체 화면으로 연다.
    navigate(hit.workspaceId ? { page: 'workspace', id: hit.workspaceId, pane: hit.id } : { page: 'session', id: hit.id });
  }, [close]);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const q = query.trim();
      if (status.kind === 'thinking') return;
      if (q.length >= AI_MIN_CHARS && aiDoneFor.current !== q) runAi(q);
      else pick(hits[sel]);
    }
  };

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <>
      <button onClick={() => setOpen(true)} style={triggerStyle} aria-label="find session" title={`find session · ${SEARCH_KEY_LABEL}`}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="11" cy="11" r="6.5" /><line x1="16" y1="16" x2="21" y2="21" />
        </svg>
      </button>
      {open ? createPortal(
        <div style={backdropStyle} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div role="dialog" aria-modal="true" aria-label="find session" style={panelStyle}>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="어떤 세션이었더라… (내용으로 찾기)"
              spellCheck={false}
              style={inputStyle}
            />
            <div style={listStyle}>
              {hits.map((h, i) => (
                <div
                  key={h.id}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => pick(h)}
                  style={{ ...rowStyle, background: i === sel ? 'var(--bg2)' : 'transparent' }}
                >
                  <span style={{ color: 'var(--text-dim)', width: 52, flexShrink: 0 }}>%{h.id}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ color: 'var(--text)' }}>{h.title || '(제목 없음)'}</span>
                    {h.note ? <span style={{ color: 'var(--text-dim)' }}> — {h.note}</span> : null}
                    <div style={{ color: 'var(--text-soft)', fontSize: 10.5 }}>{h.workspace ? `${h.workspace} · ${h.member}` : '(workspace 없음)'}</div>
                  </span>
                  <span style={{ color: h.via === 'ai' ? 'var(--accent)' : 'var(--text-dim)', fontSize: 10.5, flexShrink: 0 }}>
                    {h.via === 'ai' ? `${Math.round(h.p * 100)}%` : 'text'}
                  </span>
                </div>
              ))}
              {hits.length === 0 && query.trim() && status.kind !== 'thinking' && status.kind !== 'idle' ? (
                <div style={{ ...rowStyle, color: 'var(--text-dim)' }}>
                  {status.kind === 'lex' && query.trim().length >= AI_MIN_CHARS ? '글자 일치 없음 — Enter로 AI에게 묻기' : '일치하는 세션이 없다'}
                </div>
              ) : null}
            </div>
            <div style={footStyle}>{statusLine(status)}</div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function statusLine(s: Status): string {
  switch (s.kind) {
    case 'idle': return `Enter AI로 찾기 · ↑↓ 선택 · Esc 닫기 · ${SEARCH_KEY_LABEL}`;
    case 'lex': return '글자 일치 (이 머신 안) · Enter로 AI에게 묻기';
    case 'thinking': return 'AI에게 묻는 중…';
    case 'ai': return `AI · ${(s.ai.ms / 1000).toFixed(1)}s · 세션 ${s.ai.asked}개${s.ai.cost !== null ? ` · $${s.ai.cost.toFixed(5)}` : ''}`;
    case 'fallback': return s.ai.state === 'no-key'
      ? '글자 일치만 — AI 검색은 settings → search 에서 API 키를 넣으면 켜진다'
      : `글자 일치만 — AI 검색 실패: ${s.ai.state === 'error' ? s.ai.error : ''}`;
  }
}

const triggerStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer',
  padding: 4, display: 'inline-flex', alignItems: 'center',
};
const backdropStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh',
};
const panelStyle: React.CSSProperties = {
  width: 640, maxWidth: 'calc(100vw - 32px)', maxHeight: '70vh',
  background: 'var(--bg1)', border: '1px solid var(--line-strong)', borderRadius: 10,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  fontFamily: 'var(--mono)', fontSize: 12.5, boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
};
const inputStyle: React.CSSProperties = {
  background: 'var(--bg0)', color: 'var(--text)', border: 'none', borderBottom: '1px solid var(--line)',
  padding: '12px 14px', fontFamily: 'var(--mono)', fontSize: 14, outline: 'none',
};
const listStyle: React.CSSProperties = { overflowY: 'auto', flex: 1, minHeight: 0 };
const rowStyle: React.CSSProperties = {
  display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 14px', cursor: 'pointer',
};
const footStyle: React.CSSProperties = {
  borderTop: '1px solid var(--line)', padding: '6px 14px', color: 'var(--text-dim)', fontSize: 10.5,
};
