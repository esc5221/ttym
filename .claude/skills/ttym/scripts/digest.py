#!/usr/bin/env python3
"""One block per ttym session: where it is, what it was asked, what it said last.

Read-only: GET requests to the ttym server, reads of transcript files, `git status`.
A starting point, not a contract. Copy it to a scratch directory and change it
when the question needs something else.

  digest.py                    every session, most recent first
  digest.py --since 24h        only sessions active in the last 24 hours
  digest.py --last 1305 1257   the full last answer of these sessions
  digest.py --grep "keyword"   sessions whose transcript mentions it, with counts
"""
import argparse, glob, json, os, re, subprocess, time, urllib.request
from datetime import datetime

HOME = os.path.expanduser('~')
NOW = time.time()
API = ''

# Transcript reads are bounded so a hundred sessions take seconds: the head has
# the first request, the tail has the latest exchange.
HEAD_BYTES = 96_000
TAIL_BYTES = 300_000
NOISE = re.compile(r'^(<command-|<local-command|<system-reminder|Caveat:|\[Request interrupted|<task-notification|<bash-)')


def get(path):
    return json.load(urllib.request.urlopen(API + path, timeout=10))


def ago(ts):
    if not ts:
        return '?'
    d = NOW - ts
    return f'{d / 60:.0f}m' if d < 3600 else f'{d / 3600:.1f}h' if d < 86400 else f'{d / 86400:.1f}d'


def clip(s, n):
    s = re.sub(r'\s+', ' ', s or '').strip()
    return s if len(s) <= n else s[:n] + '…'


def iso(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None


def text_of(content):
    if isinstance(content, str):
        return content
    return '\n'.join(c.get('text', '') for c in content or []
                     if isinstance(c, dict) and c.get('type') in ('text', 'input_text', 'output_text'))


def read_events(path, whole=False):
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        if whole or size <= HEAD_BYTES + TAIL_BYTES:
            lines = f.read().decode('utf8', 'replace').split('\n')
            head, tail = lines, lines
        else:
            head = f.read(HEAD_BYTES).decode('utf8', 'replace').split('\n')[:-1]
            f.seek(size - TAIL_BYTES)
            tail = f.read().decode('utf8', 'replace').split('\n')[1:]

    def parse(ls):
        out = []
        for line in ls:
            try:
                out.append(json.loads(line))
            except Exception:
                pass
        return out
    return parse(head), parse(tail), size


# ── transcripts ────────────────────────────────────────────────────────────

def find_transcript(kind, meta):
    """Claude: ~/.claude/projects/<cwd with non-alnum as '-'>/<id>.jsonl. Codex: rollout-*<id>.jsonl."""
    if kind == 'claude-code':
        sid = meta.get('claudeSessionId') or meta.get('claudeLastSessionId')
        if not sid:
            return None
        enc = re.sub(r'[^A-Za-z0-9]', '-', meta.get('cwd') or '')
        path = f'{HOME}/.claude/projects/{enc}/{sid}.jsonl'
        if os.path.exists(path):
            return path
        found = glob.glob(f'{HOME}/.claude/projects/*/{sid}.jsonl')
        return found[0] if found else None
    if kind == 'codex':
        sid = meta.get('codexSessionId')
        found = glob.glob(f'{HOME}/.codex/sessions/*/*/*/rollout-*{sid}.jsonl') if sid else []
        return found[0] if found else None
    return None


def claude_summary(path):
    head, tail, size = read_events(path)

    def requests(events):
        out = []
        for e in events:
            if e.get('type') != 'user' or e.get('isMeta'):
                continue
            content = e.get('message', {}).get('content')
            if isinstance(content, list) and any(isinstance(c, dict) and c.get('type') == 'tool_result' for c in content):
                continue
            t = text_of(content).strip()
            if t and not NOISE.match(t):
                out.append(t)
        return out

    last_answer = last_ts = ends_with = None
    for e in tail:
        if e.get('type') not in ('user', 'assistant'):
            continue
        last_ts = e.get('timestamp')
        content = e.get('message', {}).get('content') or []
        ends_with = e['type']
        if e['type'] == 'assistant':
            t = text_of(content).strip()
            if t:
                last_answer = t
            if any(isinstance(c, dict) and c.get('type') == 'tool_use' for c in content):
                ends_with = 'tool_use'
        elif isinstance(content, list) and any(isinstance(c, dict) and c.get('type') == 'tool_result' for c in content):
            ends_with = 'tool_result'
    first = requests(head)
    return dict(first=first[0] if first else None, latest=requests(tail)[-2:], answer=last_answer,
                ts=iso(last_ts) if last_ts else None, ends_with=ends_with, size=size)


def codex_summary(path):
    head, tail, size = read_events(path)

    def requests(events):
        out = []
        for e in events:
            p = e.get('payload', {})
            if e.get('type') == 'event_msg' and p.get('type') == 'user_message' and (p.get('message') or '').strip():
                out.append(p['message'].strip())
        return out

    last_answer = last_ts = ends_with = None
    for e in tail:
        p = e.get('payload', {})
        last_ts = e.get('timestamp') or last_ts
        if e.get('type') == 'event_msg' and p.get('type') == 'task_complete':
            last_answer = p.get('last_agent_message') or last_answer
            ends_with = 'task_complete'
        elif e.get('type') == 'response_item' and p.get('type') == 'message' and p.get('role') == 'assistant':
            last_answer = text_of(p.get('content')) or last_answer
            ends_with = 'assistant'
        elif e.get('type') == 'event_msg' and p.get('type') in ('task_started', 'user_message'):
            ends_with = p['type']
    first = requests(head)
    return dict(first=first[0] if first else None, latest=requests(tail)[-2:], answer=last_answer,
                ts=iso(last_ts) if last_ts else None, ends_with=ends_with, size=size)


# ── session facts ──────────────────────────────────────────────────────────

_git = {}


def git_state(cwd):
    if not cwd or not os.path.isdir(cwd):
        return None
    if cwd not in _git:
        try:
            run = lambda *a: subprocess.run(['git', '-C', cwd, *a], capture_output=True, text=True, timeout=10).stdout
            top = run('rev-parse', '--show-toplevel').strip()
            _git[cwd] = top and dict(repo=os.path.basename(top), branch=run('branch', '--show-current').strip() or '(detached)',
                                    dirty=len(run('status', '--porcelain').splitlines()))
        except Exception:
            _git[cwd] = None
    return _git[cwd]


def process_tree():
    tree = {}
    for line in subprocess.run(['ps', '-axo', 'pid=,ppid=,command='], capture_output=True, text=True).stdout.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            tree.setdefault(int(parts[1]), []).append((int(parts[0]), parts[2]))
    return tree


def descendants(pid, tree):
    out, stack = [], [pid]
    while stack:
        for child, cmd in tree.get(stack.pop(), []):
            out.append(cmd)
            stack.append(child)
    return out


def collect():
    states = get('/api/agent-states')
    where = {m['sessionId']: f"{w['name']}:{m['name']}" for w in get('/api/workspaces') for m in w['members']}
    tree = process_tree()
    rows = []
    for s in get('/api/sessions'):
        sid = s['id']
        st = states.get(str(sid), {})
        meta = get(f'/api/sessions/{sid}/meta')
        kind = st.get('kind')
        pid = (get(f'/api/sessions/{sid}/runtime').get('process') or {}).get('pid')
        kids = descendants(pid, tree) if pid else []
        agent_alive = any(re.search(r'(^|/)(claude|codex)[\w.-]*( |$)', k.split(' --')[0]) and 'ttym agent' not in k for k in kids)
        path = find_transcript(kind, meta)
        summary = None
        if path:
            summary = (claude_summary if kind == 'claude-code' else codex_summary)(path)
        last = (summary or {}).get('ts') or (os.path.getmtime(path) if path else None) or ((meta.get('agentActiveAt') or 0) / 1000) or None
        if st.get('sleep') and (st['sleep'] or {}).get('state'):
            state = 'SLEEP'
        elif st.get('active') or meta.get('claudeTurnOpen'):
            state = 'BUSY'
        elif kind and agent_alive:
            state = 'live'
        elif kind:
            state = 'FOSSIL'   # an agent was here and its process is gone
        else:
            state = 'shell'
        rows.append(dict(sid=sid, where=where.get(sid, '(no workspace)'), kind=kind, state=state, waiting=st.get('waiting'),
                         cwd=meta.get('cwd'), git=git_state(meta.get('cwd')), summary=summary, last=last, path=path))
    rows.sort(key=lambda r: -(r['last'] or 0))
    return rows


def show(rows):
    for r in rows:
        kind = {'claude-code': 'claude', 'codex': 'codex'}.get(r['kind'], 'shell')
        g = r['git']
        place = f"{g['repo']}@{g['branch']}{' dirty' + str(g['dirty']) if g['dirty'] else ''}" if g else (r['cwd'] or '').replace(HOME, '~')
        when = datetime.fromtimestamp(r['last']).strftime('%m-%d %H:%M') if r['last'] else '?'
        waiting = f" waiting:{r['waiting']}" if r['waiting'] else ''
        print(f"%{r['sid']} {r['where']} | {kind} {r['state']}{waiting} | {place} | last {when} ({ago(r['last'])})")
        s = r['summary']
        if not s:
            continue
        if s['first']:
            print(f"   first : {clip(s['first'], 160)}")
        for u in s['latest']:
            print(f"   asked : {clip(u, 200)}")
        if s['answer']:
            print(f"   said  : {clip(s['answer'], 260)}")
        print(f"   ends  : {s['ends_with']} · {s['size'] // 1024}KB")


def main():
    global API
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT') or os.environ.get('TTYM_PORT') or 7690))
    ap.add_argument('--since', help='only sessions active within this window: 30m, 6h, 2d')
    ap.add_argument('--last', nargs='+', type=int, metavar='ID', help='print the full last answer of these sessions')
    ap.add_argument('--grep', metavar='TEXT', help='sessions whose transcript contains TEXT')
    args = ap.parse_args()
    API = f'http://127.0.0.1:{args.port}'

    rows = collect()
    if args.since:
        n, unit = float(args.since[:-1]), args.since[-1]
        window = n * {'m': 60, 'h': 3600, 'd': 86400}[unit]
        rows = [r for r in rows if r['last'] and NOW - r['last'] <= window]
    if args.grep:
        needle = args.grep.encode()
        for r in rows:
            if r['path']:
                with open(r['path'], 'rb') as f:
                    hits = sum(1 for line in f if needle in line)
                if hits:
                    print(f"%{r['sid']} {r['where']}  {hits} lines  {r['path']}")
        return
    if args.last:
        by_id = {r['sid']: r for r in rows}
        for sid in args.last:
            r = by_id.get(sid)
            s = r and r['summary']
            print(f"── %{sid} {r['where'] if r else ''} {r['state'] if r else '(not found)'}")
            if s:
                if s['latest']:
                    print(f"asked: {clip(s['latest'][-1], 400)}\n")
                print(s['answer'] or '(no answer yet)')
            print()
        return
    show(rows)


if __name__ == '__main__':
    main()
