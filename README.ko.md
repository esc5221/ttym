# ttym

> 🇬🇧 English: [README.md](README.md)

웹 기반 터미널 멀티플렉서. 하나의 서버가 PTY 세션을 소유하고, CLI·브라우저·데스크톱 앱 중 무엇으로 붙어도 동일한 세션을 조작·관찰한다. 서버를 재시작해도, 새 빌드로 교체해도 세션은 살아남는다. 같은 프로세스, 같은 화면 그대로다.

## 왜

- 에이전트(Claude Code, Codex 등)를 장시간 돌리면서 어디서든 붙었다 뗐다 하고 싶다.
- 여러 터미널을 `workspace` 단위로 묶어 `send` / `await` 로 스크립트 제어하고 싶다.
- 브라우저에서도 같은 세션을 그대로 보고 싶다.
- 서버를 업그레이드할 때 그 안에서 돌던 작업이 죽으면 안 된다.

## 아키텍처

### 프로세스 구성

```
         Clients (viewers)                     Server                  PTY backend
         ─────────────────                    ────────                ───────────────

         ttym attach        (Node TUI)       ┌──────────┐             ┌─ Holder #1 ─► zsh
                                             │          │         UDS │
         @ttym/web          (browser)   ───► │  server  │ ──────────► ├─ Holder #2 ─► claude
                                             │  (Node)  │  frame      │
         @ttym/desktop      (Tauri)          │          │  protocol   └─ Holder #N ─► codex
                                             └──────────┘
                                                  ▲                   Rust · ~1MB · 세션당 1개
         ttym new/split/send/await  ────────────┘                    서버가 죽어도 생존
         ttym start/stop/status       HTTP only
         (CLI control-plane)
```

핵심:

- **Server 가 유일한 허브.** Holder 와 직접 통신하는 건 Server 뿐이다.
- **Viewer 가 3종.** 셋 다 동일한 `HTTP + WebSocket` 프로토콜을 쓴다.
- **CLI 는 이중 역할.** `attach` 는 viewer 고, 나머지는 컨트롤 플레인이자 호환 경계다.
- **Holder 는 세션당 1프로세스.** 서버가 죽어도 PTY 와 ring buffer 가 그대로 살아 있다.

### 컴포넌트

```
Component        Lang         Role                                      Source
───────────────────────────────────────────────────────────────────────────────────────
@ttym/cli        Node ESM     서버 수명 · attach TUI ·                  packages/cli
                              new/split/send/await 컨트롤 플레인
@ttym/server     TS → Node    HTTP + WS 허브, xterm headless 미러,       packages/server
                              OutputRing(seq 기반 delta), Workspace
                              store, interaction, Agent hook API
holder           Rust         PTY fd + ring buffer. 영속성 담당.         holder/src
@ttym/protocol   TS           WS wire 포맷 — 서버·클라 같은 구현          packages/protocol
@ttym/api        TS           HTTP 클라이언트 — 앱 3종이 공유             packages/api
@ttym/ui         React/TS     xterm.js 래퍼 + mux 컴포넌트               packages/ui
@ttym/web        React/Vite   브라우저 viewer                           packages/web
@ttym/desktop    Tauri        데스크톱 viewer                           packages/desktop
@ttym/shared     TS           layout 트리 등 도메인 규칙                 packages/shared
```

### 데이터 플로우 (한 세션 기준)

```
입력 (keystroke):
  viewer → CMD.DATA(sessionId, bytes) → WS → server → unix socket → holder → PTY

출력 (PTY byte):
  PTY → holder ring → unix socket → server.OutputRing.append(seq)
                                      ├─► 모든 attached viewer 에 CMD.DATA(seq) 전송
                                      └─► headless xterm 미러 갱신 (ATTACH 시 SNAPSHOT 용)
  viewer → 화면 렌더 → CMD.ACK(seq) 회신

신규 attach:
  viewer → CMD.ATTACH{ fromSeq, cols, rows, mode }
  server → CMD.SNAPSHOT(전체 화면) → 이후 CMD.DATA delta 만

서버 재시작:
  server → 세션별 체크포인트(렌더된 ANSI + offset) 를 xterm 에 seed
         → holder 에 DUMP_SINCE(offset) → 그 이후 delta 만 REPLAY
```

## 설치

전제: Node.js, Rust, pnpm.

```bash
pnpm install
./scripts/build.sh
```

빌드 산출물:

```
dist/
├── ttym              # CLI (esbuild 번들)
├── ttym-server.js    # 번들된 서버 + web 정적 리소스
└── ttym-holder       # Rust 바이너리
```

## 빠른 시작

```bash
./dist/ttym start                       # 서버 백그라운드 실행 (port 7690)

./dist/ttym new claude -- claude        # 세션 생성, default workspace 에 이름 등록
./dist/ttym split :claude logs          # 옆에 분할 — 중첩과 비율이 유지된다
./dist/ttym attach default/claude       # TUI 로 붙기 (C-b d 로 빠져나옴)

# 브라우저로도 같은 서버에 접속:
open http://localhost:7690
```

## CLI 레퍼런스

### 주소 체계

```
ws:name     workspace "ws" 의 멤버 "name"
:name       현재 workspace 의 멤버 (TTYM_SESSION_ID 로 추론)
#42         세션 id 직접 지정 — workspace 미소속 세션도 이걸로 항상 접근 가능
```

CLI 는 시작 시 `/api/version` 으로 서버와 `API_VERSION` 을 맞춰보고, 불일치면 exit 1 로 멈춘다.

### 세션 만들기 / 조작

```bash
ttym new <name> [-- <cmd...>]              # 기본 cmd: $SHELL
ttym split <ws:name|:name> <new> [-- cmd]  # 대상 옆에 분할 배치
ttym send <ws:name|:name|#id> -- "data"    # raw 바이트 전송
ttym screen <ws:name|:name|#id> [--json]   # 현재 화면 읽기
ttym await <ws:name|:name|#id> [--timeout ms] -- "prompt"
                                           # 에이전트에 묻고 이번 턴의 답만 받기
```

### 서버 수명

```bash
ttym start [--port 7690]   # 백그라운드 실행. PID: ~/.ttym/ttym.pid
ttym stop                  # 서버 종료. Holder 는 살아남음
ttym restart               # 재시작 → 세션 자동 복구. launchd 가 먼저 살리면 양보
ttym status                # 서버 + 세션 목록
ttym log [-f]              # ~/.ttym/ttym.log
```

### attach — 인터랙티브 TUI

```bash
ttym attach <session-id>
ttym attach <workspace>/<member>
ttym attach <ws>/<member> --new --cmd claude --dangerously-skip-permissions
ttym attach <target> --readonly          # 입력 차단, 관찰만
ttym attach <target> --prefix C-a        # prefix 키 변경 (기본 C-b)
```

키바인딩 (prefix = `C-b` 기본):

```
C-b d         detach (세션은 살려둠)
C-b s         session picker
C-b n / p     next / previous workspace member
C-b ?         help
C-b C-b       prefix 리터럴을 PTY 로 전달
C-]           대안 detach
```

### workspace 컨트롤 플레인

```bash
ttym current [--json]                       # 현재 세션의 project/workspace/member
ttym project list [--json]
ttym workspace list [project] [--json]
ttym workspace info <ws|--current> [--json]
ttym workspace create <project> --name <name>
ttym workspace rename <ws|--current> --name <new>
ttym workspace delete <ws|--current>

ttym workspace add <ws|--current> --name <m> [--role <r>] [--cmd <cmd...>]
ttym workspace member rename <ws|--current> <m> --name <new>

ttym workspace detach    <ws|--current> <m>   # 멤버십만 해제, 세션 유지
ttym workspace remove    <ws|--current> <m>   # 멤버십 해제 + 세션 종료
ttym workspace send/screen/await ...          # 구 문법 — 콜론 주소와 공존
```

`--current` 는 세션 내부에서 자동 주입되는 `TTYM_SESSION_ID` 로 현재 workspace 를 찾는다.

### meta — 세션 KV

```bash
ttym meta <session-id>                           # 병합 뷰 (runtime + annotations)
ttym meta <id> --set name=worker                 # 사용자 KV → annotations 로 라우팅
ttym meta <id> --claude-session <uuid>           # Claude 세션 연결
ttym meta <id> --codex-session <uuid>
```

meta 는 소유권이 갈려 있다: `claude*`/`codex*`/`stopSeq` 등 런타임 키는 서버 소유라 공개 PATCH 가 400 으로 거절되고, hook 전용 내부 API 로만 쓰인다. 나머지는 전부 사용자 소유(annotations). 분류 규칙은 `@ttym/protocol` 에 있다.

### agent — 에이전트 훅 설치

```bash
ttym agent install claude       # ~/.claude/settings.json 에 SessionStart+Stop hook 주입
ttym agent install codex        # ~/.codex/hooks.json (codex_hooks v0.114+ 플래그 필요)
ttym agent uninstall <agent>
ttym agent status
ttym agent info [session-id]    # 세션에 연결된 claude/codex 세션 ID
ttym agent resume [agent]       # 연결된 세션으로 claude --resume / codex resume
```

## HTTP API

모든 응답은 JSON. 기본 `http://localhost:7690`.

```
GET    /api/version                         API_VERSION — 클라이언트 호환성 확인
GET    /api/sessions                        세션 목록
POST   /api/sessions                        세션 생성 {cmd, cols, rows, cwd?}
GET    /api/sessions/:id                    단일 세션 정보
DELETE /api/sessions/:id                    세션 종료 (Holder kill)
POST   /api/sessions/:id/send               {data} → PTY 에 raw 바이트
GET    /api/sessions/:id/screen             현재 화면 덤프
POST   /api/sessions/:id/resize             {cols, rows}
POST   /api/sessions/:id/interactions       {prompt, timeoutMs?} → 답 완료까지 blocking
GET    /api/sessions/:id/interactions/:iid  202 로 넘긴 interaction 이어받기
GET    /api/sessions/:id/runtime            서버 소유 상태의 조립 뷰 (terminal·process·agent)
GET|PATCH /api/sessions/:id/annotations     사용자 소유 KV
GET|PATCH /api/sessions/:id/meta            병합 뷰 — 호환 어댑터. 런타임 키 PATCH 는 400
POST   /api/internal/sessions/:id/stop      에이전트 Stop hook 전용
POST   /api/internal/sessions/:id/agent     hook 의 런타임 키 쓰기 전용

GET    /api/projects                        프로젝트 집계
GET    /api/workspaces[?project=<p>]        워크스페이스 목록
POST   /api/workspaces                      워크스페이스 생성
GET|PATCH|DELETE /api/workspaces/:id
POST   /api/workspaces/:id/members          멤버 추가 {sessionId, name, role?, tags?}
PATCH|DELETE /api/workspaces/:id/members/:sid
POST   /api/workspaces/:id/split            layout 조작
```

## WebSocket 프레임 프로토콜

엔드포인트 `ws://localhost:7690/ws`. 바이너리 프레임.

```
기본 헤더 (3B):        uint16 LE sessionId | uint8 cmd
DATA 헤더 (7B, 서버→클라만):  + uint32 LE seq
페이로드:              cmd 에 따라 binary 또는 UTF-8 JSON
```

**DATA 프레임은 방향에 따라 모양이 다르다.** 서버→클라 출력에는 재생/ACK 용 `seq` 가 붙고, 클라→서버 입력은 키 바이트 그대로다. 디코더도 `decodeServerFrame` / `decodeClientFrame` 으로 나뉜다. 하나의 대칭 decode 로 합치면 서버가 입력 앞 4바이트를 seq 로 먹는다. 실제로 그렇게 합쳤다가 한글 IME 커밋(음절+공백 = 7바이트)이 통째로 사라지는 회귀를 냈고, 지금은 실제 PTY 를 구동하는 회귀 테스트가 그 시나리오를 고정하고 있다.

CMD 코드:

```
0x00 DATA         PTY ↔ viewer 바이트 스트림 (출력에만 seq)
0x01 RESIZE       {cols, rows}
0x03 DESTROY      세션 종료 알림
0x04 PAUSE        세션 출력 일시중단
0x05 RESUME
0x06 HELLO        {clientId}
0x08 ATTACH       {fromSeq, cols, rows, mode}
0x09 DETACH
0x0a SNAPSHOT     전체 화면 UTF-8 (ATTACH 응답)
0x0b ACK          {seq} — viewer 가 DATA 수신 확인
0x0c PAUSE_VIEW   (viewer 측 일시중단)
0x0d RESUME_VIEW
```

## 세션 영속성

Holder 가 별도 프로세스라서 서버가 죽어도 PTY 는 살아 있다.

```bash
ttym start
ttym new work
ttym restart                  # 서버는 내려갔다 올라오지만
ttym status                   # 세션은 그대로, 같은 pid, attach 하면 이어서 씀
```

복구가 세 겹이다:

- **체크포인트.** 서버는 세션마다 렌더된 ANSI 스냅샷을 주기적으로 디스크에 쓴다 (idle 2초 / 최대 30초, 적용 offset·holder generation·행별 wrap bit 포함). 재시작하면 체크포인트를 xterm 에 seed 하고 holder 에는 그 offset 이후 delta 만 요청한다. ring 밖이면 holder 가 `gap` 으로 답하고, 서버는 이를 정상 복구로 위장하지 않는다.
- **controller lease.** holder 는 controller 를 하나만 받는다. 새 서버는 `ACQUIRE` 로 명시적으로 얻어야 하고, 이미 점유돼 있으면 거절된다. 이 프레임이 생기기 전엔 서버 두 개가 경쟁하면 새 접속이 기존 서버를 조용히 축출했고, 그게 세션을 잃는 경로였다.
- **소켓 자가복구.** holder 는 5초마다 자기 소켓 경로를 확인하고, 지워졌으면 재bind 후 manifest 를 다시 쓴다. 살아있는 PTY 가 고아가 되는 걸 막는다.

부팅 복구는 workspace 가 참조하는 세션만 되살리고, 참조가 끊긴 snapshot/meta 는 14일 유예 후 GC 된다 (`TTYM_GC_DAYS`, 0=off).

## Agent 통합

### 훅이 하는 일

- **SessionStart**: Claude/Codex 가 실행되면 그 세션 ID 를 `TTYM_SESSION_ID` 로 지정된 ttym 세션에 기록 (`claudeSessionId` / `codexSessionId`).
- **Stop**: 에이전트 응답 완료 시점을 서버에 통보 (`POST /api/internal/sessions/:id/stop`). StopFailure·SessionEnd 도 등록돼 있어 실패한 턴은 timeout 이 아니라 즉시 정리된다.

```
scripts/ttym-claude-hook.sh           Claude SessionStart
scripts/ttym-claude-stop-hook.sh      Claude Stop
scripts/ttym-codex-stop-hook.sh       Codex Stop
```

### await 동작 원리

`ttym await` 은 화면 덤프가 아니라 이번 턴의 transcript 를 돌려준다. 서버가 xterm marker 로 제출 시점의 버퍼 위치를 잡고 프롬프트+CR 을 보낸 뒤, Stop hook 이 오면 marker 부터 커서까지의 렌더된 행을 추출한다. marker 가 스크롤아웃되면 엉뚱한 구간 대신 null 을 준다. 타임아웃이면 202 + Location 으로 넘어가고 id 로 이어받는다.

여러 멤버에 동시에 `await` 를 걸면 각각 독립적으로 끝난다.

## 개발

```bash
pnpm test                     # vitest — 실제 holder spawn, 실제 PTY, 프로덕션 fixture 재생
pnpm test:e2e                 # Playwright
pnpm --dir packages/server dev
pnpm --dir packages/web dev   # 브라우저 앱 (Vite, 별도 포트)
pnpm desktop:dev              # Tauri 앱
```

pnpm 워크스페이스 멤버: `packages/*` 8개 + Rust `holder/`.

## 환경변수

```
PORT                   서버 포트 (기본 7690)
TTYM_HOME              ~/.ttym 루트 교체 (테스트 격리용)
TTYM_RUNTIME_DIR       Holder 소켓/매니페스트 디렉토리 (기본 ~/.ttym/run)
TTYM_HOLDER_BIN        Holder 바이너리 경로 (기본: dist/ 자동탐색)
TTYM_GC_DAYS           미참조 snapshot/meta 유예 일수 (기본 14, 0=off)
TTYM_SESSION_ID        ttym 세션 내부에서 자동 주입 (attach/hook 이 사용)
TTYM_PREFIX            attach TUI 의 prefix 키 (기본 C-b)
TTYM_HTTP_TIMEOUT_MS   CLI HTTP 요청 타임아웃 (기본 5000)
TTYM_ATTACH_RETRY_MS   attach 재접속 간격 (기본 1000)
```

## 런타임 경로

```
~/.ttym/
├── ttym.pid              서버 PID
├── ttym.log              서버 stdout/stderr (64MB 초과 시 copy-truncate → .1)
└── run/
    ├── workspaces.json       워크스페이스 + 멤버 (원자적 쓰기)
    ├── session-<id>.json     Holder manifest
    ├── session-<id>.sock     Holder Unix 소켓
    ├── snapshot-<id>.json    체크포인트 (렌더된 ANSI + offset)
    ├── meta-<id>.json        세션 meta
    └── next-id               세션 id 카운터
```

## 문서

- [docs/architecture.md](docs/architecture.md) — 계층, holder 계약, 복구, interaction
- [docs/adr-0001-membership.md](docs/adr-0001-membership.md) — 세션 소속 모델 결정 기록
