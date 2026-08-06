// Capture the raw bytes a command emits through a PTY, by running it under a
// holder and reading DATA_OUT frames off the holder socket.
//
// Used to answer questions the rendered screen cannot: which control sequences
// a TUI actually emits (RFD §9 alternate-screen question), and how many bytes
// one response costs.
//
//   node capture-pty.mjs <out-file> <seconds> [--prompt TEXT] -- <cmd...>
//
// With --prompt, the text is submitted after the TUI settles (8s) followed by
// CR, so the capture covers a real response rather than just the startup render.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CMD_STATE = 0x02, CMD_DATA_OUT = 0x03, CMD_DATA_IN = 0x04;

// A unix socket path must fit in SUN_LEN (~104 bytes), so the runtime dir has
// to stay short — a scratch path under /tmp/... can already exceed it.
const RUNTIME_DIR = process.env.TTYM_MEASURE_DIR || '/tmp/ttym-measure';
const HOLDER = process.env.TTYM_HOLDER_BIN
  || resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/ttym-holder');

const argv = process.argv.slice(2);
const sepAt = argv.indexOf('--');
if (sepAt < 0) {
  console.error('usage: capture-pty.mjs <out-file> <seconds> [--prompt TEXT] -- <cmd...>');
  process.exit(2);
}
const head = argv.slice(0, sepAt);
const cmd = argv.slice(sepAt + 1);
const outFile = head[0];
const seconds = Number(head[1]);
const promptAt = head.indexOf('--prompt');
const prompt = promptAt >= 0 ? head[promptAt + 1] : null;

const id = 90000 + Number(process.hrtime.bigint() % 9000n);
mkdirSync(RUNTIME_DIR, { recursive: true });
const sockPath = resolve(RUNTIME_DIR, `session-${id}.sock`);

const logFd = openSync(resolve(RUNTIME_DIR, 'holder.log'), 'a');
const proc = spawn(HOLDER, [
  '--id', String(id), '--cols', '100', '--rows', '30',
  '--runtime-dir', RUNTIME_DIR, '--', ...cmd,
], { detached: true, stdio: ['ignore', logFd, logFd] });
proc.unref();

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitSock(tries = 200) {
  while (tries-- > 0) { if (existsSync(sockPath)) return; await sleep(20); }
  throw new Error(`socket never appeared: ${sockPath}`);
}

await waitSock();

const chunks = [];
const sock = createConnection(sockPath, () => {
  console.log(`capturing ${seconds}s of: ${cmd.join(' ')}`);
});
sock.on('data', frameReader((c, p) => {
  if (c === CMD_DATA_OUT && p.length > 4) chunks.push(Buffer.from(p.subarray(4)));
  if (c === CMD_STATE) console.log('  booted');
}));
sock.on('error', (e) => console.error('socket error:', e.message));

if (prompt) {
  setTimeout(async () => {
    console.log(`  submitting: ${prompt.slice(0, 50)}`);
    frame(sock, CMD_DATA_IN, Buffer.from(prompt, 'utf8'));
    await sleep(600);
    frame(sock, CMD_DATA_IN, Buffer.from([0x0d]));
  }, 8000);
}

setTimeout(() => {
  const all = Buffer.concat(chunks);
  writeFileSync(outFile, all);
  console.log(`captured ${all.length.toLocaleString()} bytes -> ${outFile}`);
  try { process.kill(proc.pid, 'SIGKILL'); } catch {}
  process.exit(0);
}, seconds * 1000);
