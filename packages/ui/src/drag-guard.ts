/**
 * 드래그하는 동안 iframe이 포인터를 가져가지 못하게 한다.
 *
 * iframe 위로 포인터가 들어가면 move·up 이벤트는 iframe의 문서로 간다. 바깥 window에 건
 * 리스너는 아무것도 못 받는다. 그러면 splitter는 거기서 멈추고, 터미널 선택은 끝을 모른다
 * (zen 옆 패널에 뷰어 iframe이 있을 때 둘 다 실측). 드래그하는 동안에만 iframe의
 * pointer-events를 끈다.
 *
 * 가드가 안 풀리면 뷰어 iframe이 전부 먹통이 된다. 그래서 up 말고도 cancel·blur·탭 숨김에서
 * 푼다. 창 밖에서 버튼을 놓으면 up이 안 올 수 있기 때문이다.
 */
const CLASS = 'ttym-drag-guard';
let installed = false;

export function beginDragGuard(cursor?: string): void {
  if (typeof document === 'undefined') return;
  if (!installed) {
    installed = true;
    const style = document.createElement('style');
    style.textContent = `.${CLASS} iframe { pointer-events: none !important; }`;
    document.head.appendChild(style);
  }
  const root = document.documentElement;
  root.classList.add(CLASS);
  if (cursor) root.style.cursor = cursor;
  const end = () => {
    root.classList.remove(CLASS);
    if (cursor) root.style.cursor = '';
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('mouseup', end, true);
    window.removeEventListener('pointercancel', end, true);
    window.removeEventListener('blur', end);
    document.removeEventListener('visibilitychange', end);
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('mouseup', end, true);
  window.addEventListener('pointercancel', end, true);
  window.addEventListener('blur', end);
  document.addEventListener('visibilitychange', end);
}
