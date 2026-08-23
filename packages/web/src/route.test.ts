import { describe, expect, it } from 'vitest';
import { parseRouteHash, routeToHash, type Route } from './route.js';

describe('parseRouteHash', () => {
  it('빈 해시와 모르는 해시는 대시보드', () => {
    expect(parseRouteHash('')).toEqual({ page: 'dashboard' });
    expect(parseRouteHash('#')).toEqual({ page: 'dashboard' });
    expect(parseRouteHash('#nope')).toEqual({ page: 'dashboard' });
  });

  it('세션·뷰어·개관', () => {
    expect(parseRouteHash('#overview')).toEqual({ page: 'overview' });
    expect(parseRouteHash('#s/42')).toEqual({ page: 'session', id: 42 });
    expect(parseRouteHash('#v/7')).toEqual({ page: 'viewer', id: 7 });
  });

  it('workspace 는 pane 없이도 읽힌다', () => {
    expect(parseRouteHash('#w/ad6d3100')).toEqual({ page: 'workspace', id: 'ad6d3100' });
  });

  it('pane 꼬리를 workspace id 로 삼키지 않는다', () => {
    // 탐욕적 정규식(/^#w\/(.+)$/)만 있던 시절에는 id 가 "ad6d3100/p/12" 였다.
    expect(parseRouteHash('#w/ad6d3100/p/12')).toEqual({ page: 'workspace', id: 'ad6d3100', pane: 12 });
  });

  it('pane 처럼 생겼지만 아닌 꼬리는 id 의 일부로 둔다', () => {
    expect(parseRouteHash('#w/abc/p/')).toEqual({ page: 'workspace', id: 'abc/p/' });
    expect(parseRouteHash('#w/abc/p/x')).toEqual({ page: 'workspace', id: 'abc/p/x' });
  });
});

describe('routeToHash', () => {
  it('되돌린 해시를 다시 읽으면 같은 route 다', () => {
    const routes: Route[] = [
      { page: 'dashboard' },
      { page: 'overview' },
      { page: 'session', id: 42 },
      { page: 'viewer', id: 7 },
      { page: 'workspace', id: 'ad6d3100' },
      { page: 'workspace', id: 'ad6d3100', pane: 12 },
    ];
    for (const route of routes) {
      expect(parseRouteHash(`#${routeToHash(route)}`)).toEqual(route);
    }
  });

  it('pane 이 없으면 꼬리를 안 붙인다', () => {
    expect(routeToHash({ page: 'workspace', id: 'x' })).toBe('w/x');
    expect(routeToHash({ page: 'workspace', id: 'x', pane: 0 })).toBe('w/x/p/0');
  });
});
