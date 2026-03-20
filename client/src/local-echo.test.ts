import { describe, expect, it, vi } from 'vitest';
import { LocalEchoController } from './local-echo.js';

describe('LocalEchoController', () => {
  it('optimistically writes simple printable input and strips echoed bytes from server output', () => {
    const writeOptimistic = vi.fn();
    const writeOptimisticBackspace = vi.fn();
    const requestSnapshot = vi.fn();
    const controller = new LocalEchoController({ writeOptimistic, writeOptimisticBackspace, requestSnapshot });

    controller.setEnabled(true);

    expect(controller.handleLocalInput('a')).toBe(true);
    expect(writeOptimistic).toHaveBeenCalledWith('a');

    const reconciled = controller.reconcileServerData(new TextEncoder().encode('abc'));
    expect(new TextDecoder().decode(reconciled)).toBe('bc');
    expect(requestSnapshot).not.toHaveBeenCalled();
  });

  it('requests a snapshot and enters cooldown on mismatch', () => {
    const writeOptimistic = vi.fn();
    const writeOptimisticBackspace = vi.fn();
    const requestSnapshot = vi.fn();
    let now = 0;
    const controller = new LocalEchoController({
      writeOptimistic,
      writeOptimisticBackspace,
      requestSnapshot,
      now: () => now,
    });

    controller.setEnabled(true);
    expect(controller.handleLocalInput('a')).toBe(true);

    const reconciled = controller.reconcileServerData(new TextEncoder().encode('zsh'));
    expect(reconciled).toHaveLength(0);
    expect(requestSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getMismatchCount()).toBe(1);

    now = 500;
    expect(controller.handleLocalInput('b')).toBe(false);

    now = 2500;
    expect(controller.handleLocalInput('b')).toBe(true);
  });

  it('does not optimistic-echo control keys or likely paste bursts', () => {
    const controller = new LocalEchoController({
      writeOptimistic: vi.fn(),
      writeOptimisticBackspace: vi.fn(),
      requestSnapshot: vi.fn(),
    });

    controller.setEnabled(true);

    expect(controller.handleLocalInput('\r')).toBe(false);
    expect(controller.handleLocalInput('\t')).toBe(false);
    expect(controller.handleLocalInput('hello')).toBe(false);
  });

  it('optimistically backspaces only pending optimistic text', () => {
    const writeOptimistic = vi.fn();
    const writeOptimisticBackspace = vi.fn();
    const controller = new LocalEchoController({
      writeOptimistic,
      writeOptimisticBackspace,
      requestSnapshot: vi.fn(),
    });

    controller.setEnabled(true);
    expect(controller.handleLocalInput('a')).toBe(true);
    expect(controller.handleLocalInput('b')).toBe(true);
    expect(controller.handleLocalInput('\u007f')).toBe(true);
    expect(writeOptimisticBackspace).toHaveBeenCalledTimes(1);

    const reconciled = controller.reconcileServerData(new TextEncoder().encode('aZ'));
    expect(new TextDecoder().decode(reconciled)).toBe('Z');
  });
});
