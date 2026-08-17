import { useEffect, useRef } from 'react';

/**
 * 터미널 위의 한 손가락 제스처.
 *
 *   세로  scrollback 이동. 손을 뗀 뒤에는 관성으로 이어진다.
 *   가로  형제 pane 이동. 손을 뗄 때 한 번 판정.
 *
 * xterm에도 터치 스크롤 경로가 있지만(MouseService → Viewport.handleTouchScroll)
 * 실기기에서 한 칸도 움직이지 않았다. 같은 상태에서 term.scrollToLine()은 정상
 * 동작했으니 데이터가 아니라 제스처 인식 쪽 문제다. 컨테이너가 touch-action:none
 * 이라 브라우저도 끼어들지 않으니, 우리가 잡는 편이 축을 나누기에도 낫다.
 *
 * 방향은 종이를 미는 감각이다. 손가락을 아래로 끌면 종이가 내려와 과거가 나온다.
 */
export interface SwipeOptions {
  /** 가로: 왼쪽으로 밀었을 때 (다음 pane) */
  onLeft?: () => void;
  /** 가로: 오른쪽으로 밀었을 때 (이전 pane) */
  onRight?: () => void;
  /** 세로 드래그 시작. 여기서 현재 스크롤 위치를 기억해 두면 된다. */
  onScrollStart?: () => void;
  /**
   * 세로: 시작 지점 기준 누적 행 수(절대). 음수 = 과거로.
   * 실제로 움직였으면 true를 돌려준다 — false면 경계에 닿은 것으로 보고
   * 관성을 멈춘다.
   */
  onScrollTo?: (deltaLines: number) => boolean | void;
  /** 한 행의 높이(px). 세로 이동량을 행으로 바꾸는 데 쓴다. */
  lineHeight?: number;
  /** 가로로 이만큼은 가야 pane 이동으로 친다 (px) */
  minDistance?: number;
  /** 세로보다 가로가 이 배수 이상이어야 pane 이동이다 */
  ratio?: number;
  enabled?: boolean;
}

/** 16ms마다 남는 속도 비율. 낮을수록 빨리 선다. */
const FRICTION = 0.94;
/** 이 속도(px/ms) 밑으로 떨어지면 관성을 끝낸다. */
const MIN_VELOCITY = 0.02;
/** 손을 뗄 때 이 속도는 넘어야 관성이 붙는다 — 느린 조정까지 흘러가면 성가시다. */
const FLING_VELOCITY = 0.12;
/** 속도를 계산할 때 돌아보는 시간(ms). 길면 손끝의 마지막 방향 전환을 놓친다. */
const VELOCITY_WINDOW = 90;

export function useSwipe(
  ref: React.RefObject<HTMLElement | null>,
  { onLeft, onRight, onScrollStart, onScrollTo, lineHeight = 16, minDistance = 60, ratio = 1.6, enabled = true }: SwipeOptions,
) {
  // 콜백은 ref로 들고 있는다 — 매 렌더마다 리스너를 다시 걸면 드래그가 끊긴다.
  const cb = useRef({ onLeft, onRight, onScrollStart, onScrollTo, lineHeight });
  cb.current = { onLeft, onRight, onScrollStart, onScrollTo, lineHeight };

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    let startX = 0, startY = 0;
    let tracking = false;
    let lastDelta = 0;
    /** 손을 뗀 지점까지의 이동량(px). 관성은 여기서 이어 나간다. */
    let offset = 0;
    /** 최근 좌표 표본 — 손 뗄 때의 속도를 여기서 뽑는다. */
    let samples: Array<{ t: number; y: number }> = [];
    let raf: number | null = null;

    const stopFling = () => {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    };

    /** 시작점 기준 절대 행수로 보낸다. 상대 이동을 매 프레임 더하면 xterm의
     *  스무스 스크롤과 겹쳐 요청보다 훨씬 많이 흐른다(-16행에 280행 이동을 실측). */
    const emit = (px: number): boolean => {
      const lh = cb.current.lineHeight || 16;
      const delta = -Math.round(px / lh);
      if (delta === lastDelta) return true;  // 아직 같은 행 — 경계로 오해하지 않는다
      lastDelta = delta;
      return cb.current.onScrollTo?.(delta) !== false;
    };

    const onStart = (e: TouchEvent) => {
      stopFling();  // 흐르는 중에 손이 닿으면 그 자리에 선다
      if (e.touches.length !== 1) { tracking = false; return; }
      const t = e.touches[0]!;
      startX = t.clientX; startY = t.clientY;
      lastDelta = 0; offset = 0;
      samples = [{ t: e.timeStamp, y: t.clientY }];
      tracking = true;
      cb.current.onScrollStart?.();
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      const t = e.touches[0]!;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // 가로가 확실하면 세로는 건드리지 않는다
      if (Math.abs(dx) > Math.abs(dy) * ratio && Math.abs(dx) > 20) return;
      samples.push({ t: e.timeStamp, y: t.clientY });
      while (samples.length > 2 && e.timeStamp - samples[0]!.t > VELOCITY_WINDOW) samples.shift();
      offset = dy;
      emit(offset);
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      // 가로 판정이 서면 pane을 넘기고 관성은 붙이지 않는다
      if (Math.abs(dx) >= minDistance && Math.abs(dx) >= Math.abs(dy) * ratio) {
        if (dx < 0) cb.current.onLeft?.(); else cb.current.onRight?.();
        return;
      }

      const first = samples[0];
      const span = first ? e.timeStamp - first.t : 0;
      if (!first || span <= 0) return;
      let velocity = (t.clientY - first.y) / span;  // px/ms
      if (Math.abs(velocity) < FLING_VELOCITY) return;

      let last = performance.now();
      const step = (now: number) => {
        raf = null;
        const dt = Math.min(now - last, 64);  // 탭 전환 등으로 프레임이 튀어도 순간이동은 없다
        last = now;
        offset += velocity * dt;
        // 프레임 간격이 들쭉날쭉해도 같은 감속을 내도록 지수로 보정한다
        velocity *= Math.pow(FRICTION, dt / 16);
        const moved = emit(offset);
        if (!moved) return;                       // 맨 위·맨 아래에 닿았다
        if (Math.abs(velocity) < MIN_VELOCITY) return;
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };

    const onCancel = () => { tracking = false; stopFling(); };

    // capture: xterm이 버블 단계에서 stopPropagation을 하므로 먼저 듣는다.
    // passive: preventDefault를 쓰지 않는다 — 컨테이너가 touch-action:none 이라
    // 막을 브라우저 동작이 애초에 없다.
    const opt = { capture: true, passive: true } as const;
    el.addEventListener('touchstart', onStart, opt);
    el.addEventListener('touchmove', onMove, opt);
    el.addEventListener('touchend', onEnd, opt);
    el.addEventListener('touchcancel', onCancel, opt);
    return () => {
      stopFling();
      el.removeEventListener('touchstart', onStart, { capture: true });
      el.removeEventListener('touchmove', onMove, { capture: true });
      el.removeEventListener('touchend', onEnd, { capture: true });
      el.removeEventListener('touchcancel', onCancel, { capture: true });
    };
  }, [ref, enabled, minDistance, ratio]);
}
