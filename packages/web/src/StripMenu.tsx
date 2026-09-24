import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { stripBtnStyle } from './app-shared.js';

/** 탭 스트립 우측의 드롭다운 메뉴.
 *  스트립은 overflowX:auto라 클리핑 박스다 — x가 auto면 y의 visible도 auto로
 *  승격되므로, 안쪽에 absolute로 띄운 패널은 스트립 높이(42px) 밖에서 잘려
 *  보이지 않는다. z-index로는 뚫리지 않는다. 그래서 패널은 body 포털 + fixed로
 *  클리핑 박스 밖에 살고(SettingsModal과 같은 문법), 위치는 버튼 rect가 정한다. */
export function StripMenu({ label, open, onToggle, children, align = 'right', anchorStyle, anchorProps, panelStyle }: {
  label: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** 패널이 버튼의 어느 모서리에 맞춰 서는가. 스트립 왼쪽 끝의 메뉴는 'left'. */
  align?: 'left' | 'right';
  anchorStyle?: React.CSSProperties;
  anchorProps?: Record<string, unknown>;
  panelStyle?: React.CSSProperties;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!open) { setRect(null); return; }
    const measure = () => setRect(anchorRef.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener('resize', measure);
    // capture로 모든 스크롤을 듣는다 — 스트립 자신의 가로 스크롤도 앵커를 옮긴다.
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  return (
    <>
      <button ref={anchorRef} onClick={onToggle} style={anchorStyle ?? stripBtnStyle} {...anchorProps}>{label}</button>
      {open && rect ? createPortal(
        <div style={{
          ...attachDropdownStyle,
          top: rect.bottom + 6,
          // 왼쪽 정렬은 버튼이 화면 왼쪽에 있을 때 쓴다. 폭까지 같이 묶지 않으면
          // 좁은 화면에서 패널이 오른쪽으로 삐져나간다(폰 실측 440 > 411) —
          // 넘치는 대신 남은 자리에 맞춰 줄어들게 한다.
          ...(align === 'left'
            ? {
                left: Math.max(6, rect.left),
                maxWidth: window.innerWidth - Math.max(6, rect.left) - 6,
              }
            : { right: Math.max(6, window.innerWidth - rect.right) }),
          ...panelStyle,
        }}>
          {children}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

// top·right는 StripMenu가 앵커 rect로 채운다 — 스트립의 클리핑 밖에 사는 대가.
export const attachDropdownStyle: React.CSSProperties = {
  position: 'fixed',
  minWidth: 240,
  maxHeight: 320,
  overflowY: 'auto',
  padding: 6,
  borderRadius: 8,
  border: '1px solid var(--line-strong)',
  background: 'var(--bg1)',
  boxShadow: '0 12px 30px rgba(0, 0, 0, 0.45)',
  backdropFilter: 'blur(14px)',
  fontFamily: 'var(--mono)',
  zIndex: 50,
};

export const attachDropdownTitleStyle: React.CSSProperties = {
  color: 'var(--text-soft)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  padding: '4px 8px 6px',
};

export const attachDropdownItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  width: '100%',
  padding: '6px 8px',
  background: 'transparent',
  border: 'none',
  color: 'var(--text-soft)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
  borderRadius: 4,
};

export const attachDropdownEmptyStyle: React.CSSProperties = {
  padding: '8px',
  color: 'var(--text-dim)',
  fontSize: 11,
};
