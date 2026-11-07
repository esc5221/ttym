import { describe, expect, it } from 'vitest';
import { mergeCommands, parseMenu, rankFiles } from './composer.js';

describe('parseMenu', () => {
  it('reads entries, the selected one, skills marked *, and wrapped descriptions', () => {
    // As Claude Code 2.1.319 draws its / menu (dev pane, 2026-11-07).
    const rows = [
      '     /usage                          Show session cost, plan usage, and',
      '                                     activity stats',
      '     /workflows                      Browse running and completed workflows',
      '   ❯ * /agent-device – Automates Apple-platform apps (iOS, tvOS, macOS), Andro…',
      '     /figma:create_design_system_rules (MCP)  Provides a prompt to generate design',
      '     …ontend-design:frontend-design  (frontend-design) Guidance for',
    ];
    const got = parseMenu(rows);
    expect(got.map((e) => e.name)).toEqual(['/usage', '/workflows', '/agent-device', '/figma:create_design_system_rules (MCP)']);
    expect(got[0]!.description).toBe('Show session cost, plan usage, and activity stats');
    expect(got[2]!.description).toMatch(/^Automates Apple-platform/);
  });
});

describe('mergeCommands', () => {
  it('keeps the menu order, fills details from the sdk, marks menu-only commands as terminal-only, appends sdk-only', () => {
    const sdk = [
      { name: '/compact', description: 'Free up context', argumentHint: '<instructions>' },
      { name: '/agents', description: 'Manage agents' },
    ];
    const menu = [{ name: '/resume', description: 'Resume a conversation' }, { name: '/compact', description: 'Free up…' }];
    expect(mergeCommands(sdk, menu)).toEqual([
      { name: '/resume', description: 'Resume a conversation', terminalOnly: true },
      { name: '/compact', description: 'Free up context', argumentHint: '<instructions>' },
      { name: '/agents', description: 'Manage agents' },
    ]);
  });
});

describe('rankFiles', () => {
  it('puts a name that starts with the query first, then paths containing it, then letters in order', () => {
    const files = ['docs/alpha-notes.md', 'src/alpha.ts', 'src/beta.md', 'lib/a/l/p/h/a.txt', 'README.md'];
    expect(rankFiles(files, 'alp')).toEqual(['src/alpha.ts', 'docs/alpha-notes.md', 'lib/a/l/p/h/a.txt']);
    expect(rankFiles(files, '')).toHaveLength(5);
  });
});
