---
name: ttym
description: Run other coding agents as persistent terminal sessions and delegate work to them. Use when a task wants a second agent working in parallel, a long job that must survive this conversation, work in a different directory or git worktree, or when you need to read or drive a session someone else started. Triggers — "ttym", "spawn an agent", "have codex do it", "run it in parallel", "in another session", "background agent", "delegate this", "hand it off", "worktree agent". Not for running a command and reading its output; that is a plain shell call.
---

# ttym

ttym keeps PTY sessions alive on a server. A session outlives the client that
made it, the server that hosts it, and this conversation. That is the whole
reason to reach for it: work you start here keeps running after you stop
watching.

Sessions are addressed with a colon: `ws:name`, `:name` inside your own
workspace, or `#id`. `ttym --help` has the grammar. This file has the judgement
calls it cannot make for you.

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
claude   ready in 3-5s   ttym await works    no cwd flag of its own → --cwd is the only way
codex    ready at once   ttym await works    has -C, but --cwd is clearer
zsh      ready at once   no await            drive with send, poll with screen
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

For anything long, run the `await` in the background and keep working. You will
be told when it lands.

## Reading the result

`await` returns the agent's answer. Then verify it yourself — run the tests,
read the diff. An agent reporting success is a claim, not evidence.

`ttym screen <addr>` shows the current screen with control characters stripped.
Add `--raw` only when you actually need the escape sequences.

## When await comes back empty

With `--json`, `reason` says what happened:

```
done      finished; output is the answer
timeout   still running — the session is fine, you stopped waiting
failed    the turn ended without an answer
```

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

## Working with what is already there

```sh
ttym current --json                    # which session am I in
ttym workspace info --current --json   # everyone in this workspace, with state
ttym screen <addr>                     # what is that one doing
```

Look before you spawn. The session you need may already exist, and a second
agent in the same repository will fight the first one over the same files.
