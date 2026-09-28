/**
 * ttym guide <topic> — 이 바이너리 버전의 사용법을 출력한다.
 *
 * 에이전트에게 주는 지침을 스킬 파일이나 프로젝트 CLAUDE.md에 복사해 두면 CLI가 바뀔 때
 * 어긋난다. 여기 두면 지금 실행되는 바이너리와 같은 버전의 글이 나온다(Orca의 `skills get`과 같은 이유).
 */
const AGENTS = `# ttym: talking to other agents

You are in a ttym pane if $TTYM_SESSION_ID is set. Other panes in your workspace
are addressed as :name (same workspace), ws:name, or #id.

  ttym current --json                    who and where you are
  ttym workspace info --current --json   the members you can talk to, and their state

## Ask and wait (synchronous)

  ttym await :bob -- "question or task"

Sends the text as if typed into bob's input, then blocks until bob's turn ends
(Claude Code: Stop hook; also works while bob is asleep: it wakes bob first).
It returns what bob actually said: the last text message of that turn, read
from bob's transcript. Bob does not need to "reply" to you; bob answers normally.
Your address is prepended as "[ttym · from ws:you]" so bob knows it is you.

Under the answer you get two lines:

  ── turn int_xxx · 42s · tools 3 (Bash 2, Read 1) · edited 1: foo.ts
     more: ttym turn int_xxx   (--full: tool inputs/outputs)

The answer is bob's summary. Read the footer before trusting it: "no tools" means
bob only talked; edits without a test run may deserve a look. To see more:

  ttym turn int_xxx          every text bob wrote + one line per tool call
  ttym turn int_xxx --full   tool inputs and outputs (long outputs clipped)
  ttym turn int_xxx --path   the transcript JSONL, for grep

"edited" counts Edit/Write tool calls only; files written from Bash (cat > f,
sed -i, formatters) do not show up there, but they do in ttym turn.

Default timeout is 120000 ms (--timeout <ms>). A timeout does not cancel bob's
turn: await exits with code 124 and prints nothing on stdout. Keep waiting on
the same request with:

  ttym await --id int_xxx [--timeout <ms>]

## Hand off and keep working (background)

For anything longer than a quick question, run the await in the background with a
generous timeout, and do other work until it finishes:

  Claude Code: Bash tool with run_in_background: true
    ttym await :bob --timeout 1800000 -- "run the full test suite and fix failures"

You are notified when the command exits, with bob's answer as its output. While a
background task runs, ttym will not put you to sleep. Several awaits to different
members can run in parallel; each finishes on its own.

## Choosing how much to read

  quick fact / yes-no             the answer alone
  bob changed files or ran tests  answer + footer; ttym turn if the footer surprises you
  you must verify bob's work      ttym turn --full, or read the files yourself

## Pitfalls

- One request per member at a time: a second await to the same member abandons
  the first.
- await is for agents (Claude Code, Codex) and shells with shell integration: to
  such a shell it runs the text as a command and returns that command's output.
  A terminal with no turn-end signal (a bare REPL, vim, a shell without
  integration) only times out; drive it with ttym send and read ttym screen.
- ttym send writes raw bytes and does not wait. For a TUI, Enter is "\\r"
  (send text and "\\r" separately); for a shell, "\\n".
- --no-from drops the sender line; --bare drops the footer; --json gives
  { output, screen, reason, interaction: { id, status, summary, more } }.
  output is the answer only; screen is the live screen when there was none.
`;

const TOPICS: Record<string, string> = { agents: AGENTS };

export function cmdGuide() {
  const topic = process.argv[3];
  const text = topic ? TOPICS[topic] : undefined;
  if (!text) {
    console.log(`usage: ttym guide <topic>\ntopics: ${Object.keys(TOPICS).join(', ')}`);
    process.exit(topic ? 2 : 0);
  }
  process.stdout.write(text);
}
