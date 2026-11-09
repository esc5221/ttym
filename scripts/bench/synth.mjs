#!/usr/bin/env node
/**
 * 벤치용 합성 출력. 실제 세션 내용(대화·코드)은 쓰지 않는다 — 공용 서버로 옮기면 안 되므로.
 * Claude Code가 일할 때의 바이트 모양을 흉내 낸다: 동기 출력 블록(DEC 2026) 안에서 몇 줄 위로 올라가
 * 지우고 다시 그리기(스피너·상태줄), 색이 섞인 마크다운, 한글(넓은 글자), 래핑되는 긴 줄, OSC 133.
 *
 *   node scripts/bench/synth.mjs <out-dir>
 *   → redraw-00..39.ansi (스피너 한 프레임, 1~3KB) · stream-00..09.ansi (긴 응답, 20~60KB)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: synth.mjs <out-dir>'); process.exit(2); }
mkdirSync(out, { recursive: true });

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const words = ['server', 'session', 'holder', 'journal', 'cursor', 'replay', 'snapshot', '터미널', '세션', '화면', '출력', '복원', 'render', 'buffer', 'stream', 'viewer', '입력칸', 'pressure', 'sweep', 'index'];
const spin = ['✻', '✽', '✶', '✳', '✢', '·'];
const color = () => `\x1b[38;5;${16 + Math.floor(rnd() * 200)}m`;
const line = (n) => Array.from({ length: n }, () => pick(words)).join(' ');

for (let i = 0; i < 40; i++) {
  // 스피너·상태줄 다시 그리기: 동기 블록 안에서 6줄 위로 → 지우고 → 다시
  let s = '\x1b[?2026h\x1b[6A';
  for (let r = 0; r < 6; r++) s += `\r\x1b[2K${r === 0 ? `\x1b[38;5;208m${spin[i % spin.length]} Working… (${i}s · ↓ ${(i * 37) % 900} tokens)\x1b[0m` : `${color()}${line(6 + (r % 4))}\x1b[0m`}\n`;
  s += '\x1b[?2026l';
  writeFileSync(resolve(out, `redraw-${String(i).padStart(2, '0')}.ansi`), s);
}

for (let i = 0; i < 10; i++) {
  let s = '\x1b]133;C\x07';
  const rows = 200 + Math.floor(rnd() * 600);
  for (let r = 0; r < rows; r++) {
    if (r % 37 === 0) s += `\x1b[1m## ${line(4)}\x1b[0m\r\n`;
    else if (r % 23 === 0) s += `${'한국어 넓은 글자와 '.repeat(8)}${line(12)}\r\n`; // 래핑
    else if (r % 11 === 0) s += `  \x1b[2m│\x1b[0m \x1b[36m${line(5)}\x1b[0m  \x1b[33m${Math.floor(rnd() * 1e6)}\x1b[0m\r\n`;
    else s += `${color()}${line(5 + (r % 9))}\x1b[0m\r\n`;
  }
  s += '\x1b]133;D;0\x07';
  writeFileSync(resolve(out, `stream-${String(i).padStart(2, '0')}.ansi`), s);
}
console.log(`synth: 40 redraw + 10 stream frames in ${out}`);
