import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { readPid, GLOBAL, EXIT, getPort, apiBase, legacyBody, fetchJson, fetchPatch, fetchPost, fetchDelete, fetchRequest, ensureCompatibleServer, hasFlag, readOption, printOutput, encodeFrame, encodeDataFrame, decodeFrame, parseFrameJson, CMD, encoder, decoder, HOME_DIR, PID_FILE, LOG_FILE, SERVER_JS, HOLDER_BIN, HTTP_TIMEOUT_MS, ATTACH_RETRY_MS, DETACH_KEY } from './common.js';
import { resolveCurrentWorkspace, findWorkspaceBySessionId, listWorkspaces } from './addresses.js';
// 이 파일은 C4b 분할로 main.ts에서 나왔다 — 동작 이동 없음, 구조 이동만.
// ───── Agent Integration ─────

export const AGENTS = {
  claude: {
    name: 'Claude Code',
    settingsPath: resolve(process.env.HOME || '/tmp', '.claude', 'settings.json'),
    metaKey: 'claudeSessionId',
    lastMetaKey: 'claudeLastSessionId',
    hooks: [
      {
        event: 'SessionStart',
        matcher: '',
        command: resolve(__dirname, '..', 'scripts', 'ttym-claude-hook.sh'),
      },
      // Turn start. Without it, claudeActive was set once at SessionStart and
      // cleared by the first Stop — the liveness stamp then never refreshed
      // and agent activity was invisible from the second turn on.
      {
        event: 'UserPromptSubmit',
        matcher: '',
        command: resolve(__dirname, '..', 'scripts', 'ttym-claude-activity-hook.sh'),
      },
      {
        event: 'Stop',
        matcher: '',
        command: `${resolve(__dirname, '..', 'scripts', 'ttym-claude-stop-hook.sh')} Stop`,
      },
      // A turn that ends without an answer still has to end the wait. Without
      // these, `await` on a failed or closed session blocks until its timeout.
      {
        event: 'StopFailure',
        matcher: '',
        command: `${resolve(__dirname, '..', 'scripts', 'ttym-claude-stop-hook.sh')} StopFailure`,
      },
      {
        event: 'SessionEnd',
        matcher: '',
        command: `${resolve(__dirname, '..', 'scripts', 'ttym-claude-stop-hook.sh')} SessionEnd`,
      },
    ],
    resumeArgs: (sid) => ['claude', '--resume', sid],
    resumeFlagsEnv: 'TTYM_CLAUDE_RESUME_FLAGS',
  },
  codex: {
    name: 'Codex CLI (experimental)',
    settingsPath: resolve(process.env.HOME || '/tmp', '.codex', 'hooks.json'),
    metaKey: 'codexSessionId',
    lastMetaKey: 'codexLastSessionId',
    hooks: [
      // 인라인 명령이 아니라 스크립트인 이유: Codex 는 SessionStart hook 의
      // stdout 을 자기 JSON 으로 읽는다. 예전 명령이 부르던 `ttym meta` 는
      // 세션 메타를 stdout 에 찍었고, 올바른 JSON이지만 스키마가 달라
      // "invalid session start JSON output" 이 매번 났다. 스크립트는 아무것도
      // 출력하지 않는다.
      {
        event: 'SessionStart',
        matcher: '',
        command: resolve(__dirname, '..', 'scripts', 'ttym-codex-hook.sh'),
      },
      {
        event: 'Stop',
        matcher: '',
        command: resolve(__dirname, '..', 'scripts', 'ttym-codex-stop-hook.sh'),
      },
    ],
    resumeArgs: (sid) => ['codex', 'resume', sid],
    resumeFlagsEnv: 'TTYM_CODEX_RESUME_FLAGS',
  },
};

function isttymHook(command, cfg) {
  return cfg.hooks.some((hook) => command === hook.command)
    || (cfg.metaKey === 'claudeSessionId'
      && command.includes('TTYM_SESSION_ID')
      && (command.includes('--claude-session') || command.includes('--clear-claude-session')))
    || (cfg.metaKey === 'codexSessionId'
      && command.includes('TTYM_SESSION_ID')
      && (command.includes('--codex-session') || command.includes('--clear-codex-session')));
}

function isHookInstalled(cfg) {
  try {
    const settings = JSON.parse(readFileSync(cfg.settingsPath, 'utf8'));
    return cfg.hooks.every((wanted) => {
      const entries = settings?.hooks?.[wanted.event] || [];
      return entries.some((entry) => {
        const sameMatcher = (entry.matcher ?? '') === (wanted.matcher ?? '');
        return sameMatcher && entry.hooks?.some((hook) => isttymHook(hook.command || '', cfg));
      });
    });
  } catch { return false; }
}

function agentInstall(cfg) {
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(readFileSync(cfg.settingsPath, 'utf8')); } catch {}

  if (!settings.hooks) settings.hooks = {};

  let changed = false;
  for (const wanted of cfg.hooks) {
    if (!Array.isArray(settings.hooks[wanted.event])) settings.hooks[wanted.event] = [];

    let target = settings.hooks[wanted.event].find((entry) => (entry.matcher ?? '') === (wanted.matcher ?? ''));
    if (!target) {
      target = { matcher: wanted.matcher, hooks: [] } as { matcher: string; hooks: unknown[] };
      settings.hooks[wanted.event].push(target);
    }
    if (!Array.isArray(target.hooks)) target.hooks = [];

    if (target.hooks.some((hook) => isttymHook(hook.command || '', cfg))) continue;
    target.hooks.push({ type: 'command', command: wanted.command, timeout: 5 });
    changed = true;
  }

  if (!changed) {
    console.log(`${cfg.name} hook already installed`);
    return;
  }

  if (existsSync(cfg.settingsPath)) {
    writeFileSync(cfg.settingsPath + '.bak', readFileSync(cfg.settingsPath));
  }
  mkdirSync(dirname(cfg.settingsPath), { recursive: true });
  writeFileSync(cfg.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`${cfg.name} hook installed`);
  console.log(`  file:  ${cfg.settingsPath}`);
}

function agentUninstall(cfg) {
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(readFileSync(cfg.settingsPath, 'utf8')); } catch {}

  let removed = false;
  for (const wanted of cfg.hooks) {
    const entries = settings?.hooks?.[wanted.event] || [];
    for (const entry of entries) {
      if (!Array.isArray(entry.hooks)) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((hook) => !isttymHook(hook.command || '', cfg));
      if (entry.hooks.length < before) removed = true;
    }
  }

  if (!removed) {
    console.log(`${cfg.name} hook not found`);
    return;
  }

  if (existsSync(cfg.settingsPath)) {
    writeFileSync(cfg.settingsPath + '.bak', readFileSync(cfg.settingsPath));
  }
  writeFileSync(cfg.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`${cfg.name} hook uninstalled`);
}

function resolveAgent(name) {
  if (name && !AGENTS[name]) {
    console.error(`unknown agent: ${name}`);
    console.error(`available: ${Object.keys(AGENTS).join(', ')}`);
    process.exit(EXIT.USAGE);
  }
  return name ? AGENTS[name] : null;
}

export async function cmdAgent() {
  const action = process.argv[3];
  // For `resume`, argv[4] may be an agent name OR a flag for the underlying agent.
  // If it starts with '-', treat it as a flag and leave agentName auto-detected.
  const argv4 = process.argv[4];
  const agentName = argv4 && !argv4.startsWith('-') ? argv4 : undefined;
  const extraArgs = action === 'resume'
    ? process.argv.slice(agentName ? 5 : 4).filter((a) => a !== '--')
    : [];

  // ── status ──
  if (action === 'status') {
    for (const [key, cfg] of Object.entries(AGENTS)) {
      const installed = isHookInstalled(cfg);
      console.log(`  ${key}: ${installed ? 'installed' : 'not installed'} (${cfg.settingsPath})`);
    }
    return;
  }

  // ── install / uninstall ──
  if (action === 'install' || action === 'uninstall') {
    if (!agentName) {
      console.error(`usage: ttym agent ${action} <${Object.keys(AGENTS).join('|')}>`);
      process.exit(EXIT.USAGE);
    }
    const cfg = resolveAgent(agentName);
    return action === 'install' ? agentInstall(cfg) : agentUninstall(cfg);
  }

  // ── info ──
  if (action === 'info') {
    const sid = agentName || process.env.TTYM_SESSION_ID;
    if (!sid || isNaN(parseInt(sid, 10))) {
      console.error('usage: ttym agent info [session-id]');
      console.error('  (or run inside a ttym session)');
      process.exit(EXIT.USAGE);
    }
    const port = getPort();
    try {
      const meta = await fetchJson(port, `/api/sessions/${parseInt(sid, 10)}/meta`);
      let found = false;
      for (const [key, cfg] of Object.entries(AGENTS)) {
        const active = meta?.[cfg.metaKey];
        const last = meta?.[cfg.lastMetaKey];
        if (active) {
          console.log(`  ${key}: ${active} (active)`);
          found = true;
        } else if (last) {
          console.log(`  ${key}: ${last} (last)`);
          found = true;
        }
      }
      if (!found) {
        console.log('no agent session linked');
        return;
      }
    } catch {
      console.error('failed to connect to ttym server');
      process.exit(EXIT.NO_SERVER);
    }
    return;
  }

  // ── resume ──
  if (action === 'resume') {
    const sid = process.env.TTYM_SESSION_ID;
    if (!sid) {
      console.error('ttym agent resume must be run inside a ttym session');
      process.exit(EXIT.FAIL);
    }
    const port = getPort();
    let meta;
    try {
      meta = await fetchJson(port, `/api/sessions/${parseInt(sid, 10)}/meta`);
    } catch {
      console.error('failed to connect to ttym server');
      process.exit(EXIT.NO_SERVER);
    }

    // Find which agent to resume
    let targetCfg = null;
    let targetSessionId = null;

    if (agentName) {
      // Explicit agent
      const cfg = resolveAgent(agentName);
      targetSessionId = meta?.[cfg.metaKey] || meta?.[cfg.lastMetaKey];
      if (!targetSessionId) {
        console.error(`no ${cfg.name} session linked to this ttym session`);
        process.exit(EXIT.NOT_FOUND);
      }
      targetCfg = cfg;
    } else {
      // Auto-detect: try active first, then last session
      for (const [, cfg] of Object.entries(AGENTS)) {
        if (meta?.[cfg.metaKey]) {
          targetCfg = cfg;
          targetSessionId = meta[cfg.metaKey];
          break;
        }
      }
      if (!targetCfg) {
        for (const [, cfg] of Object.entries(AGENTS)) {
          if (meta?.[cfg.lastMetaKey]) {
            targetCfg = cfg;
            targetSessionId = meta[cfg.lastMetaKey];
            break;
          }
        }
      }
      if (!targetCfg) {
        console.error('no agent session linked to this ttym session');
        process.exit(EXIT.NOT_FOUND);
      }
    }

    const baseArgs = targetCfg.resumeArgs(targetSessionId);
    // Default flags from env (e.g. TTYM_CLAUDE_RESUME_FLAGS="--dangerously-skip-permissions")
    const envFlags = targetCfg.resumeFlagsEnv
      ? (process.env[targetCfg.resumeFlagsEnv] || '').split(/\s+/).filter(Boolean)
      : [];
    const args = [...baseArgs, ...envFlags, ...extraArgs];
    console.log(`resuming ${targetCfg.name}: ${args.join(' ')}`);
    const child = spawn(args[0], args.slice(1), { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  // ── usage ──
  console.log('usage: ttym agent <command>');
  console.log('');
  console.log('commands:');
  console.log('  install <agent>       Install SessionStart hook');
  console.log('  uninstall <agent>     Remove hook');
  console.log('  status                Show installed hooks');
  console.log('  resume [agent] [...extra-args]');
  console.log('                        Resume agent session (auto-detect or specify);');
  console.log('                        extra args are passed to the agent verbatim.');
  console.log('                        Defaults can be set via TTYM_CLAUDE_RESUME_FLAGS /');
  console.log('                        TTYM_CODEX_RESUME_FLAGS env vars.');
  console.log('  info [session-id]     Show linked agent sessions');
  console.log('');
  console.log('agents:');
  for (const [key, cfg] of Object.entries(AGENTS)) {
    console.log(`  ${key}    ${cfg.name}`);
  }
  process.exit(EXIT.USAGE);
}

// ───── Agent hook entry point ─────

