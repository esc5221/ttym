# Orchestrating many sessions

For when the user asks what is going on across their sessions, what is waiting
on them, or to pass decisions on to the agents doing the work. The loop is:
read everything, sort it, report it, relay what the user decides.

## 1. Read

Read state from the server and the transcripts. Do not ask the agents "what
are you doing?" — an ask interrupts their work and costs a turn per session,
and the transcript already holds the answer.

`scripts/digest.py` prints one block per session. Use it as it is, or copy it to
a scratch directory and change it when the question needs something else: a
different filter, another field, a different summary. It only reads.

```
digest.py                    every session, most recent first
digest.py --since 24h        only the ones active recently
digest.py --last 1305 1257   full last answer of these sessions
digest.py --grep "keyword"   which sessions' transcripts mention it
```

Where the facts come from, if you write your own:

```
GET /api/sessions                  every session: id, cmd, cols, rows
GET /api/workspaces                members: name ↔ sessionId (gives ws:name)
GET /api/agent-states              per session: kind, active, sleep, waiting
GET /api/sessions/:id/meta         cwd, claudeSessionId (or claudeLastSessionId), codexSessionId,
                                   claudeTurnOpen, agentActiveAt
GET /api/sessions/:id/runtime      holder process pid (its children tell whether the agent is alive)
GET /api/sessions/:id/screen       ?format=text: visible rows · ?format=tail&rows=N: last N rows
transcript, Claude Code            ~/.claude/projects/<cwd, every non-alphanumeric as '-'>/<id>.jsonl
transcript, Codex                  ~/.codex/sessions/<y>/<m>/<d>/rollout-*<id>.jsonl
```

Read in two passes:

- **Everything, bounded.** Per transcript, the first ~100KB (the original
  request) and the last ~300KB (the latest exchange). That keeps a hundred
  sessions to a few seconds.
- **Then only the sessions that matter, in full.** Questions for the user and
  "please check" items sit at the end of an agent's last answer, and a one-line
  summary cuts them off. `--last` prints the whole answer.

To find which session did something, search the live sessions' transcripts for
a word that would only appear there: a domain, a branch, a PR number. When two
sources disagree, settle it with a record outside the agents — a deploy log,
a commit time — not with a session's own account.

## 2. Sort

State of each session:

```
BUSY     a turn is open or the agent says it is working
live     agent process running, idle
SLEEP    put to sleep by ttym; wakes on input. Its screen is the frozen last one
FOSSIL   an agent ran here and its process is gone; the shell is left
shell    never had an agent
```

What each one needs from the user:

```
do        only the user can: a console click, a login, testing on a phone, approving a PR
decide    the agent asked a question and stopped; the answer lets it continue
running   nothing to do yet; say what it is waiting for
stalled   asked or answered days ago and nothing since
```

An item is `do` when the agent cannot reach the thing at all, not when it
merely asked permission. A finished session with nothing pending is left out
of the report.

## 3. Report

- Group by what the work belongs to (product, repository), not by session id.
  Steps of one piece of work (submit → review → release) stay together even
  when several sessions carry them.
- Name sessions `%1305`, with the address after it when it helps:
  `%1305 (starter:term-1305)`. `#` is for PRs and issues.
- One line per item: the session, the tag, what is needed. Put the detail the
  user needs to act in the line (the console, the PR, the cost difference),
  not a pointer to go read the session.
- End with a suggested order and the reason for each: finishes in seconds,
  blocks other work, tied to a date.

## 4. Relay

When the user decides, carry it to the session that has the context, rather
than doing the work in your own session.

```sh
ttym await %1305 --timeout 2400000 -- "the decision and what to do with it"
```

- Run it in the background (Claude Code: `run_in_background`), or take a
  ticket (`--timeout 1000`, then `ttym await --id`). The user keeps talking to
  you while the agent works.
- Write the prompt the way the user would: the decision, the scope it must not
  leave, when to stop and ask, and how to report back. An agent given only the
  decision tends to also fix what it noticed on the way.
- For long jobs with several steps, ask the agent to report each step as it
  finishes, so progress reaches the user without them polling.

## 5. Rules

- **Read by default.** `send`, `await`, `wake` and `sleep` change another
  session; do them only for what the user asked.
- **A sleeping pane's screen is old.** It is the last screen before sleep, kept
  on purpose. Do not read its text as the current state.
- **Look at the input line.** Text typed into a pane and never sent shows on its
  screen; mention it, the user may have forgotten it.
- **An agent saying "done" is a claim.** When the result matters (a deploy, a
  migration), check it yourself from logs, the deployed thing or the diff.
- **One at a time** when acting on several sessions: finish and check one
  before the next.
