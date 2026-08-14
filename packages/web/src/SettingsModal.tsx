import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { refreshTerminalThemes } from '@ttym/ui';
import { API_BASE, actionBtnStyle, type UiStyle } from './app-shared.js';

/**
 * 설정 모달 — 좌측 섹션 내비 + 우측 필드 패널 (Linear/Slack preferences 모양).
 *
 * 저장소는 성격별로 셋: 일반 설정은 config(PATCH /api/config, 모든 표면 동기),
 * 요약기 API 키는 write-only 파일(POST /api/map/api-key — 절대 안 되돌아옴),
 * 요약 지시문은 서버의 map-prompt(GET/PUT — 비우면 기본값 복귀).
 */

type Section = 'general' | 'appearance' | 'map';
const SECTIONS: Section[] = ['general', 'appearance', 'map'];

interface Props {
  localEchoEnabled: boolean;
  onLocalEchoChange: (value: boolean) => void;
  uiStyle: UiStyle;
  onUiStyleChange: (value: UiStyle) => void;
  mainView: 'preview' | 'map';
  onMainViewChange: (value: 'preview' | 'map') => void;
  fontSize: number;
  onFontSizeChange: (value: number) => void;
  onThemeChange: (value: 'dark' | 'light') => void;
  onPatchConfig: (patch: Record<string, string | null>) => void;
}

export function SettingsModal(props: Props) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>('general');

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open]);

  return (
    <>
      <button onClick={() => setOpen(true)} style={triggerStyle} aria-label="settings" title="settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <line x1="21" y1="5" x2="14" y2="5" /><line x1="10" y1="5" x2="3" y2="5" />
          <line x1="21" y1="12" x2="12" y2="12" /><line x1="8" y1="12" x2="3" y2="12" />
          <line x1="21" y1="19" x2="16" y2="19" /><line x1="12" y1="19" x2="3" y2="19" />
          <line x1="14" y1="3" x2="14" y2="7" /><line x1="8" y1="10" x2="8" y2="14" /><line x1="16" y1="17" x2="16" y2="21" />
        </svg>
      </button>
      {open ? createPortal(
        <div style={backdropStyle} onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-label="settings" style={modalStyle}>
            <div style={headerStyle}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>settings</span>
              <button onClick={() => setOpen(false)} style={closeStyle}>✕</button>
            </div>
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
              <nav style={navStyle}>
                {SECTIONS.map((name) => (
                  <button
                    key={name}
                    onClick={() => setSection(name)}
                    style={{
                      ...navItemStyle,
                      background: section === name ? 'var(--bg2)' : 'transparent',
                      color: section === name ? 'var(--text)' : 'var(--text-dim)',
                    }}
                  >
                    {name}
                  </button>
                ))}
              </nav>
              <div style={panelStyle}>
                {section === 'general' ? <GeneralSection {...props} /> : null}
                {section === 'appearance' ? <AppearanceSection {...props} /> : null}
                {section === 'map' ? <MapSection onPatchConfig={props.onPatchConfig} /> : null}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

// ───── 섹션들 ─────

function GeneralSection({ mainView, onMainViewChange, localEchoEnabled, onLocalEchoChange }: Props) {
  return (
    <>
      <Field label="main view" hint="what the home page shows: live session previews, or the AI work map">
        <Segmented options={['preview', 'map'] as const} value={mainView} onChange={onMainViewChange} />
      </Field>
      <Field label="optimistic local echo" hint="experimental: predicts printable shell echo before server confirmation">
        <Segmented
          options={['off', 'on'] as const}
          value={localEchoEnabled ? 'on' : 'off'}
          onChange={(v) => onLocalEchoChange(v === 'on')}
        />
      </Field>
    </>
  );
}

function AppearanceSection({ uiStyle, onUiStyleChange, fontSize, onFontSizeChange, onThemeChange }: Props) {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'),
  );
  const applyTheme = useCallback((next: 'dark' | 'light') => {
    setTheme(next);
    if (next === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('ttym-theme', next); } catch {}
    // 터미널 배경 = 앱 배경 원칙: 살아있는 xterm들도 같은 프레임에 갈아입는다.
    refreshTerminalThemes();
    onThemeChange(next);
  }, [onThemeChange]);

  return (
    <>
      <Field label="theme">
        <Segmented options={['dark', 'light'] as const} value={theme} onChange={applyTheme} />
      </Field>
      <Field label="ui style">
        <Segmented options={['frame', 'classic'] as const} value={uiStyle} onChange={onUiStyleChange} />
      </Field>
      <Field label="font size">
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <button onClick={() => onFontSizeChange(Math.max(8, fontSize - 1))} style={{ ...actionBtnStyle, padding: '2px 8px', fontSize: 11 }}>−</button>
          <span style={{ color: 'var(--text)', fontSize: 12, width: 20, textAlign: 'center' }}>{fontSize}</span>
          <button onClick={() => onFontSizeChange(Math.min(32, fontSize + 1))} style={{ ...actionBtnStyle, padding: '2px 8px', fontSize: 11 }}>+</button>
        </span>
      </Field>
    </>
  );
}

function MapSection({ onPatchConfig }: { onPatchConfig: Props['onPatchConfig'] }) {
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [interval, setIntervalValue] = useState('');
  const [keySet, setKeySet] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isDefaultPrompt, setIsDefaultPrompt] = useState(true);
  const [savedFlash, setSavedFlash] = useState('');
  const [note, setNote] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void fetch(`${API_BASE}/api/config`).then((r) => r.json()).then(({ values }) => {
      setModel(values['map-model'] ?? '');
      setBaseUrl(values['map-base-url'] ?? '');
      setIntervalValue(values['map-interval'] ?? '');
    }).catch(() => {});
    void fetch(`${API_BASE}/api/map/api-key`).then((r) => r.json()).then((r) => setKeySet(!!r.set)).catch(() => {});
    void fetch(`${API_BASE}/api/map/prompt`).then((r) => r.json()).then((r) => {
      setPrompt(r.prompt ?? '');
      setIsDefaultPrompt(!!r.isDefault);
    }).catch(() => {});
  }, []);

  const flash = (msg: string) => {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(''), 1500);
  };

  const saveBackend = () => {
    onPatchConfig({
      'map-model': model.trim() || null,
      'map-base-url': baseUrl.trim() || null,
      'map-interval': interval.trim() || null,
    });
    flash('saved');
  };

  const saveKey = async () => {
    const res = await fetch(`${API_BASE}/api/map/api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: keyDraft }),
    }).then((r) => r.json()).catch(() => null);
    if (res) { setKeySet(!!res.set); setKeyDraft(''); flash(res.set ? 'key stored' : 'key cleared'); }
  };

  const savePrompt = async (value: string) => {
    const res = await fetch(`${API_BASE}/api/map/prompt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: value }),
    }).then((r) => r.json()).catch(() => null);
    if (res) {
      setPrompt(res.prompt ?? '');
      setIsDefaultPrompt(!!res.isDefault);
      flash(res.isDefault ? 'reset to default' : 'prompt saved');
    }
  };

  const runRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`${API_BASE}/api/map/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(note.trim() ? { note: note.trim() } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { flash(`refreshed ${body.refreshed ?? '?'} sessions`); setNote(''); }
      else flash(`failed: ${String(body.error ?? res.status).slice(0, 60)}`);
    } catch {
      flash('failed: unreachable');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <Field label="model" hint="haiku (claude CLI) · or any model name your endpoint serves">
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="haiku" style={inputStyle} />
      </Field>
      <Field label="base url" hint="set → OpenAI-compatible HTTP · empty → claude CLI">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1 (optional)" style={{ ...inputStyle, width: 260 }} />
      </Field>
      <Field label="auto refresh" hint="server-side cadence, e.g. 10m · empty = off (summaries leave your machine — opt in deliberately)">
        <input value={interval} onChange={(e) => setIntervalValue(e.target.value)} placeholder="off" style={{ ...inputStyle, width: 80 }} />
      </Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
        <span style={flashStyle}>{savedFlash}</span>
        <button onClick={saveBackend} style={actionBtnStyle}>save backend</button>
      </div>
      <Field label={`api key ${keySet === null ? '' : keySet ? '· set' : '· not set'}`} hint="write-only: stored as ~/.ttym/map-api-key (0600), never sent back to clients">
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={keySet ? '(replace)' : 'sk-…'}
            style={{ ...inputStyle, width: 200 }}
          />
          <button onClick={() => void saveKey()} style={actionBtnStyle}>{keyDraft.trim() ? 'store' : 'clear'}</button>
        </span>
      </Field>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={labelStyle}>summary prompt {isDefaultPrompt ? '· default' : '· customized'}</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>data blocks (screens, workspaces) are appended automatically</span>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
          style={textareaStyle}
        />
        {/* 조립 구조를 눈에 보이게: 위 지시문 뒤에 기계가 붙이는 블록들 */}
        <div style={appendedStyle}>
          <div>+ === 사용자 일회성 지시 === <span style={{ opacity: .7 }}>(아래 입력을 보내면 이 위치에)</span></div>
          <div>+ === workspace 목록 === <span style={{ opacity: .7 }}>(자동)</span></div>
          <div>+ === 요약 대상 세션 === 화면 꼬리 <span style={{ opacity: .7 }}>(자동)</span></div>
          <div>+ === 참고: 기존 title === <span style={{ opacity: .7 }}>(자동)</span></div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={() => void savePrompt('')} style={{ ...actionBtnStyle, background: 'var(--line)', color: 'var(--text-soft)' }}>reset to default</button>
          <button onClick={() => void savePrompt(prompt)} style={actionBtnStyle}>save prompt</button>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !refreshing) void runRefresh(); }}
            placeholder="one-off instruction, e.g. gemma 작업은 전부 한 줄기로 (optional)"
            style={{ ...inputStyle, flex: 1, width: 'auto' }}
            disabled={refreshing}
          />
          <button onClick={() => void runRefresh()} disabled={refreshing} style={{ ...actionBtnStyle, opacity: refreshing ? .5 : 1 }}>
            {refreshing ? 'running…' : 'refresh now'}
          </button>
        </div>
      </div>
    </>
  );
}

// ───── 소부품 ─────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={labelStyle}>{label}</span>
        {children}
      </label>
      {hint ? <div style={hintStyle}>{hint}</div> : null}
    </div>
  );
}

function Segmented<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (v: T) => void }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          style={{
            ...actionBtnStyle,
            padding: '2px 10px',
            fontSize: 11,
            background: value === option ? 'var(--accent-bg)' : 'var(--bg2)',
            color: value === option ? 'var(--accent)' : 'var(--text-soft)',
            borderColor: value === option ? 'var(--accent-dim)' : 'var(--line)',
          }}
        >
          {option}
        </button>
      ))}
    </span>
  );
}

// ───── 스타일 ─────

const triggerStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer',
  padding: 4, display: 'inline-flex', alignItems: 'center',
};

const backdropStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const modalStyle: React.CSSProperties = {
  width: 720, maxWidth: 'calc(100vw - 48px)', height: 600, maxHeight: 'calc(100vh - 48px)',
  background: 'var(--bg1)', border: '1px solid var(--line-strong)', borderRadius: 10,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  fontFamily: 'var(--mono)', boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 14px', borderBottom: '1px solid var(--line)', color: 'var(--text)',
};

const closeStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer',
  fontSize: 12, padding: 4,
};

const navStyle: React.CSSProperties = {
  width: 132, flexShrink: 0, borderRight: '1px solid var(--line)',
  display: 'flex', flexDirection: 'column', gap: 2, padding: 8,
};

const navItemStyle: React.CSSProperties = {
  border: 'none', borderRadius: 6, textAlign: 'left', padding: '6px 10px',
  fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer',
};

const panelStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, padding: 16, overflowY: 'auto',
  display: 'flex', flexDirection: 'column', gap: 14,
};

const labelStyle: React.CSSProperties = { color: 'var(--text)', fontSize: 12 };
const hintStyle: React.CSSProperties = { color: 'var(--text-dim)', fontSize: 10.5, lineHeight: 1.5 };
const flashStyle: React.CSSProperties = { color: 'var(--accent)', fontSize: 11 };

const inputStyle: React.CSSProperties = {
  background: 'var(--bg0)', color: 'var(--text)', border: '1px solid var(--line-strong)',
  borderRadius: 4, padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: 12, width: 140, outline: 'none',
};

const appendedStyle: React.CSSProperties = {
  color: 'var(--text-dim)', fontSize: 10.5, lineHeight: 1.7,
  border: '1px dashed var(--line)', borderRadius: 4, padding: '6px 10px',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  width: '100%', flex: 1, minHeight: 140, resize: 'none', lineHeight: 1.6, padding: 8,
};
