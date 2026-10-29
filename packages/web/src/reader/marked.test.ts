import { describe, expect, it } from 'vitest';
import { loadMarked } from './marked.js';

// reader/markdown.ts's options; newlines between blocks left out of the comparison.
const html = async (s: string) => ((await loadMarked()).parse(s, { gfm: true, breaks: false }) as string).replace(/\n/g, '');

// Bold next to a CJK particle: stars before, bold now (bp docs/261028_bp-cjk-markdown.html).
const FIXED: [string, string][] = [
  ["하위 에이전트 **\"멈춘 뒤 '작업 중' 남음 진단\"**에게", '<p>하위 에이전트 <strong>&quot;멈춘 뒤 &#39;작업 중&#39; 남음 진단&quot;</strong>에게</p>'],
  ['**"인용"**이', '<p><strong>&quot;인용&quot;</strong>이</p>'],
  ["**'따옴표'**와 **\"쌍\"**이", '<p><strong>&#39;따옴표&#39;</strong>와 <strong>&quot;쌍&quot;</strong>이</p>'],
  ['**(괄호)**는', '<p><strong>(괄호)</strong>는</p>'],
  ['**93%**로', '<p><strong>93%</strong>로</p>'],
  ['**`npm i`**로', '<p><strong><code>npm i</code></strong>로</p>'],
  ['**경로 `a/b`.**를', '<p><strong>경로 <code>a/b</code>.</strong>를</p>'],
  ['**설정 파일.**이', '<p><strong>설정 파일.</strong>이</p>'],
  ['- **항목:**설명', '<ul><li><strong>항목:</strong>설명</li></ul>'],
  ['_밑줄_은', '<p><em>밑줄</em>은</p>'],
  ['**日本語。**です', '<p><strong>日本語。</strong>です</p>'],
];
// Right before and after: inside code, English, snake_case, multiplication, strikethrough.
const KEPT: [string, string][] = [
  ['~~취소선.~~이다', '<p><del>취소선.</del>이다</p>'],
  ['**굵게**를', '<p><strong>굵게</strong>를</p>'],
  ['*기울임*은', '<p><em>기울임</em>은</p>'],
  ['`코드`**강조**', '<p><code>코드</code><strong>강조</strong></p>'],
  ['"**굵게**"를', '<p>&quot;<strong>굵게</strong>&quot;를</p>'],
  ['a **b** c', '<p>a <strong>b</strong> c</p>'],
  ['**bold**text', '<p><strong>bold</strong>text</p>'],
  ['**bold.**text', '<p>**bold.**text</p>'],
  ['**(한)**a', '<p>**(한)**a</p>'],
  ['2 * 3 * 4', '<p>2 * 3 * 4</p>'],
  ['값*2*3은', '<p>값<em>2</em>3은</p>'],
  ['파일_이름_변경', '<p>파일_이름_변경</p>'],
  ['snake_case_이름', '<p>snake_case_이름</p>'],
  ['`**굵게**를` 은 코드', '<p><code>**굵게**를</code> 은 코드</p>'],
  ['```\n**굵게**를\n```', '<pre><code>**굵게**를</code></pre>'],
  ['[**링크.**](http://x)를', '<p><a href="http://x"><strong>링크.</strong></a>를</p>'],
  ['**굵게**를 ~~지움~~', '<p><strong>굵게</strong>를 <del>지움</del></p>'],
  ['~~취소~~', '<p><del>취소</del></p>'],
  ['a ~~b~~ c', '<p>a <del>b</del> c</p>'],
];
// One tilde is not a strike (ranges, paths).
const TILDE: [string, string][] = [
  ['3~6초 보이고 … 5~8초쯤', '<p>3~6초 보이고 … 5~8초쯤</p>'],
  ['a ~b~ c', '<p>a ~b~ c</p>'],
  ['~/work/bp 와 ~/svc', '<p>~/work/bp 와 ~/svc</p>'],
  ['`~a~` 와 3~6', '<p><code>~a~</code> 와 3~6</p>'],
  ['```\n~a~ 3~6\n```', '<pre><code>~a~ 3~6</code></pre>'],
  ['3~6 이고 ~~지움~~', '<p>3~6 이고 <del>지움</del></p>'],
  ['**3~6초**는', '<p><strong>3~6초</strong>는</p>'],
];

describe('loadMarked', () => {
  for (const [src, want] of FIXED) it(`bold beside CJK: ${src}`, async () => expect(await html(src)).toBe(want));
  for (const [src, want] of TILDE) it(`one tilde: ${src}`, async () => expect(await html(src)).toBe(want));
  for (const [src, want] of KEPT) it(`unchanged: ${src}`, async () => expect(await html(src)).toBe(want));
});
