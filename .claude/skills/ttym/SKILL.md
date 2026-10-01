---
name: ttym
description: Run other coding agents as persistent terminal sessions and delegate work to them. Use when a task wants a second agent working in parallel, a long job that must survive this conversation, work in a different directory or git worktree, when you need to read or drive a session someone else started, or when the user wants the state of all their sessions and what is waiting on them. Triggers — "ttym", "spawn an agent", "have codex do it", "run it in parallel", "in another session", "background agent", "delegate this", "hand it off", "worktree agent", "what are my sessions doing", "what is waiting on me", "orchestrate". Not for running a command and reading its output; that is a plain shell call.
---

# ttym

ttym keeps PTY sessions alive on a server. A session outlives the client that
made it, the server that hosts it, and this conversation. That is the whole
reason to reach for it: work you start here keeps running after you stop
watching.

Sessions are addressed with a colon: `ws:name`, `:name` inside your own
workspace, or `%id` (`%1297`). `ttym --help` has the grammar. This file has the
judgement calls it cannot make for you.

When you mention a session to the user or in a report, write it as `%1297`,
optionally followed by its address: `%1297 (server:term-1297)`. Not "pane 1297",
not `#1297` — `#` reads as a PR or issue number, and in a shell an unquoted
`#1297` starts a comment. In the ttym web UI, `%1297` in terminal output is a
link: hover shows that session's last lines, click opens it in a new tab.
The CLI still accepts `#1297` for old scripts; do not write it.

Sessions on another machine are `box%78` or `box/ws:name`, and
`ttym --host box <command>` runs a whole command there. The names come from
`~/.ttym/hosts.json` (`{ "box": { "ssh": "box" } }`); the command runs on that
machine over ssh, so send, await, screen and sleep behave as they do locally.
Write sessions of other machines with their name in reports too: `box%78`.

## Is this the right tool

```
yes   another agent should work while you work
      the job outlives this conversation
      the work belongs in a different cwd or worktree
      you need to watch or steer a session already running

no    you just want a command's output      → run it in your shell
      the job takes seconds                 → run it in your shell
```

## Spawning an agent

```sh
ttym new <name> --cwd <dir> --size 170x50 -- <agent>          # new workspace
ttym split <ws:name> <new> --cwd <dir> --size 170x50 -- <agent>  # beside an existing one
```

Always pass `--cwd`. The agent inherits it, and an agent in the wrong directory
reads the wrong repository. Pass `--size` too when the target is a TUI agent —
the 80x24 default folds their output into something neither of you can read.

Agents differ in ways that matter:

```
claude   ready in 3-5s   await → its answer + turn    no cwd flag of its own → --cwd is the only way
codex    ready at once   await → its answer + turn    has -C, but --cwd is clearer
zsh      ready at once   await runs the text as a command and returns its output
                         (needs shell integration; without it await only times out —
                          drive it with send, read it with screen)
```

## Handing over work

```sh
ttym await <addr> --timeout <ms> -- "the whole task, in one prompt"
```

`await` sends the prompt and blocks until the agent finishes its turn. Write the
prompt as a complete brief — the agent cannot ask you a follow-up question while
you are blocked on it. Say what to build, where the relevant files are, and what
"done" means.

Set `--timeout` to what the work deserves, not to a safe-looking number. Forty
minutes is `2400000`. A timeout that fires early does not stop the agent; it
only stops you from hearing about it.

For anything long, do not sit blocked on it:

- Claude Code: run the `await` with the Bash tool's `run_in_background`. You are
  told when it lands, and ttym will not put you to sleep while it runs.
- Anything without background notifications (Codex, a script): take a ticket.
  `ttym await <addr> --timeout 1000 -- "…"` returns at once with exit 124 and the
  interaction id on stderr while the agent keeps working. Later,
  `ttym await --id <id> --timeout <ms>` collects the answer, at once if it is
  already done.

`ttym guide agents` has the details for the binary you are running.

## Reading the result

`await` returns what the agent said last in that turn, read from its transcript,
and two lines under it:

```
── turn int_xxx · 42s · tools 3 (Bash 2, Read 1) · edited 1: foo.ts
   more: ttym turn int_xxx   (--full: tool inputs/outputs)
```

The answer is the agent's own summary. The footer is what it did: "no tools"
means it only talked. When the footer does not match the claim, read more:
`ttym turn <id>` (every message + one line per tool) or `--full` (tool
inputs and outputs). Then verify it yourself — run the tests, read the diff. An
agent reporting success is a claim, not evidence.

`ttym screen <addr>` shows the current screen with control characters stripped.
Add `--raw` only when you actually need the escape sequences.

## When await comes back empty

With `--json`, `reason` says what happened:

```
done      finished; output is the answer
timeout   still running — the session is fine, you stopped waiting.
          output is null; screen holds what the pane shows right now
failed    the turn ended without an answer
```

`output` is only ever an answer. Do not read `screen` as one — it is a
progress view, whatever was on the pane when the wait ended.

Without `--json`, a timeout exits 124 with nothing on stdout. Pick the same
request back up with `ttym await --id <interaction>` instead of asking again —
a second prompt to the same agent abandons the first.

None of these mean the session died. Holders run detached, so the session
survives its server, let alone a dropped wait. Read `ttym screen <addr>` to see
where it actually got to, and continue from there.

## Cleaning up

```sh
ttym kill <addr>                              # end the session
ttym workspace remove --current <name>        # drop it from the workspace
```

Leave sessions running only if someone will look at them again. An abandoned
agent holds a PTY and its context forever.

## Talking to agents that are already there

When you run inside a pane (`$TTYM_SESSION_ID` is set), the other members of your
workspace are `:name`. `ttym guide agents` prints the current rules for asking
them, waiting in the background, and reading their turns — read it first; it
comes from the same binary you are about to run.

## Working with what is already there

```sh
ttym current --json                    # which session am I in
ttym workspace info --current --json   # everyone in this workspace, with state
ttym screen <addr>                     # what is that one doing
```

A Claude Code or Codex conversation that ran outside ttym (another terminal,
tmux) comes in with `ttym agent adopt <conversation-id>`: a new pane in its
folder, resumed. It refuses while that conversation is still running somewhere,
and names the pid — two copies of one conversation split its history.

Look before you spawn. The session you need may already exist, and a second
agent in the same repository will fight the first one over the same files.

## Orchestrating many sessions

When the user wants the picture across all their sessions — what is running,
what waits on them, what went stale — or wants decisions carried to the agents
doing the work, follow `references/orchestrate.md`. It reads state from the
server and the transcripts instead of asking each agent, and
`scripts/digest.py` does the first pass.
