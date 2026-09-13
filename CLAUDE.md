# ttym

웹 기반 터미널 멀티플렉서. 서버가 PTY 세션을 관리하고, workspace 단위로 여러 멤버(터미널/에이전트)를 묶어 협업·자동화한다.

## 구조

```
packages/cli/      CLI (@ttym/cli → esbuild 번들 dist/ttym. bin/ttym은 얇은 런처)
packages/server/   서버 (@ttym/server → dist/ttym-server.js)
packages/web/      브라우저 앱 (@ttym/web — 구 demo)
packages/desktop/  Tauri 앱 (@ttym/desktop — 구 native)
packages/ui/       React 터미널 컴포넌트 (@ttym/ui — 구 client). vt의 TerminalMux를 재export
packages/vt/       DOM·React 없는 클라이언트 코어 (@ttym/vt) — TerminalMux(WS·attach·
                   seq ACK·snapshot/delta replay·push 이벤트) · ansi · local-echo · panels
packages/protocol/ wire 포맷 (@ttym/protocol) — 서버·클라 공용 단일 구현
packages/api/      HTTP 클라이언트 (@ttym/api)
packages/shared/   도메인 규칙 — layout 트리 연산 (@ttym/shared)
holder/            Rust PTY holder (세션당 1개, detached, 서버 생존과 무관)
scripts/           빌드·hook·fixture 캡처 스크립트
docs/              architecture.md · adr-0001-membership.md (docs/local/은 비추적 산출물)
```

CLI 문법(콜론 주소가 유일한 문법): `ttym new <name>` · `ttym split <ws:name> <name>` ·
`ttym send|await|screen <ws:name|:name|#id>`. 자세한 것은 docs/architecture.md.

서버 기본 포트: 7690. PID/로그: `~/.ttym/`

## Workspace/Member CLI

### 컨텍스트 확인
```sh
ttym current --json                        # 내가 속한 project/workspace/member
ttym workspace info --current --json       # workspace 전체 멤버 + 상태
```

### Member 관리
```sh
# 추가 (zsh)
ttym workspace add --current --name runner --role executor --cmd /bin/zsh

# 추가 (Claude Code)
ttym workspace add --current --name claude-sub --role agent --cmd claude --dangerously-skip-permissions

# 제거 (세션 종료)
ttym workspace remove --current <member>

# 분리 (세션 유지, 멤버십만 해제)
ttym workspace detach --current <member>
```

### 명령 전송
```sh
# zsh에는 \n
ttym send :runner -- $'echo hello\n'

# Claude/Codex TUI에는 텍스트 + \r (두 번 나눠 보내기)
ttym send :claude-sub -- $'프롬프트 내용'
ttym send :claude-sub -- $'\r'
```

핵심: 인터랙티브 TUI(raw mode)는 Enter = CR(0x0d). 일반 쉘은 LF(0x0a).

send API(`POST /api/sessions/:id/send`)는 `Buffer.from(data)` — 이스케이프 해석 없이 문자열을 그대로 바이트로 전달. 따라서:
- CLI에서: `$'\r'` 또는 `$'\x0d'`로 실제 CR 바이트를 보내야 함
- Claude Code Bash tool 환경에서는 `$'...'` ANSI-C quoting이 안 될 수 있음. 이 경우 `printf '\r'` 파이프 등 우회 필요
- await 명령은 `\r` 자동 append 내장 (payload에 CR/LF 없으면 `\r` 추가)

### await (request-response, Claude 전용)

프롬프트 보내고 응답 완료까지 blocking 대기. `\r` 자동 append — 직접 붙일 필요 없음.

```sh
ttym await :claude-sub --json -- '질문'
ttym await :claude-sub --json --raw -- '질문'       # ANSI 원본
ttym await :claude-sub --timeout 60000 --json -- '질문'
```

동작 원리: meta.seq bump → send → Stop hook이 stopSeq 기록 → 폴링 감지 → screen 반환.
병렬 가능: 여러 멤버에 동시에 await 실행하면 각각 독립적으로 완료 감지.

**await는 Claude Code에서만 동작한다** — Stop hook 기반이므로. Codex 등 다른 에이전트는 send + screen 폴링 사용.

### 프로비저닝 속도

- **Codex**: add 응답 오면 즉시 ready. 부팅 대기 불필요.
- **Claude Code**: add 후 3~5초 부팅 필요 (welcome 화면 렌더링).
- **zsh**: 즉시 ready.

### 에이전트별 submit 차이

- **Claude Code**: `\r` (CR) — await가 자동 처리
- **Codex**: `\r` (CR) — 동일하지만 await(Stop hook) 미지원, send+screen 폴링 사용
- **zsh**: `\n` (LF)

Codex도 Stop hook을 지원한다 (v0.114.0+, `codex_hooks` feature flag 필요).
- `~/.codex/config.toml`의 `[features]`에 `codex_hooks = true` 추가
- `~/.codex/hooks.json`에 Stop 이벤트 등록 (`scripts/ttym-codex-stop-hook.sh`)
- await 명령은 Claude/Codex 모두 동작. Node.js 내부에서 CR 바이트를 직접 전송하므로 shell escaping 문제 없음.

## 뷰어 (`ttym open`)

pane 안에서 파일·URL을 연다. macOS `open` 대체 — 크롬 새 탭이 아니라 그 pane의 헤더 탭으로 붙는다.

```sh
ttym open report.html                    # 이 pane. 경로는 CLI cwd 기준
ttym open a.md b.csv --full              # 여러 개 = 탭 여러 개. --full은 workspace 전체 덮기
ttym open out.html --to :reviewer        # 다른 pane
ttym open dist/                          # 디렉터리. index.html 있으면 사이트로
ttym open --root dist dist/app/x.html    # 파일 탭의 권한을 dist/** 로 넓힘
ttym open http://localhost:9003          # URL은 iframe 그대로
ttym view list  [--to <addr>]
ttym view close (<target> | --id <vid> | --all)
```

- 같은 target을 다시 열면 새 탭이 아니라 그 탭 재로드(rev+1). 에이전트가 "다시 만들었다"를 같은 명령으로 말한다.
- renderer는 서버가 확장자로 정한다: html·pdf·url → iframe(sandbox), md → markdown, csv·tsv·jsonl → 표,
  json, 코드, 이미지, 디렉터리 목록.
- 파일 탭이 서빙하는 범위는 **그 파일 + 부모 폴더의 정적 자산(png/css/js/폰트…)뿐**. `.json`·`.env`·`.txt`는 403.
  넓히려면 디렉터리를 열거나 `--root`. 근거·구조는 docs/local/260904_viewer-plan.md.
- 상태: `~/.ttym/<runtime>/viewer.json` (server/src/viewer/). meta annotation이 아니다 — PATCH로 우회 못 하게.
  push는 CMD.VIEW(0x11), 전체 스냅샷. active 탭·pane/full·스크롤은 클라이언트(localStorage).
- 콘텐츠는 `/view/<cap>/…` (cap = 128bit 토큰, GET/HEAD, 읽기 전용 CORS). 제어는 `/api/sessions/:id/views`.

## 에이전트 절전 (agent sleep)

안 쓰는 pane의 Claude Code를 내리고(200~600MB/개), 입력이 오면 그 화면 그대로 되살린다. server/src/agent-sleep.ts.

```sh
ttym agent sleep <addr>        # 지금 재우기. Ctrl-C ×3 (transcript에 안 남음). 셸·PTY·세션은 그대로
ttym agent wake <addr>         # 지금 깨우기 (입력·send·await가 오면 자동으로 깨어난다)
ttym agent status              # 자는 pane 목록 + 돌려받은 RAM
```

- 자동: config `agent-sleep-after = 30m` (기본 off). 입력·출력이 그 시간 동안 없고 아래 "바쁨" 신호가 없을 때만.
  한 번에 3개, 3초 간격. pin 같은 수동 예외는 없다 — 에이전트가 스스로 말하는 것으로 판단한다.
- "바쁨" 판정(권위 순, server/src/agent-sleep.ts `whyBusy`):
  1. `~/.claude/sessions/<pid>.json`의 status — `waiting`(permission·대화상자, `waitingFor`에 이름)·`busy`
  2. `claudeTurnOpen` — 프롬프트로 열린 턴이 Stop 전
  3. `claudeInFlight` — Stop 훅 페이로드(2.1.269+)의 `background_tasks`·`session_crons`를 stop-hook이 그대로 전달.
     백그라운드 bash/agent/monitor, CronCreate·ScheduleWakeup·/loop 예약이 여기 있으면 안 재운다. 다음 Stop이 갱신.
  4. 프로세스 트리(구버전 폴백) — 에이전트 아래 `shell-snapshots` 셸·`caffeinate`
  durable cron(`.claude/scheduled_tasks.json`)은 resume 후 다시 로드되므로 막지 않는다.
- 자는 동안 뷰어는 마지막 화면에 **frozen** — ATTACH/SNAPSHOT/`ttym screen`이 그 화면을 준다. 셸 프롬프트는 안 보인다.
  화면은 `run/sleep-<id>.ansi`에 저장돼 서버 재시작 후에도 그대로.
- 깨우기: 입력은 큐(64KB·20초)에 담고 `ttym agent resume claude <원래 플래그>`를 셸에 친다. SessionStart 훅 +
  출력 500ms 정지 = 준비. 그때 스냅샷 한 장으로 갱신하고 큐를 순서대로 쓴다. 실측 1.7s. `ttym await`는 그대로 동작.
- 상태는 meta.agentSleep(runtime key, PATCH 불가). CMD.AGENT push에 `sleep`·`pin`. 웹: 헤더 ☾/◌/✕, 하단 알약.
- Codex도 같은 방식(실측 RSS 280~320MB). 차이: 프롬프트 훅이 없어 "턴 열림"은 최근 10초 출력으로 판단하고,
  SessionStart가 첫 턴에야 와서 깨우기는 프로세스 감지(1.5s + 출력 2s 정지)로 끝난다(실측 4초). resume에
  `-c check_for_update_on_startup=false`를 붙인다 — 업데이트 대화상자가 큐의 첫 키를 먹는다.
- `--cmd claude`로 셸 없이 띄운 pane은 아직(PTY가 끝난다).

## 작업 지도 (map)

메인 화면의 두 번째 모드(settings → main view → map). 세션별 AI 요약 + workspace 줄기 배치.

```sh
ttym map refresh                # stale 세션만 배치 요약 (claude -p haiku 기본)
ttym map refresh --force        # 전체 재요약
ttym map refresh --dry-run      # 프롬프트만 출력
```

- 백엔드 규칙 하나: config에 `map-base-url` 있으면 OpenAI 호환 HTTP, 없으면 `claude -p`.
  모델은 `map-model`. API 키는 `~/.ttym/map-api-key`(0600) 또는 `OPENAI_API_KEY` — config 금지(서빙됨).
- 데이터: 세션 요약은 meta.mapSummary(annotations), 배치는 workspace.map, 읽기는 `GET /api/map`.
- 신선도는 seq 기반 — 요약 후 출력이 흐르면 stale. 주기는 서버 내장: config `map-interval = 10m`(기본 off).

## Stop Hook (scripts/ttym-claude-stop-hook.sh)

Claude Code 응답 완료 시 발동. 두 가지 역할:
1. `claudeActive` 상태 클리어
2. `stopSeq`/`stopAt`을 meta에 기록 → await의 완료 신호

## Agent Bus (server/src/agent-*)

SQLite 기반 에이전트 메시징/작업큐. 현재 server.ts에서 **비활성**(null).

- `agent-types.ts` — AgentRecord, MessageEnvelope, TaskRecord
- `agent-bus.ts` — SQLite WAL + EventEmitter, heartbeat 90s stale
- `agent-api.ts` — REST + SSE 엔드포인트
- `agent-mcp.ts` — Claude Code MCP 어댑터 (10개 tool)
- `agent-file-bridge.ts` — 파일 기반 fallback (inbox/outbox)

활성화하면 SSE push로 폴링 없는 실시간 통보가 가능.

## Session 내부

- PTY 출력 → OutputRing (고정크기 버퍼, seq 기반 delta replay)
- WebSocket: CMD.DATA(입출력), CMD.SNAPSHOT(전체화면), CMD.ACK(수신확인)
- HTTP: POST `/api/sessions/:id/send`, GET `/api/sessions/:id/screen`
- Workspace 저장: 인메모리 Map + workspaces.json (atomic write + microtask debounce)
