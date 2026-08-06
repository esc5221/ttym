import { describe, expect, it, vi } from 'vitest';
import {
  MutationBarrier,
  layoutToSessionIds,
  memberNameBySession,
  reconcileSessionPanels,
  sessionIdsToLayout,
  shouldBootstrapWorkspacePanels,
  type BasePanelState,
} from './workspace-domain';

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
