import { describe, expect, it, vi } from 'vitest';
import {
  MutationBarrier,
  layoutToSessionIds,
  memberNameBySession,
  reconcileSessionPanels,
  sessionIdsToLayout,
  nextWorkspaceName,
  shouldBootstrapWorkspacePanels,
  type BasePanelState,
} from './workspace-domain.js';

interface TestPanel extends BasePanelState {
  tag?: string;
}

describe('workspace-domain', () => {
  it('round-trips flat layouts to session ids', () => {
    const layout = sessionIdsToLayout([11, 22, 33]);
    expect(layoutToSessionIds(layout)).toEqual([11, 22, 33]);
  });

  it('builds member lookup by session', () => {
    expect(memberNameBySession([
      { sessionId: 10, name: 'lead' },
      { sessionId: 11, name: 'runner' },
    ])).toEqual(new Map([
      [10, 'lead'],
      [11, 'runner'],
    ]));
  });

  it('preserves panel keys for matching session ids', () => {
    const prev: TestPanel[] = [
      { key: 'a', sessionId: 10, memberName: 'lead' },
      { key: 'b', sessionId: 20, memberName: 'tests' },
    ];

    const next = reconcileSessionPanels(prev, [20, 10], {
      createEmpty: () => ({ key: 'empty' }),
      createForSession: (sessionId) => ({ key: `new-${sessionId}`, sessionId }),
      decorateSession: (panel, sessionId) => ({ ...panel, memberName: `member-${sessionId}` }),
    });

    expect(next).toEqual([
      { key: 'b', sessionId: 20, memberName: 'member-20' },
      { key: 'a', sessionId: 10, memberName: 'member-10' },
    ]);
  });

  it('keeps pending local panels when remote sessions are all assigned', () => {
    const prev: TestPanel[] = [
      { key: 'a', sessionId: 10 },
      { key: 'pending' },
    ];

    const next = reconcileSessionPanels(prev, [10], {
      createEmpty: () => ({ key: 'empty' }),
      createForSession: (sessionId) => ({ key: `new-${sessionId}`, sessionId }),
    });

    expect(next).toEqual([
      { key: 'a', sessionId: 10 },
      { key: 'pending' },
    ]);
  });

  it('locks around mutations and settles after a short window', () => {
    vi.useFakeTimers();
    const barrier = new MutationBarrier(1000);

    const end = barrier.begin();
    expect(barrier.isLocked()).toBe(true);

    end();
    expect(barrier.isLocked()).toBe(true);

    vi.advanceTimersByTime(999);
    expect(barrier.isLocked()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(barrier.isLocked()).toBe(false);
    vi.useRealTimers();
  });

  it('does not bootstrap before workspace hydration finishes', () => {
    expect(shouldBootstrapWorkspacePanels({
      initialized: true,
      hydrated: false,
      panels: [{ key: 'empty' }],
    })).toBe(false);

    expect(shouldBootstrapWorkspacePanels({
      initialized: true,
      hydrated: true,
      panels: [{ key: 'empty' }],
    })).toBe(true);

    expect(shouldBootstrapWorkspacePanels({
      initialized: true,
      hydrated: true,
      panels: [{ key: 'existing', sessionId: 42 }],
    })).toBe(false);
  });
});

describe('nextWorkspaceName', () => {
  it('빈 목록이면 1번', () => {
    expect(nextWorkspaceName([])).toBe('workspace 1');
  });

  it('개수가 아니라 쓰인 번호를 본다 — 이게 + 버튼이 죽었던 이유다', () => {
    // 실제 사고: workspace 19개인데 그중 하나가 "workspace 20"이라
    // 개수+1이 정면으로 부딪쳤다. 비어 있는 첫 번호는 1이었다.
    const names = ['mini', 'workspace 4', 'workspace 9', 'workspace 20', ...Array(15).fill(0).map((_, i) => `n${i}`)];
    expect(names).toHaveLength(19);
    expect(nextWorkspaceName(names)).toBe('workspace 1');
  });

  it('앞에서부터 메운다', () => {
    expect(nextWorkspaceName(['workspace 1', 'workspace 3'])).toBe('workspace 2');
    expect(nextWorkspaceName(['workspace 1', 'workspace 2'])).toBe('workspace 3');
  });

  it('workspace N 형태가 아닌 이름은 세지 않는다', () => {
    expect(nextWorkspaceName(['workspace', 'workspace 1x', 'workspace  2', 'gpai'])).toBe('workspace 1');
  });

  it('앞뒤 공백은 무시하고 같은 이름으로 본다', () => {
    expect(nextWorkspaceName([' workspace 1 '])).toBe('workspace 2');
  });
});
