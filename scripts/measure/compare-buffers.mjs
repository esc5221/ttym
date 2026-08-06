// Replay two byte streams through the same headless xterm the server uses and
// report what a swap loses.
//
// Byte loss and row loss are not the same number: agent TUIs redraw in place,
// so most bytes never reach the final cell state. Comparing rendered rows is
// the only measure that matches what a user sees.
//
//   node compare-buffers.mjs <prefix>        # reads <prefix>-live.bin / -dump.bin
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM resolves bare specifiers from this file's location, not the cwd, so point
// the resolver at the server workspace where @xterm/headless is installed.
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../../server/package.json'));
const { Terminal } = require('@xterm/headless');

const prefix = process.argv[2];
if (!prefix) { console.error('usage: compare-buffers.mjs <prefix>'); process.exit(2); }

async function render(file) {
  const bytes = readFileSync(file);
  const term = new Terminal({ cols: 100, rows: 30, scrollback: 3000, allowProposedApi: true });
  await new Promise((r) => term.write(bytes, r));
  const buf = term.buffer.active;
  const text = [];
  for (let i = 0; i < buf.length; i++) text.push(buf.getLine(i)?.translateToString(true) ?? '');
  return { bytes: bytes.length, baseY: buf.baseY, length: buf.length, text: text.join('\n') };
}

const live = await render(`${prefix}-live.bin`);
const dump = await render(`${prefix}-dump.bin`);

console.log('=== 교체 전 (서버가 실시간으로 받은 전체 스트림) ===');
console.log(`  bytes         : ${live.bytes.toLocaleString()}`);
console.log(`  baseY         : ${live.baseY}`);
console.log(`  buffer.length : ${live.length}`);

console.log('\n=== 교체 후 (새 서버가 holder DUMP로 재구성) ===');
console.log(`  bytes         : ${dump.bytes.toLocaleString()}`);
console.log(`  baseY         : ${dump.baseY}`);
console.log(`  buffer.length : ${dump.length}`);

const lossBytes = live.bytes - dump.bytes;
const lossRows = live.baseY - dump.baseY;
console.log('\n=== 손실 ===');
console.log(`  바이트 : ${lossBytes.toLocaleString()} (${(lossBytes / live.bytes * 100).toFixed(1)}%)`);
console.log(`  행     : ${lossRows} (baseY ${live.baseY} → ${dump.baseY}, ${live.baseY ? (lossRows / live.baseY * 100).toFixed(1) : 0}%)`);

const liveLines = live.text.split('\n').filter((l) => l.trim().length > 20);
const at = [0, 0.25, 0.5, 0.75, 1].map((f) => liveLines[Math.min(liveLines.length - 1, Math.floor(liveLines.length * f))]);
const labels = ['맨 앞', '25%', '50%', '75%', '맨 끝'];

console.log('\n=== 위치별 내용 생존 (교체 전 버퍼 기준) ===');
at.forEach((line, i) => {
  if (!line) return;
  const survives = dump.text.includes(line.trim().slice(0, 40));
  console.log(`  ${labels[i].padEnd(6)} ${survives ? '생존' : '유실'}  "${line.trim().slice(0, 46)}"`);
});
