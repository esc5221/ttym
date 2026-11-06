import { describe, expect, it } from 'vitest';
import { Marked } from 'marked';
import { kitExtension, splitCells, treeGuides } from './kit.js';

const md = (text: string): string => new Marked(kitExtension).parse(text, { async: false }) as string;

describe('reader kit', () => {
  it('draws a flow of steps with state tags', () => {
    const html = md(':::flow\n- [ok] 파서 | 테스트 통과\n- [run] 렌더러\n- [todo] 검증\n:::');
    expect(html).toContain('rk-flow');
    expect(html).toContain('rk-st rk-ok">완료');
    expect(html).toContain('rk-st rk-run">진행');
    expect(html).toContain('rk-st rk-todo">예정');
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain('테스트 통과');
  });

  it('marks the recommended option', () => {
    const html = md(':::decide 어느 쪽?\n- A안 (추천) | 빠르다 | 코드가 늘어난다\n- B안 | 단순하다\n:::');
    expect(html).toContain('어느 쪽?');
    expect(html.match(/rk-recmark/g)).toHaveLength(1);
    expect(html).toContain('rk-cost');
    expect(html).not.toContain('(추천)');
  });

  it('scales bars to the largest value and draws a baseline', () => {
    const html = md(':::bars base=500\n- 운영: 573ms\n- dev: 286ms (강조)\n:::');
    expect(html).toContain('--w:100.0%');
    expect(html).toContain('--w:49.9%');
    expect(html).toContain('rk-hi');
    expect(html).toContain('rk-base');
    expect(html).toContain('573ms');
  });

  it('builds stats, summary, tree and timeline', () => {
    expect(md(':::stats\n- 65분 → 2분 | 직접 잰 값\n:::')).toContain('rk-big');
    expect(md(':::summary\n- 무엇 | a\n- 어떻게 | b\n:::').match(/rk-card/g)).toHaveLength(2);
    const tree = md(':::tree\n- src/\n  - [new] kit.ts | 파서\n:::');
    expect(tree).toContain('rk-g-elbow');
    expect(tree).toContain('rk-g-blank');
    expect(md(':::timeline\n- 10/30 | 시작\n:::')).toContain('rk-when');
  });

  it('draws summary as rows by default and as cards with @cards', () => {
    expect(md(':::summary\n- a | b\n:::')).toContain('rk-v-rows');
    expect(md(':::summary @cards\n- a | b\n:::')).not.toContain('rk-v-');
    expect(md(':::summary @num\n- a | b\n:::')).toContain('rk-v-num');
  });

  it('splits vs into two sides and renders markdown in each', () => {
    const html = md(':::vs 지금 | 바뀜\n- 하나\n---\n**둘**\n:::');
    expect(html.match(/rk-side"/g)).toHaveLength(2);
    expect(html).toContain('<strong>둘</strong>');
    expect(html).toContain('지금');
  });

  it('draws a note with its state, markdown inside', () => {
    const html = md(':::note risk 지우면 안 된다\n`rm` 은 되돌릴 수 없다\n:::');
    expect(html).toContain('rk-n-risk');
    expect(html).toContain('<code>rm</code>');
  });

  it('runs an unclosed block to the end of the text, so a message being written is drawn', () => {
    const html = md(':::flow\n- [ok] 하나 | 끝\n- [run] 둘 | 쓰는 중');
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it('keeps text after a closed block as ordinary markdown', () => {
    const html = md(':::summary\n- a | b\n:::\n\n다음 문단');
    expect(html).toContain('<p>다음 문단</p>');
  });

  it('leaves unknown kinds and code fences alone', () => {
    expect(md(':::mystery\n- a\n:::')).not.toContain('rk-');
    const fenced = md('```\n:::flow\n- [ok] x\n:::\n```');
    expect(fenced).toContain('<pre>');
    expect(fenced).not.toContain('rk-flow');
  });

  it('escapes the text it takes whole (question, label, bar value)', () => {
    const html = md(':::decide <img src=x onerror=alert(1)>\n- a | b\n:::\n\n:::bars\n- <i>x</i>: 5<b>\n:::');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
  });

  it('renders evidence chips anywhere in text', () => {
    const html = md('지연이 줄었다 [실측] 원인은 [추정] 캐시.');
    expect(html).toContain('rk-ev-measured');
    expect(html).toContain('rk-ev-guess');
  });

  it('does not treat task list boxes as tags', () => {
    const html = md('- [x] 끝\n- [ ] 남음');
    expect(html).not.toContain('rk-st');
    expect(html).toContain('checkbox');
  });

  it('drops a step number the agent typed, after the tag too', () => {
    const html = md(':::flow\n- 1. 첫째 | a\n- [run] 2) 둘째 | b\n:::');
    expect(html).not.toMatch(/<b>1\./);
    expect(html).not.toContain('2)');
    expect(html).toContain('첫째');
    expect(html).toContain('rk-rows');
  });

  it('a flow without detail stays a strip', () => {
    expect(md(':::flow\n- [ok] a\n- [run] b\n:::')).not.toContain('rk-rows');
  });

  it('evidence tags carry their source; other tags do not', () => {
    const html = md('열림 [코드: roster-state.ts] 확인 [ok: 이건 태그가 아님]');
    expect(html).toContain('rk-src">roster-state.ts');
    expect(html).toContain('[ok: 이건 태그가 아님]');
  });

  it('a long big-number cell is drawn smaller', () => {
    expect(md(':::stats\n- 192 → 10번 | a\n- sweep 1번당 ps 1번 | b\n:::')).toMatch(/rk-big">192[\s\S]*rk-big rk-long">sweep/);
  });

  it('has a changed tag, distinct from new', () => {
    const html = md('[new] 만듦 [chg] 고침');
    expect(html).toContain('rk-st rk-new">새로');
    expect(html).toContain('rk-st rk-chg">바뀜');
  });

  it('draws tree connectors from the nesting: tee while a sibling follows, elbow on the last, pipes under open parents', () => {
    expect(treeGuides([0, 1, 1, 0])).toEqual([
      ['tee'],
      ['pipe', 'tee'],
      ['pipe', 'elbow'],
      ['elbow'],
    ]);
    expect(treeGuides([0, 1, 2, 1])).toEqual([
      ['elbow'],
      ['blank', 'tee'],
      ['blank', 'pipe', 'elbow'],
      ['blank', 'elbow'],
    ]);
  });

  it('marks directory lines and renders one guide cell per level', () => {
    const html = md(':::tree\n- src/\n  - a.ts\n:::');
    expect(html).toContain('rk-node rk-dir');
    expect(html.match(/rk-g /g)).toHaveLength(3);
  });

  it('folds, with nested blocks when the fence is longer', () => {
    const html = md('::::fold 근거 open\n:::flow\n- [ok] a | b\n:::\n::::');
    expect(html).toContain('<details class="rk rk-fold" open>');
    expect(html).toContain('<summary>근거</summary>');
    expect(html).toContain('rk-flow');
  });

  it('makes cols out of any number of sides and keeps vs', () => {
    const html = md(':::cols 지금 | A | B\n하나\n---\n둘\n---\n셋\n:::');
    expect(html.match(/rk-side"/g)).toHaveLength(3);
    expect(html).toContain('--n:3');
  });

  it('draws a board by group, with the state word styled', () => {
    const html = md(':::board\n## 지금 할 것\n- %1446 | do | 머지 승인\n- %1418 | decide | CodePush | prod 배포 직후\n## 진행\n- %1427 | running | 브라우저 12대\n:::');
    expect(html.match(/rk-bgroup/g)).toHaveLength(2);
    expect(html).toContain('rk-bs-do">할 일');
    expect(html).toContain('rk-bs-decide">결정');
    expect(html).toContain('<small>prod 배포 직후</small>');
    expect(html).toContain('rk-count">2');
  });

  it('draws layers with boundaries between them', () => {
    const html = md(':::layers\n## 브라우저\n- reader | 화면\n~ WebSocket\n## 서버\n- session\n:::');
    expect(html.match(/rk-layer"/g)).toHaveLength(2);
    expect(html).toContain('rk-boundary"><span>WebSocket</span>');
  });

  it('draws a sequence between named participants and says which step it could not place', () => {
    const html = md(':::seq 사용자 | 서버 | DB\n- 사용자 -> 서버 : 요청\n- 서버 -> DB : 조회\n- DB --> 서버 : 행\n- 서버 -> 없는사람 : 응답\n:::');
    expect(html.match(/rk-seqrow/g)).toHaveLength(3);
    expect(html).toContain('rk-dashed');
    expect(html).toContain('rk-left');
    expect(html).toContain('&quot;없는사람&quot;는 위 참여자 줄에 없어서');
  });

  it('a self step gets no arrow span', () => {
    expect(md(':::seq a | b\n- a -> a : 계산\n:::')).toContain('rk-self');
  });

  it('draws before and after bars with the change written out', () => {
    const html = md(':::bars\n- 빌드: 351 → 180초\n:::');
    expect(html).toContain('rk-pair');
    expect(html).toContain('351 → 180초');
    expect(html).toContain('−49%');
  });

  it('draws one bar split in parts with a legend', () => {
    const html = md(':::stack\n- webpack: 컴파일 168 | 배포 183\n- turbo: 컴파일 28 | 배포 152\n:::');
    expect(html.match(/rk-seg"/g)).toHaveLength(2);
    expect(html).toContain('rk-legend');
    expect(html).toContain('351');
  });

  it('draws a markdown table lightly', () => {
    const html = md(':::table 비교\n| a | b |\n|---|---|\n| 1 | 2 |\n:::');
    expect(html).toContain('rk-tbl');
    expect(html).toContain('rk-tbltitle');
    expect(html).toContain('<table>');
  });

  it('maps the names other markdown dialects use for a boxed remark', () => {
    expect(md(':::warning 조심\n내용\n:::')).toContain('rk-n-warn');
    expect(md(':::tip\n내용\n:::')).toContain('rk-n-ok');
    expect(md(':::danger\n내용\n:::')).toContain('rk-n-risk');
  });

  it('says so when cells are dropped, and shows the text of a block it could not read', () => {
    const over = md(':::decide Q\n- A | x | y | z\n:::');
    expect(over).toContain('rk-lint');
    expect(over).toContain('3개까지');
    const unread = md(':::flow\n| a | b |\n|---|---|\n| 1 | 2 |\n:::');
    expect(unread).toContain('rk-fallback');
    expect(unread).toContain('<table>');
    expect(unread).toContain('읽지 못해');
  });

  it('draws nothing extra for a clean block', () => {
    expect(md(':::summary\n- a | b\n:::')).not.toContain('rk-lint');
  });

  it('does not split cells inside a code span', () => {
    expect(splitCells('열고 닫기 | `- 칸 | 칸`을 쓴다')).toEqual(['열고 닫기', '`- 칸 | 칸`을 쓴다']);
    expect(splitCells('a | b | c')).toEqual(['a', 'b', 'c']);
    expect(md(':::summary\n- 열기 | 줄은 `- 칸 | 칸 | 칸`이다\n:::')).not.toContain('rk-lint');
  });

  it('draws an evidence tag at the end of a bar value as a chip', () => {
    const html = md(':::bars\n- 컴파일: 168 → 27.6초 [실측]\n- 단일: 5ms [추정: 로그]\n:::');
    expect(html).toContain('rk-ev-measured');
    expect(html).toContain('rk-ev-guess');
    expect(html).not.toContain('[실측]');
    expect(html).toContain('168 → 27.6초');
  });
});
