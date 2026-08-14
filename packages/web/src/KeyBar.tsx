import { useEffect, useRef, useState } from 'react';
import { getHost } from '@ttym/ui';

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
export function KeyBar({ sid, onSearch }: { sid: number; onSearch: () => void }) {
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
        flex: '1 1 0', minWidth: 0, height: 38, padding: 0,
        background: active ? 'var(--accent)' : 'var(--bg0)',
        color: active ? '#fff' : 'var(--text-soft)',
        border: '1px solid var(--line)', borderRadius: 7,
        fontFamily: 'var(--mono)', fontSize: 13,
        touchAction: 'manipulation',
      }}
    >{label}</button>
  );

  const host = () => getHost(sid);
  const toggleCtrl = () => {
    const h = host();
    if (!h) return;
    if (ctrl) { h.disarmCtrl(); return; } // disarm이 onDone으로 setCtrl(false)를 부른다
    setCtrl(true);
    h.armCtrl(() => setCtrl(false));
  };
  const paste = async () => {
    try { host()?.sendText(await navigator.clipboard.readText()); } catch {}
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed', left: 0, right: 0, top: '100dvh', transform: 'translateY(-100%)',
        zIndex: 40, display: 'flex', gap: 5, padding: '6px 8px calc(6px + env(safe-area-inset-bottom))',
        background: 'var(--bg1)', borderTop: '1px solid var(--line)',
      }}
    >
      {key('esc', () => host()?.sendKey('esc'))}
      {key('tab', () => host()?.sendKey('tab'))}
      {key('ctrl', toggleCtrl, ctrl)}
      {key('←', () => host()?.sendKey('left'))}
      {key('↓', () => host()?.sendKey('down'))}
      {key('↑', () => host()?.sendKey('up'))}
      {key('→', () => host()?.sendKey('right'))}
      {key('⏎', () => host()?.sendKey('enter'))}
      {key('⌘v', () => void paste())}
      {key('🔍', onSearch)}
    </div>
  );
}
