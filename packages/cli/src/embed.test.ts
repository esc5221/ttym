import { describe, expect, it } from 'vitest';
import { splitCommand } from './embed.js';

describe('splitCommand — a profile command from one --profile value', () => {
  it.each([
    ['zsh -l', ['zsh', '-l']],
    ['  bash   --login ', ['bash', '--login']],
    [`sh -c 'echo "hi there"'`, ['sh', '-c', 'echo "hi there"']],
    [`env A="" zsh`, ['env', 'A=', 'zsh']],
  ])('%s', (input, want) => {
    expect(splitCommand(input)).toEqual(want);
  });
});
