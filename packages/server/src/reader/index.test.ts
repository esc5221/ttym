import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readerFeed } from './index.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 13, 0, 0, s)).toISOString();
const rec = (o: unknown) => JSON.stringify(o) + '\n';
const user = (text: string, s: number) => rec({ type: 'user', uuid: `u${s}`, timestamp: T(s), message: { content: text } });

let home: string;
const realHome = process.env.HOME;
const CWD = '/work/proj.one';
const projectDir = () => join(home, '.claude', 'projects', '-work-proj-one');
const transcript = (sid: string, content: string, dir = projectDir()) => { mkdirSync(dir, { recursive: true }); const p = join(dir, `${sid}.jsonl`); writeFileSync(p, content); return p; };

beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'ttym-reader-')); process.env.HOME = home; });
afterAll(() => { process.env.HOME = realHome; rmSync(home, { recursive: true, force: true }); });

describe('readerFeed', () => {
  it('reads a Claude session from the start, then only what was added', async () => {
    const p = transcript('sid-a', user('hello', 1));
    const meta = { claudeSessionId: 'sid-a', cwd: CWD };

    const first = await readerFeed(meta, { after: null, key: null });
    expect(first).toMatchObject({ agent: 'claude-code', supported: true, key: 'sid-a', reset: true });
    expect(first.updates).toMatchObject([{ op: 'user', text: 'hello' }]);

    appendFileSync(p, user('again', 2));
    const second = await readerFeed(meta, { after: first.next, key: first.key });
    expect(second.reset).toBe(false);
    expect(second.updates).toMatchObject([{ op: 'user', text: 'again' }]);
  });

  it('starts over when the session id changed (cleared or resumed conversation)', async () => {
    transcript('sid-old', user('old', 1));
    transcript('sid-new', user('new', 2));
    const old = await readerFeed({ claudeSessionId: 'sid-old', cwd: CWD }, { after: null, key: null });
    const next = await readerFeed({ claudeSessionId: 'sid-new', cwd: CWD }, { after: old.next, key: old.key });
    expect(next).toMatchObject({ key: 'sid-new', reset: true });
    expect(next.updates).toMatchObject([{ text: 'new' }]);
  });

  it('uses the last session id after the agent has stopped', async () => {
    transcript('sid-last', user('done', 1));
    const feed = await readerFeed({ claudeLastSessionId: 'sid-last', cwd: CWD }, { after: null, key: null });
    expect(feed.updates).toMatchObject([{ text: 'done' }]);
  });

  it('finds the file under another project directory when the pane has since moved on', async () => {
    transcript('sid-moved', user('where am i', 1), join(home, '.claude', 'projects', '-somewhere-else'));
    const feed = await readerFeed({ claudeSessionId: 'sid-moved', cwd: '/entirely/different' }, { after: null, key: null });
    expect(feed).toMatchObject({ supported: true, key: 'sid-moved' });
    expect(feed.updates).toMatchObject([{ text: 'where am i' }]);
  });

  it('answers an empty, supported feed when the record is not on disk yet', async () => {
    const feed = await readerFeed({ claudeSessionId: 'sid-missing', cwd: CWD }, { after: null, key: null });
    expect(feed).toEqual({ agent: 'claude-code', supported: true, key: null, next: 0, reset: true, from: 0, updates: [] });
  });

  it('says so when the session has no agent, or an agent with no parser yet', async () => {
    expect(await readerFeed({ cwd: CWD }, { after: null, key: null })).toMatchObject({ agent: null, supported: false, updates: [] });
    expect(await readerFeed({ codexSessionId: 'c1', cwd: CWD }, { after: null, key: null })).toMatchObject({ agent: 'codex', supported: false, updates: [] });
  });
});
