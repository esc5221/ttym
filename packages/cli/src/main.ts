#!/usr/bin/env node
// C4b: 디스패치만 남는다 — 각 도메인은 제 파일에 산다.
import process from 'node:process';
import { EXIT, getPort } from './common.js';
import { cmdStart, cmdStop, cmdRestart, cmdStatus, cmdLog } from './lifecycle.js';
import { cmdAttach } from './attach.js';
import { cmdMeta, cmdCurrent, cmdProject, cmdWorkspace } from './workspace.js';
import { cmdAgent, cmdReportStop } from './agent.js';
import { cmdNew, cmdSplit, cmdSendAddr, cmdResizeAddr, cmdKillAddr, cmdScreenAddr, cmdAwaitAddr, cmdCommandsAddr, cmdOutputAddr } from './sessions.js';

// ───── Main ─────

const cmd = process.argv[2];

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
  case 'project': await cmdProject(); break;
  case 'workspace': await cmdWorkspace(); break;
  case 'meta':    await cmdMeta(); break;
  case 'agent':   await cmdAgent(); break;
  case 'hook':
    // `hook report-stop` is the agent hook entry point; anything else is the
    // legacy alias for `agent`.
    if (process.argv[3] === 'report-stop') { await cmdReportStop(); break; }
    await cmdAgent();
    break;
  case 'log':     cmdLog(); break;
  default:
    console.log(`usage: ttym <command>`);
    console.log('');
    console.log('commands:');
    console.log('  start [--port 7690]          Start server in background');
    console.log('  stop                         Stop server (holders survive)');
    console.log('  restart                      Restart server');
    console.log('  attach <target> [--new]      Attach to session or workspace member (prefix: C-b, C-b ? for keys)');
  console.log('  new <name> [-- cmd]          Create a session in the default workspace');
  console.log('  split <addr> <name> [-- cmd] Split beside a member (addr: ws:name | :name)');
  console.log('  send <addr> -- "data"        Send bytes (addr: ws:name | :name | #id)');
  console.log('  screen <addr>                Read the screen');
  console.log('  resize <addr> <cols> <rows>  Resize a session');
  console.log('  kill <addr>                  Kill a session (holder included)');
  console.log('  await <addr> -- "prompt"     Ask an agent (or run a shell command) and wait');
  console.log('  commands <addr>              Command history with exit codes (shell integration)');
  console.log('  output <addr> [--cmd N]      One command output, precisely sliced');
    console.log('  status                       Show server & session info');
    console.log('  current                      Show current project/workspace/member context');
    console.log('  project list                 List projects');
    console.log('  workspace <command>          Workspace/member control plane');
    console.log('  meta <id> [--set k=v]        Session metadata (get/set)');
    console.log('  agent install <agent>        Install agent hook (claude, codex)');
    console.log('  agent uninstall <agent>      Remove agent hook');
    console.log('  agent status                 Show installed agent hooks');
    console.log('  agent resume [agent]         Resume agent session');
    console.log('  agent info [session-id]      Show linked agent sessions');
    console.log('  log [-f]                     Show server log');
    process.exit(cmd ? EXIT.USAGE : EXIT.OK); // 모르는 명령은 usage(2), 빈 호출의 help는 성공(0)
}
} catch (err) {
  if (isConnectFailure(err)) {
    console.error(`cannot reach ttym server on port ${getPort()} — is it running? (ttym start)`);
    process.exit(EXIT.NO_SERVER);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EXIT.FAIL);
}
