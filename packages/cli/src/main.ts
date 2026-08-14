#!/usr/bin/env node
// C4b: 디스패치만 남는다 — 각 도메인은 제 파일에 산다.
import process from 'node:process';
import { EXIT, getPort } from './common.js';
import { cmdStart, cmdStop, cmdRestart, cmdStatus, cmdLog } from './lifecycle.js';
import { cmdAttach } from './attach.js';
import { cmdMeta, cmdCurrent, cmdWorkspace } from './workspace.js';
import { cmdAgent, cmdReportStop } from './agent.js';
import { cmdMap } from './map.js';
import { cmdNew, cmdSplit, cmdSendAddr, cmdResizeAddr, cmdKillAddr, cmdScreenAddr, cmdAwaitAddr, cmdCommandsAddr, cmdOutputAddr } from './sessions.js';

// ───── Main ─────

const cmd = process.argv[2];

function printHelp() {
  console.log(`usage: ttym [workspace]        enter (create on confirm) — tmux-style`);
  console.log('');
  console.log('commands:');
  console.log('  attach <ws[/member]>         Attach (prefix: C-b, C-b ? for keys). Creation asks; --new skips the ask');
  console.log('  new <name> [-- cmd]          Create a session in the default workspace');
  console.log('  split <addr> <name> [-- cmd] Split beside a member (addr: ws:name | :name)');
  console.log('  send <addr> -- "data"        Send bytes (addr: ws:name | :name | #id)');
  console.log('  screen <addr>                Read the screen');
  console.log('  resize <addr> <cols> <rows>  Resize a session');
  console.log('  kill <addr>                  Kill a session (holder included)');
  console.log('  await <addr> -- "prompt"     Ask an agent (or run a shell command) and wait');
  console.log('  commands <addr>              Command history with exit codes (shell integration)');
  console.log('  output <addr> [--cmd N]      One command output, precisely sliced');
  console.log('  map refresh [--model haiku]  AI-summarize stale sessions into the work map');
  console.log('  status                       Show server & session info');
  console.log('  current                      Show current workspace/member context');
  console.log('  workspace <command>          Workspace/member control plane');
  console.log('  meta <id> [--set k=v]        Session metadata (get/set)');
  console.log('  agent install <agent>        Install agent hook (claude, codex)');
  console.log('  start / stop / restart / log Server lifecycle (start is one-shot; entry verbs autostart)');
  console.log('  help                         This text');
}


/** fetch 실패를 계약 코드로 번역한다 — 생 스택트레이스는 계약 위반이다. */
function isConnectFailure(err) {
  if (!err) return false;
  const cause = err.cause ?? err;
  return cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET'
    || cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || /fetch failed/i.test(String(err?.message ?? ''));
}

try {
switch (cmd) {
  case 'attach':  await cmdAttach(); break;
  case 'new':     await cmdNew(); break;
  case 'split':   await cmdSplit(); break;
  case 'send':    await cmdSendAddr(); break;
  case 'screen':  await cmdScreenAddr(); break;
  case 'resize':  await cmdResizeAddr(); break;
  case 'kill':    await cmdKillAddr(); break;
  case 'await':   await cmdAwaitAddr(); break;
  case 'commands': await cmdCommandsAddr(); break;
  case 'output':  await cmdOutputAddr(); break;
  case 'start':   cmdStart(); break;
  case 'stop':    cmdStop(); break;
  case 'restart': cmdRestart(); break;
  case 'status':  await cmdStatus(); break;
  case 'current': await cmdCurrent(); break;
  case 'workspace': await cmdWorkspace(); break;
  case 'meta':    await cmdMeta(); break;
  case 'agent':   await cmdAgent(); break;
  case 'hook':
    // `hook report-stop` is the agent hook entry point; anything else is the
    // legacy alias for `agent`.
    if (process.argv[3] === 'report-stop') { await cmdReportStop(); break; }
    await cmdAgent();
    break;
  case 'map':     await cmdMap(); break;
  case 'log':     cmdLog(); break;
  default: {
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (cmd === 'help' || cmd === '-h' || cmd === '--help') { printHelp(); process.exit(EXIT.OK); }
    if (!cmd) {
      // TTY면 tmux처럼 기본 workspace로 진입, 아니면(스크립트·파이프) help — §2 계약 유지.
      if (!interactive) { printHelp(); process.exit(EXIT.OK); }
      process.argv.splice(2, 0, 'attach', 'main');
      await cmdAttach();
      break;
    }
    // 이름 토큰: TTY에서만 attach로 해석 (동사 오타는 생성 확인 게이트가 막는다).
    // 비TTY 스크립트에는 여전히 usage(2) — 계약 그대로.
    if (interactive && !cmd.startsWith('-')) {
      process.argv.splice(2, 1, 'attach', cmd);
      await cmdAttach();
      break;
    }
    printHelp();
    process.exit(EXIT.USAGE);
  }
}
} catch (err) {
  if (isConnectFailure(err)) {
    console.error(`cannot reach ttym server on port ${getPort()} — is it running? (ttym start)`);
    process.exit(EXIT.NO_SERVER);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EXIT.FAIL);
}
