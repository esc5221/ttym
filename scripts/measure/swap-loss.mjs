// Measure what a server swap costs a session's buffer.
//
// A holder outlives the server, so restarting the server means rebuilding the
// screen from the holder's ring (DUMP) rather than from the live stream. This
// captures both and writes them out for compare-buffers.mjs:
//
//   phase 1  attach, optionally submit prompts, keep every streamed byte
//            -> what the running server's xterm holds
//   phase 2  disconnect, reconnect, take only the DUMP
//            -> what a freshly started server can rebuild
//
// A small --ring-size reproduces a large session's ring-to-scrollback ratio
// without waiting for dozens of real responses.
//
//   node swap-loss.mjs <out-prefix> <ring-bytes> '<json prompt array>' -- <cmd...>
//
// Against an already-running holder (a dry run before a real swap), pass
// --attach <socket-path> instead of a command.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CMD_STATE = 0x02, CMD_DATA_OUT = 0x03, CMD_DATA_IN = 0x04;
const CMD_DUMP_REQ = 0x06, CMD_DUMP_RESP = 0x07;

const RUNTIME_DIR = process.env.TTYM_MEASURE_DIR || '/tmp/ttym-measure';
const HOLDER = process.env.TTYM_HOLDER_BIN
  || resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/ttym-holder');

const argv = process.argv.slice(2);
const attachAt = argv.indexOf('--attach');
const sepAt = argv.indexOf('--');

const outPrefix = argv[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frame(sock, cmdByte, payload = Buffer.alloc(0)) {
  const hdr = Buffer.allocUnsafe(5);
  hdr.writeUInt32LE(1 + payload.length, 0);
  hdr[4] = cmdByte;
  sock.write(hdr);
  if (payload.length) sock.write(payload);
}

function frameReader(onFrame) {
  let buf = Buffer.alloc(0);
  return (d) => {
    buf = buf.length === 0 ? Buffer.from(d) : Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const flen = buf.readUInt32LE(0);
      if (flen === 0 || buf.length < 4 + flen) break;
      const c = buf[4];
      const payload = buf.subarray(5, 4 + flen);
      buf = buf.subarray(4 + flen);
      onFrame(c, payload);
    }
  };
}

async function takeDump(sockPath) {
  const chunks = [];
  await new Promise((res, rej) => {
    const s = createConnection(sockPath, () => {});
    const t = setTimeout(() => rej(new Error('dump timeout')), 15000);
    s.on('data', frameReader((c, p) => {
      if (c === CMD_STATE) frame(s, CMD_DUMP_REQ);
      if (c === CMD_DUMP_RESP) { chunks.push(Buffer.from(p)); clearTimeout(t); s.destroy(); res(); }
    }));
    s.on('error', rej);
  });
  return Buffer.concat(chunks);
}

// ── Dry run against a live holder: DUMP only, no spawning ──
// NOTE: a holder serves one client at a time, so connecting evicts whatever
// server is currently attached. Only do this against a session you can disturb.
if (attachAt >= 0) {
  const sockPath = argv[attachAt + 1];
  const dump = await takeDump(sockPath);
  writeFileSync(`${outPrefix}-dump.bin`, dump);
  console.log(`holder dump: ${dump.length.toLocaleString()} bytes -> ${outPrefix}-dump.bin`);
  process.exit(0);
}

// ── Full run: spawn a holder, drive it, then swap ──
const ringSize = Number(argv[1]);
const prompts = JSON.parse(argv[2] || '[]');
const cmd = argv.slice(sepAt + 1);

const id = 91000 + Number(process.hrtime.bigint() % 9000n);
mkdirSync(RUNTIME_DIR, { recursive: true });
const sockPath = resolve(RUNTIME_DIR, `session-${id}.sock`);

const logFd = openSync(resolve(RUNTIME_DIR, 'holder.log'), 'a');
const proc = spawn(HOLDER, [
  '--id', String(id), '--cols', '100', '--rows', '30',
  '--runtime-dir', RUNTIME_DIR, '--ring-size', String(ringSize),
  '--', ...cmd,
], { detached: true, stdio: ['ignore', logFd, logFd] });
proc.unref();

for (let i = 200; i > 0 && !existsSync(sockPath); i--) await sleep(20);
if (!existsSync(sockPath)) { console.error('socket never appeared'); process.exit(1); }

const live = [];
const sock1 = createConnection(sockPath);
sock1.on('data', frameReader((c, p) => {
  if (c === CMD_DATA_OUT && p.length > 4) live.push(Buffer.from(p.subarray(4)));
}));
await sleep(9000);
console.log('  booted');

for (const p of prompts) {
  frame(sock1, CMD_DATA_IN, Buffer.from(p, 'utf8'));
  await sleep(600);
  frame(sock1, CMD_DATA_IN, Buffer.from([0x0d]));
  console.log(`    sent: ${p.slice(0, 40)}`);
  await sleep(60000);
}

const liveBytes = Buffer.concat(live);
writeFileSync(`${outPrefix}-live.bin`, liveBytes);
console.log(`  live stream: ${liveBytes.length.toLocaleString()} bytes`);

sock1.destroy();
await sleep(1500);

const dump = await takeDump(sockPath);
writeFileSync(`${outPrefix}-dump.bin`, dump);
console.log(`  holder dump: ${dump.length.toLocaleString()} bytes  (ring ${ringSize.toLocaleString()})`);

try { process.kill(proc.pid, 'SIGKILL'); } catch {}
process.exit(0);
