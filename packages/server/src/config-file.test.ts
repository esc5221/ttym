import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, updateConfigText, ConfigStore } from './config-file.js';

describe('config file', () => {
  it('parses flat key = value with comments and junk ignored', () => {
    const values = parseConfig([
      '# ttym config',
      'theme = dark',
      '  ui-style=frame  ',
      '',
      'not a pair',
      'font-size = 14',
    ].join('\n'));
    expect(values).toEqual({ theme: 'dark', 'ui-style': 'frame', 'font-size': '14' });
  });

  it('updates in place, keeps comments, appends new keys, deletes on null', () => {
    const before = ['# my settings', 'theme = dark', 'font-size = 14', ''].join('\n');
    const after = updateConfigText(before, { theme: 'light', 'ui-style': 'frame', 'font-size': null });
    expect(after).toBe(['# my settings', 'theme = light', 'ui-style = frame'].join('\n') + '\n');
  });

  it('round-trips through the store with atomic writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ttym-config-'));
    try {
      const path = join(dir, 'config');
      writeFileSync(path, '# keep me\ntheme = dark\n');
      const store = new ConfigStore(path);
      await store.load();
      expect(store.get()).toEqual({ theme: 'dark' });

      const merged = await store.patch({ 'ui-style': 'frame' });
      expect(merged).toEqual({ theme: 'dark', 'ui-style': 'frame' });
      expect(readFileSync(path, 'utf8')).toContain('# keep me');

      const fresh = new ConfigStore(path);
      await fresh.load();
      expect(fresh.get()).toEqual({ theme: 'dark', 'ui-style': 'frame' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
