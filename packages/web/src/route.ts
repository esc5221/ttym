/** 해시 라우팅.
 *
 *  app-shared에서 떼어낸 것은 저쪽이 import 시점에 window.location을 읽어
 *  (TTYM_HOST·isSecure) node에서 불러올 수 없기 때문이다. 파싱은 순수 함수라
 *  테스트로 못 박을 값어치가 있는데, 그러려면 DOM을 안 건드리는 자리에 있어야
 *  한다. 아래 두 함수만 window를 만지고 나머지는 문자열 계산이다.
 */

export type Route =
  | { page: 'dashboard' }
  | { page: 'overview' }
  | { page: 'session'; id: number }
  | { page: 'viewer'; id: number }
  /** pane은 폰에서 "지금 전체화면으로 보고 있는 세션"이다. 없으면 카드 목록.
   *  컴포넌트 상태로 두던 시절에는 새로고침 한 번에 목록으로 튕겼고, 보고 있는
   *  화면을 링크로 보낼 수도 없었다. 위치는 URL이 말해야 한다.
   *
   *  zen은 데스크톱의 읽기 모드다. pane과 칸을 나눠 쓰지 않는 이유: 데스크톱에서
   *  둘은 다른 상태다. 합치면 "레이아웃은 그대로 두고 이 pane에 포커스"를 URL로
   *  말할 방법이 없어진다. */
  | { page: 'workspace'; id: string; pane?: number; zen?: number };

export function parseRouteHash(hash: string): Route {
  if (hash === '#overview') return { page: 'overview' };
  const sessionMatch = hash.match(/^#s\/(\d+)$/);
  if (sessionMatch) return { page: 'session', id: parseInt(sessionMatch[1], 10) };
  const viewerMatch = hash.match(/^#v\/(\d+)$/);
  if (viewerMatch) return { page: 'viewer', id: parseInt(viewerMatch[1], 10) };
  const wsMatch = hash.match(/^#w\/(.+)$/);
  if (wsMatch) {
    // id 자체는 uuid 앞 8자라 /를 품지 않지만, 꼬리를 탐욕적으로 자르지 않으면
    // "#w/abc/p/12"가 id "abc/p/12"인 workspace로 읽힌다 (실제로 그랬다).
    const paneMatch = wsMatch[1].match(/^(.+)\/p\/(\d+)$/);
    if (paneMatch) return { page: 'workspace', id: paneMatch[1], pane: parseInt(paneMatch[2], 10) };
    const zenMatch = wsMatch[1].match(/^(.+)\/z\/(\d+)$/);
    if (zenMatch) return { page: 'workspace', id: zenMatch[1], zen: parseInt(zenMatch[2], 10) };
    return { page: 'workspace', id: wsMatch[1] };
  }
  return { page: 'dashboard' };
}

/** location.hash에 넣을 값 — 앞의 #은 빼고. */
export function routeToHash(route: Route): string {
  switch (route.page) {
    case 'dashboard': return '';
    case 'overview': return 'overview';
    case 'session': return `s/${route.id}`;
    case 'viewer': return `v/${route.id}`;
    case 'workspace':
      if (route.zen !== undefined) return `w/${route.id}/z/${route.zen}`;
      if (route.pane !== undefined) return `w/${route.id}/p/${route.pane}`;
      return `w/${route.id}`;
  }
}

export function parseHash(): Route {
  return parseRouteHash(window.location.hash);
}

export function navigate(route: Route, options?: { replace?: boolean }): void {
  const hash = routeToHash(route);
  if (!options?.replace) {
    window.location.hash = hash;
    return;
  }
  // 히스토리를 늘리지 않고 갈아끼운다 — pane을 ‹ ›로 넘길 때마다 한 칸씩
  // 쌓이면 뒤로가기를 여섯 번 눌러야 목록으로 나가게 된다.
  // replaceState는 hashchange를 안 쏘므로 직접 쏜다. 앱의 리스너는 이벤트
  // 객체를 안 보고 parseHash()를 다시 읽기만 한다.
  const url = hash ? `#${hash}` : window.location.pathname + window.location.search;
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event('hashchange'));
}
