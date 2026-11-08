#!/usr/bin/env node
// C4b: 디스패치만 남는다 — 각 도메인은 제 파일에 산다.
import process from 'node:process';
import { EXIT, getPort } from './common.js';
import { cmdStart, cmdStop, cmdRestart, cmdStatus, cmdLog, ensureServerRunning } from './lifecycle.js';
import { cmdAttach } from './attach.js';
import { cmdMeta, cmdCurrent, cmdWorkspace, cmdLs } from './workspace.js';
import { listWorkspaces } from './addresses.js';
import { cmdAgent } from './agent.js';
import { cmdMap } from './map.js';
import { cmdSearch } from './search.js';
import { cmdService } from './service.js';
import { cmdRemote } from './remote.js';
import { cmdEmbed } from './embed.js';
import { cmdUpgrade, cmdVersion } from './upgrade.js';
import { cmdOpen, cmdView } from './viewer.js';
import { cmdGuide } from './guide.js';
import { readHosts, runRemote, splitRemote } from './hosts.js';
import { cmdNew, cmdSplit, cmdSendAddr, cmdResizeAddr, cmdKillAddr, cmdScreenAddr, cmdAwaitAddr, cmdTurn, cmdCommandsAddr, cmdOutputAddr } from './sessions.js';

// ───── Main ─────

// box%78 · box/ws:name · --host box — 다른 머신의 세션이면 그 머신의 ttym이 실행한다(hosts.ts).
const remote = splitRemote(process.argv.slice(2), readHosts());
if (remote) {
  if ('error' in remote) {
    console.error(remote.error);
    process.exit(EXIT.USAGE);
  } else {
    process.exit(await runRemote(remote.host, readHosts()[remote.host], remote.args));
  }
}

const cmd = process.argv[2];

function printHelp() {
  console.log(`usage: ttym [workspace]        enter an existing workspace — tmux-style (ttym attach <name> creates)`);
  console.log('');
  console.log('commands:');
  console.log('  ls [workspace] [--json]      Workspaces and their members: %id, attached/detached/gone, command');
  console.log('  attach <ws[/member]>         Attach (prefix: C-b, C-b ? for keys). Creation asks; --new skips the ask;\n                               --direct goes straight to the holder when the server is stuck');
  console.log('  new <name> [--cwd <dir>] [--size <cols>x<rows>] [-- cmd]  Create a session in the default workspace');
  console.log('  split <addr> <name> [--cwd <dir>] [--size <cols>x<rows>] [-- cmd]  Split beside a member (addr: ws:name | :name)');
  console.log('  send <addr> -- "data"        Send bytes (addr: ws:name | :name | %id; on another machine: host%id | host/ws:name)');
  console.log('  send <addr> --submit -- "t"  Type the text, then Enter (an agent: watched, retried once)');
  console.log('  screen <addr>                Read the screen');
  console.log('  resize <addr> <cols> <rows>  Resize a session');
  console.log('  kill <addr>                  Kill a session (holder included)');
  console.log('  await <addr> -- "prompt"     Ask an agent (or run a shell command) and wait');
  console.log('  turn <interaction> [--full]  What an agent did in that turn (the await footer names it)');
  console.log('  guide agents                 How agents in panes talk to each other');
  console.log('  guide markup                 The answer markup the reader draws (what the SessionStart hook hands Claude)');
  console.log('  commands <addr>              Command history with exit codes (shell integration)');
  console.log('  output <addr> [--cmd N]      One command output, precisely sliced');
  console.log('  open <path|url>... [--to <addr>] [--full|--pane] [--root <dir>]  Open inside the pane (md·csv·html·images·dirs·urls)');
  console.log('  view list|close              Viewer tabs of a pane (close <target> | --id <vid> | --all)');
  console.log('  map refresh [--model haiku]  AI-summarize stale sessions into the work map');
  console.log('  search <query…> [--lex]      Which session is it? (AI over summaries and prompts; --lex stays on this machine)');
  console.log('  status                       Show server & session info');
  console.log('  current                      Show current workspace/member context');
  console.log('  workspace <command>          Workspace/member control plane');
  console.log('  meta <id> [--set k=v]        Session metadata (get/set)');
  console.log('  agent install <agent>        Install agent hook (claude, codex)');
  console.log('  agent restart --stale         After updating claude/codex: restart running ones, same conversation');
  console.log('  service install|uninstall|status  Supervised residency: boot at login, restart on crash');
  console.log('  remote <command>             Reach ttym from another device (tailscale · cloudflare · link · doctor)');
  console.log('  embed consumer <command>     Let another app show a ttym panel (add · list · rotate · remove)');
  console.log('  upgrade [--check|--rollback|--force]  Swap in the latest release (or a new build), sessions stay alive');
  console.log('  version [--json]             CLI + server versions');
  console.log('  start / stop / restart / log Server lifecycle (start is one-shot; entry verbs autostart)');
  console.log('  --host <name> <command>      Run the command on another machine (names in ~/.ttym/hosts.json, reached by ssh)');
  console.log('  help                         This text');
}


const VERBS = ['attach', 'ls', 'new', 'split', 'send', 'screen', 'resize', 'kill', 'await', 'turn', 'guide',
  'commands', 'output', 'open', 'view', 'start', 'stop', 'restart', 'status', 'current', 'workspace', 'meta',
  'agent', 'map', 'search', 'service', 'remote', 'embed', 'upgrade', 'version', 'log', 'help'];

function editDistance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/** 없는 동사·이름: 가까운 동사와 workspace 이름을 보여주고 usage(2). 만들자고는 하지 않는다. */
function unknownCommand(token, workspaceNames) {
  const limit = token.length <= 3 ? 1 : 2;
  const near = (list) => list.filter((n) => editDistance(token, n) <= limit || (token.length >= 3 && n.startsWith(token)));
  const verbs = near(VERBS);
  const spaces = near(workspaceNames).slice(0, 5);
  console.error(`ttym: unknown command or workspace: ${token}`);
  if (verbs.length) console.error(`  command:   ${verbs.map((v) => `ttym ${v}`).join(' · ')}`);
  if (spaces.length) console.error(`  workspace: ${spaces.map((v) => `ttym ${v}`).join(' · ')}`);
  console.error('  ttym help · ttym ls');
  process.exit(EXIT.USAGE);
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
  case 'ls':      await cmdLs(); break;
  case 'new':     await cmdNew(); break;
  case 'split':   await cmdSplit(); break;
  case 'send':    await cmdSendAddr(); break;
  case 'screen':  await cmdScreenAddr(); break;
  case 'resize':  await cmdResizeAddr(); break;
  case 'kill':    await cmdKillAddr(); break;
  case 'await':   await cmdAwaitAddr(); break;
  case 'turn':    await cmdTurn(); break;
  case 'guide':   cmdGuide(); break;
  case 'commands': await cmdCommandsAddr(); break;
  case 'output':  await cmdOutputAddr(); break;
  case 'open':    await cmdOpen(); break;
  case 'view':    await cmdView(); break;
  case 'start':   cmdStart(); break;
  case 'stop':    cmdStop(); break;
  case 'restart': await cmdRestart(); break;
  case 'status':  await cmdStatus(); break;
  case 'current': await cmdCurrent(); break;
  case 'workspace': await cmdWorkspace(); break;
  case 'meta':    await cmdMeta(); break;
  case 'agent':   await cmdAgent(); break;
  case 'map':     await cmdMap(); break;
  case 'search':  await cmdSearch(); break;
  case 'service': await cmdService(); break;
  case 'remote':  await cmdRemote(); break;
  case 'embed':   await cmdEmbed(); break;
  case 'upgrade': await cmdUpgrade(); break;
  case 'version': await cmdVersion(); break;
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
    // 이름 토큰: TTY에서, 그 이름의 workspace(또는 ws/member의 ws)가 있을 때만 attach.
    // 없으면 만들자고 묻지 않는다 — 동사 오타(`ttym ls`)가 workspace 생성 질문이 되던 것.
    // 만드는 길은 `ttym attach <name>`(확인) · `--new`. 비TTY 스크립트는 그대로 usage(2).
    if (interactive && !cmd.startsWith('-')) {
      await ensureServerRunning(getPort());
      const names = (await listWorkspaces(getPort())).map((w) => w.name);
      if (names.includes(cmd.split('/')[0])) {
        process.argv.splice(2, 1, 'attach', cmd);
        await cmdAttach();
        break;
      }
      unknownCommand(cmd, names);
    }
    if (!cmd.startsWith('-')) unknownCommand(cmd, []);
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
