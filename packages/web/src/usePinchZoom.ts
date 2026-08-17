import { useEffect, useRef } from 'react';

/**
 * 두 손가락 핀치로 폰트 크기를 바꾼다.
 *
 * 함정은 스크롤과의 혼동이다. 손가락 두 개로 화면을 훑을 때도 거리는 미세하게
 * 변하니, 순수 거리비만 보면 스크롤할 때마다 폰트가 출렁인다. terminal7이
 * 같은 문제를 세로 속도로 갈랐다(pinch_max_y_velocity = 0.1 px/ms). 두 손가락의
 * 중점이 빠르게 세로로 움직이는 중이면 그건 스크롤이지 핀치가 아니다.
 * 그 값을 그대로 쓴다.
 *
 * 터치를 삼키지 않는다. preventDefault는 실제로 크기를 바꿀 때만 부른다.
 */
const MAX_Y_VELOCITY = 0.1; // px/ms
const STEP_RATIO = 0.15;    // 이만큼 벌어져야 한 단계

export function usePinchZoom(
  ref: React.RefObject<HTMLElement | null>,
  onStep: (delta: number) => void,
  enabled = true,
) {
  const cb = useRef(onStep);
  cb.current = onStep;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    let baseDist = 0;
    let lastY = 0;
    let lastT = 0;
    let active = false;

    const dist = (t: TouchList) => Math.hypot(
      t[0]!.clientX - t[1]!.clientX,
      t[0]!.clientY - t[1]!.clientY,
    );
    const midY = (t: TouchList) => (t[0]!.clientY + t[1]!.clientY) / 2;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) { active = false; return; }
      active = true;
      baseDist = dist(e.touches);
      lastY = midY(e.touches);
      lastT = e.timeStamp;
    };

    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length !== 2) return;
      const y = midY(e.touches);
      const dt = e.timeStamp - lastT;
      const vy = dt > 0 ? Math.abs(y - lastY) / dt : 0;
      lastY = y;
      lastT = e.timeStamp;
      if (vy > MAX_Y_VELOCITY) { baseDist = dist(e.touches); return; } // 스크롤이다

      const d = dist(e.touches);
      if (baseDist <= 0) { baseDist = d; return; }
      const ratio = d / baseDist;
      if (ratio > 1 + STEP_RATIO) { cb.current(1); baseDist = d; e.preventDefault(); }
      else if (ratio < 1 - STEP_RATIO) { cb.current(-1); baseDist = d; e.preventDefault(); }
    };

    const onEnd = () => { active = false; };

    el.addEventListener('touchstart', onStart, { capture: true, passive: true });
    el.addEventListener('touchmove', onMove, { capture: true, passive: false });
    el.addEventListener('touchend', onEnd, { capture: true, passive: true });
    el.addEventListener('touchcancel', onEnd, { capture: true, passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart, { capture: true });
      el.removeEventListener('touchmove', onMove, { capture: true });
      el.removeEventListener('touchend', onEnd, { capture: true });
      el.removeEventListener('touchcancel', onEnd, { capture: true });
    };
  }, [ref, enabled]);
}
