import { useEffect, useRef, useState } from 'react';
import { getHost } from '@ttym/ui';
import { setKeyBarHidden, useKeyBarHidden } from './phone-keybar.js';

/**
 * 모바일 키바 — 소프트키보드가 낼 수 없는 키(Esc·Ctrl·Tab·화살표)를 주는
 * 터치 전용 스트립. Termius/Termux의 국룰 문법이다.
 *
 * 두 가지 급소:
 * 1. 버튼은 pointerdown에서 preventDefault — 터미널 textarea의 포커스를
 *    뺏으면 소프트키보드가 닫힌다. 탭할 때마다 키보드가 출렁이는 키바는 쓰레기다.
 * 2. iOS에서 position:fixed; bottom:0은 키보드 위가 아니라 뒤에 깔린다 —
 *    visualViewport의 (offsetTop + height)를 top으로 잡고 -100% translate.
 */
export function KeyBar({ sid }: { sid: number }) {
  const hidden = useKeyBarHidden();
  const ref = useRef<HTMLDivElement>(null);
  const [ctrl, setCtrl] = useState(false);

  useEffect(() => {
    const el = ref.current;
    const vv = window.visualViewport;
    if (!el || !vv) return;
    const place = () => {
      el.style.top = `${vv.offsetTop + vv.height}px`;
    };
    place();
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    return () => {
      vv.removeEventListener('resize', place);
      vv.removeEventListener('scroll', place);
    };
  }, []);

  // pane이 바뀌면 래치는 무의미 — 조용히 해제
  useEffect(() => () => { getHost(sid)?.disarmCtrl(); setCtrl(false); }, [sid]);

  const key = (label: string, run: () => void, active = false) => (
    <button
      key={label}
      // preventDefault는 포커스 강탈(=키보드 닫힘)을 막지만 터치의 합성 click도
      // 함께 죽는다 — 그래서 액션을 pointerdown에서 바로 실행한다.
      onPointerDown={(e) => { e.preventDefault(); run(); }}
      style={{
        // 10키가 좁은 폰에도 다 들어가게 균등 압축 — 잘리는 키는 없는 키다
        flex: '1 1 0', minWidth: 0, height: 30, padding: 0,
        background: active ? 'var(--accent)' : 'var(--bg0)',
        color: active ? '#fff' : 'var(--text-soft)',
        border: 'none', borderRadius: 5,
        fontFamily: 'var(--mono)', fontSize: 12,
        touchAction: 'manipulation',
      }}
    >{label}</button>
  );

  const host = () => getHost(sid);

  /**
   * reader의 웹 입력칸(WebComposer)이 이 pane의 키보드를 갖고 있으면 키바 키도 그리로 간다 — 하드웨어 키와 같은
   * 규칙(초안 넘김·전송·중단)을 타야 하므로. 버튼이 포커스를 안 뺏으니(pointerdown preventDefault) activeElement가 그 칸이다.
   */
  const composer = (): HTMLTextAreaElement | null => {
    const el = document.activeElement;
    return el instanceof HTMLTextAreaElement && el.closest(`.rd-wc[data-sid="${sid}"]`) ? el : null;
  };
  const KEYS: Record<string, { key: string; code: string }> = {
    esc: { key: 'Escape', code: 'Escape' }, tab: { key: 'Tab', code: 'Tab' }, enter: { key: 'Enter', code: 'Enter' },
    left: { key: 'ArrowLeft', code: 'ArrowLeft' }, right: { key: 'ArrowRight', code: 'ArrowRight' },
    up: { key: 'ArrowUp', code: 'ArrowUp' }, down: { key: 'ArrowDown', code: 'ArrowDown' },
  };
  const press = (name: keyof typeof KEYS & string) => {
    const field = composer();
    if (!field) { host()?.sendKey(name as Parameters<NonNullable<ReturnType<typeof host>>['sendKey']>[0]); return; }
    const ev = new KeyboardEvent('keydown', { ...KEYS[name]!, bubbles: true, cancelable: true });
    field.dispatchEvent(ev);
    // A made-up key event moves no caret; the field's own keys (← → in its text) are done here.
    if (!ev.defaultPrevented && (name === 'left' || name === 'right')) {
      const at = (field.selectionStart ?? 0) + (name === 'left' ? -1 : 1);
      const c = Math.max(0, Math.min(field.value.length, at));
      field.setSelectionRange(c, c);
    }
  };
  const toggleCtrl = () => {
    const field = composer();
    if (field) {
      if (ctrl) { setCtrl(false); return; }
      // The next letter from the soft keyboard becomes Ctrl+letter, sent the way the field sends a chord.
      setCtrl(true);
      const once = (e: InputEvent) => {
        field.removeEventListener('beforeinput', once);
        setCtrl(false);
        const ch = (e.data ?? '').slice(-1).toLowerCase();
        if (!/^[a-z\[\]\\_-]$/.test(ch)) return;
        e.preventDefault();
        const code = /[a-z]/.test(ch) ? `Key${ch.toUpperCase()}` : ({ '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '_': 'Minus', '-': 'Minus' } as Record<string, string>)[ch]!;
        field.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code, ctrlKey: true, bubbles: true, cancelable: true }));
      };
      field.addEventListener('beforeinput', once);
      return;
    }
    const h = host();
    if (!h) return;
    if (ctrl) { h.disarmCtrl(); return; } // disarm이 onDone으로 setCtrl(false)를 부른다
    setCtrl(true);
    h.armCtrl(() => setCtrl(false));
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const field = composer();
      // Into the field as typed text, so it is ours to edit before sending.
      if (field) { field.focus(); document.execCommand('insertText', false, text); return; }
      host()?.sendText(text);
    } catch {}
  };

  // The fold button sits where `find` used to; a little see-through so it does not read as one more key.
  // Folded, the bar is gone and only that button stays, in the corner, to bring it back.
  const fold = (
    <button
      key="fold"
      onPointerDown={(e) => { e.preventDefault(); setKeyBarHidden(!hidden); }}
      title={hidden ? 'show the keys' : 'hide the keys'}
      aria-label={hidden ? 'show the keys' : 'hide the keys'}
      style={{
        ...(hidden
          ? { width: 34, height: 34, borderRadius: 17, flex: '0 0 auto', marginRight: 4, border: '1px solid var(--line-strong)', background: 'color-mix(in srgb, var(--bg1) 70%, transparent)', backdropFilter: 'blur(6px)', pointerEvents: 'auto' as const }
          : { flex: '1 1 0', minWidth: 0, height: 30, border: 'none', borderRadius: 5, background: 'var(--bg0)' }),
        padding: 0, color: 'var(--text-soft)', opacity: 0.6, fontSize: 14, touchAction: 'manipulation',
      }}
    >⌨</button>
  );

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed', left: 0, right: 0, top: '100dvh', transform: 'translateY(-100%)',
        zIndex: 40, display: 'flex', gap: 4,
        ...(hidden
          ? { justifyContent: 'flex-end', padding: '0 6px calc(6px + env(safe-area-inset-bottom))', pointerEvents: 'none' as const }
          : { padding: '4px 6px calc(4px + env(safe-area-inset-bottom))', background: 'var(--bg1)', borderTop: '1px solid var(--line)' }),
      }}
    >
      {hidden ? fold : <>
      {key('esc', () => press('esc'))}
      {key('tab', () => press('tab'))}
      {key('ctrl', toggleCtrl, ctrl)}
      {key('←', () => press('left'))}
      {key('↓', () => press('down'))}
      {key('↑', () => press('up'))}
      {key('→', () => press('right'))}
      {key('⏎', () => press('enter'))}
      {key('paste', () => void paste())}
      {fold}
      </>}
    </div>
  );
}
