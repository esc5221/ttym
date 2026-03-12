import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalMux, Terminal } from '@ttym/client';
import '@xterm/xterm/css/xterm.css';

function App() {
  const muxRef = useRef<TerminalMux | null>(null);
  const [connected, setConnected] = useState(false);
  const [panels, setPanels] = useState<string[]>([crypto.randomUUID()]);
  const [focused, setFocused] = useState(0);
  const panelRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const mux = new TerminalMux('ws://localhost:7690');
    muxRef.current = mux;
    mux.connect().then(() => setConnected(true));
    return () => mux.disconnect();
  }, []);

  const add = useCallback(() => {
    setPanels((p) => {
      const next = [...p, crypto.randomUUID()];
      setFocused(next.length - 1);
      return next;
    });
  }, []);

  const removeAt = useCallback((index: number) => {
    setPanels((p) => {
      const next = p.filter((_, i) => i !== index);
      setFocused((f) => {
        if (next.length === 0) return 0;
        if (f >= next.length) return next.length - 1;
        if (f > index) return f - 1;
        if (f === index) return Math.min(f, next.length - 1);
        return f;
      });
      return next;
    });
  }, []);

  const focusPrev = useCallback(() => {
    setFocused((f) => (f > 0 ? f - 1 : f));
  }, []);

  const focusNext = useCallback(() => {
    setPanels((p) => {
      setFocused((f) => (f < p.length - 1 ? f + 1 : f));
      return p;
    });
  }, []);

  // 키바인딩
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Cmd + \ → 새 터미널 분할
      if (meta && e.key === '\\') {
        e.preventDefault();
        add();
        return;
      }

      // Cmd + W → 포커스된 터미널 닫기
      if (meta && e.key === 'w') {
        e.preventDefault();
        removeAt(focused);
        return;
      }

      // Cmd+← → 이전 포커스
      if (meta && e.code === 'ArrowLeft') {
        e.preventDefault();
        focusPrev();
        return;
      }

      // Cmd+→ → 다음 포커스
      if (meta && e.code === 'ArrowRight') {
        e.preventDefault();
        focusNext();
        return;
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [add, removeAt, focusPrev, focusNext, focused]);

  // 포커스 시 해당 터미널 내부 xterm에 포커스
  useEffect(() => {
    const id = panels[focused];
    if (!id) return;
    const el = panelRefs.current.get(id);
    if (!el) return;
    const textarea = el.querySelector('textarea');
    textarea?.focus();
  }, [focused, panels]);

  if (!connected || !muxRef.current) {
    return (
      <div style={{ color: '#888', padding: 40, fontFamily: 'monospace' }}>
        connecting to ttym server...
      </div>
    );
  }

  const cols = Math.min(panels.length, 3);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* toolbar */}
      <div style={toolbarStyle}>
        <button onClick={add} style={btnStyle}>
          + split
        </button>
        <span style={{ color: '#666', fontSize: 12 }}>
          {panels.length} session{panels.length > 1 ? 's' : ''}
        </span>
        <span style={{ color: '#444', fontSize: 11, marginLeft: 'auto' }}>
          {'\u2318\\ split \u2003 \u2318W close \u2003 \u2318\u2325\u2190\u2192 or \u2318[] navigate'}
        </span>
      </div>

      {/* terminal grid */}
      {panels.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'monospace',
            color: '#555',
            fontSize: 13,
            cursor: 'pointer',
          }}
          onClick={add}
        >
          {'\u2318\\ to create a terminal'}
        </div>
      ) : <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: 0,
          background: '#1e1e1e',
          overflow: 'hidden',
        }}
      >
        {panels.map((id, i) => {
          const isFocused = i === focused;
          return (
            <div
              key={id}
              ref={(el) => { if (el) panelRefs.current.set(id, el); else panelRefs.current.delete(id); }}
              onClick={() => setFocused(i)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                background: '#1e1e1e',
                minHeight: 0,
                contain: 'strict',
                borderLeft: i > 0 ? '1px solid #333' : 'none',
              }}
            >
              {/* panel title bar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 28,
                  padding: '0 8px',
                  background: isFocused ? '#1e1e1e' : '#181818',
                  borderTop: isFocused ? '2px solid #007acc' : '2px solid transparent',
                  borderBottom: '1px solid #333',
                  flexShrink: 0,
                  userSelect: 'none',
                }}
              >
                <span style={{ color: isFocused ? '#ccc' : '#666', fontSize: 11, fontFamily: 'monospace' }}>
                  zsh {i + 1}
                </span>
                {panels.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); removeAt(i); }}
                    style={closeBtnStyle}
                    title="Close (⌘W)"
                  >
                    ×
                  </button>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <Terminal mux={muxRef.current!} onExit={() => removeAt(i)} />
              </div>
            </div>
          );
        })}
      </div>}
    </div>
  );
}

const toolbarStyle: React.CSSProperties = {
  padding: '6px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  borderBottom: '1px solid #333',
  fontFamily: 'monospace',
};

const btnStyle: React.CSSProperties = {
  background: '#2d2d2d',
  color: '#ccc',
  border: '1px solid #444',
  padding: '3px 10px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 12,
  borderRadius: 3,
};

const closeBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'none',
  border: 'none',
  color: '#555',
  cursor: 'pointer',
  fontSize: 14,
  fontFamily: 'monospace',
  lineHeight: 1,
  padding: '0 4px',
  borderRadius: 3,
};

export default App;
