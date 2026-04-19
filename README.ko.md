# ttym

> 🇬🇧 English: [README.md](README.md)

웹 기반 터미널 멀티플렉서. 하나의 서버가 PTY 세션을 소유하고, CLI·브라우저·데스크톱 앱 중 무엇으로 붙어도 동일한 세션을 조작·관찰한다. 서버를 재시작해도 세션은 살아남는다.

## 왜

- 에이전트(Claude Code, Codex 등)를 장시간 돌리면서 어디서든 붙었다 뗐다 하고 싶다.
- 여러 터미널을 `workspace / member` 단위로 묶어 `send` / `await` 로 스크립트 제어하고 싶다.
- 브라우저에서도 같은 세션을 그대로 보고 싶다.

## 아키텍처

### 프로세스 구성

```
         Clients (viewers)                     Server                  PTY backend
         ─────────────────                    ────────                ───────────────

         ttym attach        (Node TUI)       ┌──────────┐             ┌─ Holder #1 ─► zsh
                                             │          │         UDS │
         @ttym/demo         (browser)   ───► │  server  │ ──────────► ├─ Holder #2 ─► claude
                                             │  (Node)  │  frame      │
         @ttym/native       (Tauri)          │          │  protocol   └─ Holder #N ─► codex
                                             └──────────┘
                                                  ▲                   Rust · ~1MB · 세션당 1개
         ttym workspace/meta/agent  ──────────────┘                   서버가 죽어도 생존
         ttym start/stop/status       HTTP only
         (CLI control-plane)
```

핵심:

- **Server 가 유일한 허브.** Holder 와 직접 통신하는 건 Server 뿐이다.
- **Viewer 가 3종.** 셋 다 동일한 `HTTP + WebSocket` 프로토콜을 쓴다.
- **CLI 는 이중 역할.** `attach` 는 viewer 고, `workspace/meta/agent/start/stop` 은 컨트롤 플레인.
- **Holder 는 세션당 1프로세스.** 서버가 죽어도 PTY 와 ring buffer 가 그대로 살아 있다.

### 컴포넌트

```
Component       Lang         Role                                      Source
──────────────────────────────────────────────────────────────────────────────
ttym (CLI)      Node ESM     서버 수명 · attach TUI ·                 bin/ttym
                             workspace/agent 컨트롤 플레인
server          TS → Node    HTTP + WS 허브, xterm headless 미러,      server/src
                             OutputRing(seq 기반 delta), Workspace
                             store, Agent hook API
holder          Rust         PTY fd + ring buffer. 영속성 담당.        holder/src
@ttym/client    React/TS     xterm.js 래퍼 + mux 프로토콜              client/src
@ttym/demo      React/Vite   브라우저 viewer                           demo/
@ttym/native    Tauri        데스크톱 viewer                           native/
shared          TS           workspace 도메인 로직                     shared/src
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
├── ttym              # CLI (ESM)
├── ttym-server.js    # 번들된 서버 + demo 정적 리소스
└── ttym-holder       # Rust 바이너리
```

## 빠른 시작

```bash
./dist/ttym start                                  # 서버 백그라운드 실행 (port 7690)

./dist/ttym workspace create demo --name onboard   # project=demo, workspace=onboard
./dist/ttym workspace add demo/onboard --name sh --cmd /bin/zsh
./dist/ttym attach demo/onboard/sh                 # TUI 로 붙기 (C-] 로 빠져나옴)

# 브라우저로도 같은 서버에 접속:
open http://localhost:7690
```

## CLI 레퍼런스

### 서버 수명

```bash
ttym start [--port 7690]   # 백그라운드 실행. PID: ~/.ttym/ttym.pid
ttym stop                  # 서버 종료. Holder 는 살아남음
ttym restart               # 재시작 → 세션 자동 복구
ttym status                # 서버 + 세션 목록
ttym log [-f]              # ~/.ttym/ttym.log
```

### attach — 인터랙티브 TUI

```bash
ttym attach <session-id>                 # 생 세션 ID
ttym attach <workspace>/<member>         # 워크스페이스명 유니크할 때
ttym attach <project>/<workspace>/<member>
ttym attach <ws>/<member> --new --cmd claude --dangerously-skip-permissions
                                         # 멤버가 없으면 온디맨드 생성
ttym attach <target> --readonly          # 입력 차단, 관찰만
ttym attach <target> --prefix C-a        # prefix 키 변경 (기본 C-b)
```

키바인딩 (prefix = `C-b` 기본):

```
C-b d         detach (세션은 살려둠)
C-b s         session picker (j/k 이동, Enter 선택, Esc 취소)
C-b n         next workspace member
C-b p         previous workspace member
C-b ?         help
C-b C-b       prefix 리터럴을 PTY 로 전달
C-]           대안 detach
```

환경변수: `TTYM_PREFIX=C-a` 로 기본 prefix 변경 가능.

### workspace / member 컨트롤 플레인

```bash
ttym current [--json]                                    # 현재 세션의 project/workspace/member
ttym project list [--json]
ttym workspace list [project] [--json]
ttym workspace info <ws|--current> [--json]
ttym workspace create <project> --name <name>
ttym workspace rename <ws|--current> --name <new>
ttym workspace delete <ws|--current>

ttym workspace add <ws|--current> --name <m> [--role <r>] [--cmd <cmd...>]
ttym workspace member rename <ws|--current> <m> --name <new>

ttym workspace detach    <ws|--current> <m>    # 멤버십만 해제, 세션 유지
ttym workspace remove    <ws|--current> <m>    # 멤버십 해제 + 세션 종료
ttym workspace terminate <ws|--current> <m>    # remove 의 별칭
```

`--current` 는 `TTYM_SESSION_ID` (세션 내부에서 자동 주입) 로 현재 workspace 를 찾는다. 즉 ttym 세션 안에서 실행하면 주소를 생략할 수 있다.

### 자동화 — send / screen / await

```bash
# 키 입력 전송 (이스케이프 없이 raw 바이트로 전달됨)
ttym workspace send --current runner -- $'echo hello\n'
ttym workspace send --current claude-sub -- '프롬프트 본문'
ttym workspace send --current claude-sub -- $'\r'         # Enter 를 별도로

# 현재 화면 읽기
ttym workspace screen --current claude-sub [--json]

# request-response blocking (Claude/Codex 전용)
ttym workspace await --current claude-sub --json -- '질문'
ttym workspace await --current claude-sub --raw --timeout 60000 -- '질문'
```

**CR vs LF 주의.** `send` 는 문자열을 `Buffer.from(data)` 로 그대로 전달한다.

- zsh / bash: 개행 = `\n` (LF)
- Claude Code / Codex TUI: raw mode 라 Enter = `\r` (CR)
- `await` 는 `\r` 을 자동으로 덧붙인다

**await 동작 원리.** meta.seq 를 bump → payload+CR 송신 → 에이전트의 Stop hook 이 `meta.stopSeq` 를 기록 → CLI 가 폴링하며 `seq == stopSeq` 를 감지하면 screen 을 반환. 즉 에이전트 훅이 설치돼 있어야 동작한다 (아래 agent 섹션).

### meta — 세션 KV

```bash
ttym meta <session-id>                           # 전체 메타 조회
ttym meta <id> --set name=worker --set role=exec # 임의 key=value
ttym meta <id> --claude-session <uuid>           # Claude 세션 연결
ttym meta <id> --clear-claude-session
ttym meta <id> --codex-session <uuid>            # Codex 동일
```

workspace membership, claude/codex session id, `stopSeq`, 사용자 지정 KV 가 여기 저장된다.

### agent — 에이전트 훅 설치

```bash
ttym agent install claude       # ~/.claude/settings.json 에 SessionStart+Stop hook 주입
ttym agent install codex        # ~/.codex/hooks.json 에 동일 (codex_hooks v0.114+ 플래그 필요)
ttym agent uninstall <agent>
ttym agent status               # 설치 상태

ttym agent info [session-id]    # 세션에 연결된 claude/codex 세션 ID
ttym agent resume [agent]       # 연결된 세션으로 claude --resume / codex resume 실행
```

훅이 하는 일은 [Agent 통합](#agent-통합) 섹션 참조.

## HTTP API

모든 응답은 JSON. 기본 `http://localhost:7690`.

```
GET    /api/sessions                        세션 목록
POST   /api/sessions                        세션 생성 {cmd, cols, rows, cwd?, verify?}
GET    /api/sessions/:id                    단일 세션 정보
DELETE /api/sessions/:id                    세션 종료 (Holder kill)
POST   /api/sessions/:id/send               {data: string} → PTY 에 raw 바이트
GET    /api/sessions/:id/screen             현재 화면 덤프
POST   /api/sessions/:id/resize             {cols, rows}
GET    /api/sessions/:id/meta               KV 조회
PATCH  /api/sessions/:id/meta               KV merge

GET    /api/projects                        프로젝트 집계
GET    /api/workspaces[?project=<p>]        워크스페이스 목록
POST   /api/workspaces                      워크스페이스 생성
GET    /api/workspaces/:id                  단일 워크스페이스
PATCH  /api/workspaces/:id                  rename 등
DELETE /api/workspaces/:id                  삭제
POST   /api/workspaces/:id/members          멤버 추가 {sessionId, name, role?, tags?}
PATCH  /api/workspaces/:id/members/:sid     멤버 수정
DELETE /api/workspaces/:id/members/:sid     멤버 제거
POST   /api/workspaces/:id/split            layout 조작
```

## WebSocket 프레임 프로토콜

엔드포인트 `ws://localhost:7690/ws`. 바이너리 프레임.

```
기본 헤더 (3B):   uint16 LE sessionId | uint8 cmd
DATA 헤더 (7B):   + uint32 LE seq
페이로드:         cmd 에 따라 binary 또는 UTF-8 JSON
```

CMD 코드:

```
0x00 DATA         PTY ↔ viewer 바이트 스트림 (출력엔 seq 포함)
0x01 RESIZE       {cols, rows} 2×uint16
0x02 CREATE       (미사용, HTTP 로 대체)
0x03 DESTROY      세션 종료 알림
0x04 PAUSE        세션 출력 일시중단
0x05 RESUME
0x06 HELLO        {clientId}
0x07 LIST         (미사용)
0x08 ATTACH       {fromSeq, cols, rows, mode}
0x09 DETACH
0x0a SNAPSHOT     전체 화면 UTF-8 (ATTACH 응답)
0x0b ACK          {seq} — viewer 가 DATA 수신 확인
0x0c PAUSE_VIEW   (viewer 측 일시중단)
0x0d RESUME_VIEW
```

전형적인 세션 플로우:

```
viewer → HELLO {clientId}
viewer → ATTACH {sessionId, fromSeq=0, cols, rows, mode}
server → ATTACH {ok:true, lastSeq}
server → SNAPSHOT (전체 화면)
server → DATA(seq=1), DATA(seq=2), ...
viewer → ACK(seq) ...
viewer → DATA(keystroke)
viewer → DETACH   또는 소켓 종료
```

## 세션 영속성

Holder 가 별도 프로세스라서 서버가 죽어도 PTY 는 살아 있다.

```bash
ttym start
curl -X POST .../api/sessions -d '{"cmd":["zsh"],"cols":120,"rows":40}'
ttym restart                  # 서버는 내려갔다 올라오지만
ttym status                   # 세션은 그대로 보이고, attach 하면 이어서 씀
```

복구 과정: 서버가 재시작하면 `~/.ttym/run/sockets/*` 의 Holder 소켓을 스캔하고, 각 Holder 에 재연결한 뒤 `workspaces.json` 과 맞춰서 워크스페이스를 복원한다.

## Agent 통합

### 훅이 하는 일

- **SessionStart**: Claude/Codex 가 실행되면 그 세션 ID 를 `TTYM_SESSION_ID` 로 지정된 ttym 세션 meta 에 기록 (`claudeSessionId` / `codexSessionId`).
- **Stop**: 에이전트 응답 완료 시점에 `claudeActive=false` 와 `stopSeq=<bumped seq>` 를 meta 에 기록 → `ttym workspace await` 가 이걸 폴링해서 "응답 끝남" 을 감지.

스크립트 실체:

```
scripts/ttym-claude-hook.sh           Claude SessionStart
scripts/ttym-claude-stop-hook.sh      Claude Stop
scripts/ttym-codex-stop-hook.sh       Codex Stop
```

### 설치 예

```bash
ttym agent install claude
# → ~/.claude/settings.json 에 hooks 블록 주입
#    기존 설정은 .bak 로 백업

ttym agent install codex
# → ~/.codex/hooks.json 에 hooks 블록 주입
#    전제: ~/.codex/config.toml 에 [features] codex_hooks=true
```

### 동시 실행

여러 멤버에 동시에 `await` 를 걸면 각 멤버의 Stop hook 이 독립적으로 트리거되므로 병렬로 끝난다.

## 개발

```bash
pnpm -F @ttym/server dev      # 서버 핫리로드
pnpm -F @ttym/demo   dev      # 브라우저 데모 (Vite, 별도 포트)
pnpm test                     # vitest 단위 테스트
pnpm test:e2e                 # Playwright

./scripts/pilot-project-workspace-member.sh   # 컨트롤 플레인 스모크 테스트
```

pnpm 워크스페이스 멤버: `server`, `client`, `demo`, `native`. `shared/` 는 TS 소스로 직접 임포트.

## 환경변수

```
PORT                   서버 포트 (기본 7690)
TTYM_RUNTIME_DIR       Holder 소켓/매니페스트 디렉토리 (기본 ~/.ttym/run)
TTYM_HOLDER_BIN        Holder 바이너리 경로 (기본: dist/ 자동탐색)
TTYM_SESSION_ID        ttym 세션 내부에서 자동 주입 (attach/hook 이 사용)
TTYM_PREFIX            attach TUI 의 prefix 키 (기본 C-b)
TTYM_HTTP_TIMEOUT_MS   CLI HTTP 요청 타임아웃 (기본 5000)
TTYM_ATTACH_RETRY_MS   attach 재접속 간격 (기본 1000)
```

## 런타임 경로

```
~/.ttym/
├── ttym.pid           서버 PID
├── ttym.log           서버 stdout/stderr
└── run/
    ├── workspaces.json     워크스페이스 + 멤버 (원자적 쓰기)
    ├── sessions.json       세션 메타 스냅샷
    └── sockets/<id>.sock   Holder Unix 소켓 (세션당 1개)
```
