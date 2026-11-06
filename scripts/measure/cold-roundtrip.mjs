#!/usr/bin/env node
/**
 * cold → warm 왕복(직렬화본으로 터미널을 다시 세우고 이어지는 출력을 그림)이 원래 터미널과 같은지,
 * 런타임 폴더의 실제 체크포인트 화면 전부로 확인한다. 내용은 출력하지 않는다(개수·위치만).
 *
 *   node scripts/measure/cold-roundtrip.mjs ~/.ttym/run
 *
 * A: 화면 S를 받은 터미널 → 이어서 E      B: serialize(A after S)로 세운 터미널 → 이어서 E
 * E는 다른 체크포인트의 마지막 32KB — 상대 커서 이동·지우기·색이 섞인 실제 출력.
 * 비교: 모든 줄의 셀(글자·폭·fg·bg·속성), 줄 래핑, 커서, alternate 여부.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(here, '../../packages/server/package.json'));
const { Terminal } = req('@xterm/headless');
const { SerializeAddon } = req('@xterm/addon-serialize');

const dir = process.argv[2];
const snaps = readdirSync(dir).filter((f) => /^snapshot-\d+\.json$/.test(f))
  .map((f) => { try { return JSON.parse(readFileSync(resolve(dir, f), 'utf8')); } catch { return null; } })
  .filter((s) => s && typeof s.screen === 'string' && s.screen.length > 0);

const write = (t, d) => new Promise((r) => t.write(d, r));
const mk = (c, r) => { const t = new Terminal({ cols: c, rows: r, scrollback: 3000, allowProposedApi: true }); const s = new SerializeAddon(); t.loadAddon(s); return { t, s }; };

function cells(t) {
  const b = t.buffer.active; const cell = b.getNullCell(); const out = [];
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y); if (!line) { out.push(''); continue; }
    let row = (line.isWrapped ? 'W|' : '-|');
    for (let x = 0; x < t.cols; x++) {
      if (!line.getCell(x, cell)) break;
      row += `${cell.getChars() || ' '}${cell.getWidth()}:${cell.getFgColorMode()}.${cell.getFgColor()}:${cell.getBgColorMode()}.${cell.getBgColor()}:${+!!cell.isBold()}${+!!cell.isItalic()}${+!!cell.isUnderline()}${+!!cell.isInverse()}${+!!cell.isDim()}${+!!cell.isStrikethrough()}${+!!cell.isInvisible()};`;
    }
    out.push(row);
  }
  return out;
}

let same = 0, diff = 0; const diffs = [];
for (let i = 0; i < snaps.length; i++) {
  const s = snaps[i];
  const next = snaps[(i + 1) % snaps.length].screen;
  const E = next.slice(Math.max(0, next.length - 32768));
  const A = mk(s.cols, s.rows);
  await write(A.t, s.screen);
  // 서버와 같은 보정: 직렬화 뒤에 정확한 커서 위치(CUP)를 붙인다 (session.ts cursorTo)
  const ba0 = A.t.buffer.active;
  const ser = A.s.serialize() + `\x1b[${ba0.cursorY + 1};${ba0.cursorX + 1}H`;
  const B = mk(s.cols, s.rows);
  await write(B.t, ser);
  await write(A.t, E);
  await write(B.t, E);
  const ca = cells(A.t), cb = cells(B.t);
  const ba = A.t.buffer.active, bb = B.t.buffer.active;
  let firstDiff = -1;
  for (let y = 0; y < Math.max(ca.length, cb.length); y++) if (ca[y] !== cb[y]) { firstDiff = y; break; }
  const curA = `${ba.cursorX},${ba.cursorY},${ba.type}`, curB = `${bb.cursorX},${bb.cursorY},${bb.type}`;
  if (firstDiff < 0 && curA === curB && ca.length === cb.length) same++;
  else { diff++; diffs.push({ id: s.id, lines: [ca.length, cb.length], firstDiff, fromBottom: firstDiff >= 0 ? ca.length - firstDiff : null, cursor: [curA, curB] }); }
  A.t.dispose(); B.t.dispose();
}
console.log(JSON.stringify({ screens: snaps.length, same, diff, diffs: diffs.slice(0, 20) }, null, 1));
