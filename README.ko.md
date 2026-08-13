# ttym

> 🇬🇧 English: [README.md](README.md)

웹 기반 터미널 멀티플렉서. 하나의 서버가 PTY 세션을 소유하고, CLI·브라우저·데스크톱 앱 중 무엇으로 붙어도 동일한 세션을 조작·관찰한다. 서버를 재시작해도, 새 빌드로 교체해도 세션은 살아남는다. 같은 프로세스, 같은 화면 그대로다.

## 왜

- 에이전트(Claude Code, Codex 등)를 장시간 돌리면서 어디서든 붙었다 뗐다 하고 싶다.
- 여러 터미널을 `workspace` 단위로 묶어 `send` / `await` 로 스크립트 제어하고 싶다.
- 브라우저에서도 같은 세션을 그대로 보고 싶다.
- 모든 세션이 지금 뭘 하고 있는지, AI가 갱신하는 지도로 한눈에 보고 싶다.
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
@ttym/cli        TS → Node    서버 수명 · attach TUI ·                  packages/cli
                              new/split/send/await/map 컨트롤 플레인
@ttym/server     TS → Node    HTTP + WS 허브, xterm headless 미러,       packages/server
                              OutputRing(seq 기반 delta), workspace
                              store, 명령 인덱스, interaction
holder           Rust         PTY fd + ring buffer. 영속성 담당.         holder/src
@ttym/vt         TS           프레임워크 무관 클라이언트 코어: WS mux,     packages/vt
                              local echo, ANSI 유틸, 패널 상태
@ttym/protocol   TS           WS wire 포맷 — 서버·클라 같은 구현          packages/protocol
@ttym/api        TS           HTTP 클라이언트 — 앱 3종이 공유             packages/api
@ttym/ui         React/TS     xterm.js 터미널 호스트 + 레이아웃 뷰        packages/ui
@ttym/web        React/Vite   브라우저 앱                               packages/web
@ttym/desktop    Tauri        서빙되는 웹 앱을 감싸는 데스크톱 셸          packages/desktop
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

## 에이전트를 함수처럼

훅을 한 번 깔면 에이전트 세션이 호출 가능한 함수가 된다:

```bash
ttym agent install claude     # ~/.claude/settings.json 에 SessionStart/Stop 훅 주입
ttym workspace add --current --name helper --role agent --cmd claude
ttym await :helper --json -- "이 스택트레이스 원인 뭐야?"
```

`await` 는 화면 폴링이 아니라 Stop 훅을 신호로 에이전트의 턴이 실제로 끝날 때까지 기다리고, **그 턴의 답변만** 돌려준다 — 가능하면 에이전트의 구조화된 transcript 에서 추출하고(`transcriptSource: "structured"`), 아니면 렌더된 화면에서 잘라낸다. 여러 멤버에 동시에 걸어도 각자 독립적으로 완료된다. `ttym agent resume` 은 연결된 Claude/Codex 세션을 나중에 다시 열고, `ttym agent info` 는 연결 관계를 보여준다.

## 셸 통합

`~/.zshrc` 에 한 줄 (ttym pane 밖에서는 아무 일도 안 한다):

```bash
[[ -n "$TTYM_SESSION_ID" ]] && source /path/to/ttym/scripts/ttym-shell-integration.zsh
```

그러면 셸이 자기 출력 스트림에 명령 경계를 표시하고(OSC 133/633), 서버가 그걸 인덱싱해서, 평범한 셸이 스크립트 가능해진다:

```bash
ttym commands :build          # 장부: ✓/✗ + exit code, 소요시간, 명령줄
ttym output :build --cmd 3    # 그 명령의 출력만 정확히 — 프롬프트 긁기 없음
ttym await :build -- "make test"   # 보내고, 완료까지 막고, exit code + 출력 받기
```

`await` 는 증거로 라우팅한다: 통합 신호를 보인 pane 은 명령 경로, 에이전트 pane 은 훅 경로. 웹 터미널에서는 같은 표시가 **⌘↑ / ⌘↓** 를 움직인다 — 스크롤백의 명령 경계 사이를 점프한다.

## 작업 지도

메인 화면에는 두 번째 얼굴이 있다(settings → main view → **map**): 모든 workspace 와 세션이 하나의 트리에 오르고, 각 행에는 그 작업이 무엇이고 무엇을 기다리는지 AI 가 쓴 한 줄이 붙는다 — 이 README 의 저자가 손으로 그리던 바로 그 지도다.

```bash
ttym map refresh              # 출력이 움직인 세션만 요약 — 신선한 세션은 비용 0
```

모델 백엔드 규칙은 하나다: `~/.ttym/config` 에 `map-base-url` 을 넣으면 OpenAI 호환 HTTP(로컬이든 원격이든 아무 게이트웨이), 비워두면 `claude -p`(기본 모델 `haiku`). 프롬프트는 settings 에서 편집할 수 있고 — 데이터 블록(화면 꼬리, workspace 목록)은 자동으로 뒤에 붙는다 — 일회성 지시 한 줄로 저장 없이 이번 정리만 조종할 수도 있다. 상시 주기는 `scripts/com.lullu.ttym-map-refresh.plist`(launchd 10분 간격). 요약은 정직하게 낡는다: 요약 이후 출력이 흐른 세션은 다음 갱신까지 나이와 함께 stale 로 표시된다.

## 웹 터미널

- **⌘F** — 스크롤백 문자열 검색, VS Code 방식, 매치 하이라이트.
- **⌘↑ / ⌘↓** — 명령 경계 점프 (셸 통합 필요).
- **URL 클릭 가능**, 세션 안의 프로그램(vim, 원격 ssh)이 OSC 52 로 클립보드에 복사할 수 있다.
- **파일 드롭**: 네이티브 표면은 실경로를 꽂고, 브라우저는 내용을 업로드해 서버 쪽 경로를 꽂는다 — Finder 식 이름, uuid 없음.
- **폰트**: macOS 는 네이티브 스택 그대로, 그 외 플랫폼은 동봉된 D2Coding 웹폰트 — 한글이 어디서나 고정폭이다.
- 목록에서 세션에 호버하면 라이브 미리보기, 클릭하면 전체 — 둘 다 스크린샷이 아니라 진짜 터미널이다.

## 레퍼런스

<details>
<summary><b>CLI 레퍼런스</b> — 주소 체계, exit code, 모든 동사와 플래그</summary>

### 주소 체계

```
ws:name     workspace "ws" 의 멤버 "name"
:name       현재 workspace 의 멤버 (TTYM_SESSION_ID 로 추론)
#42         세션 id 직접 지정 — workspace 미소속 세션도 이걸로 항상 접근 가능
```

CLI 는 기동 시 `/api/version` 의 `API_VERSION` 을 확인하고, 어긋나면 조용히 오동작하는 대신 실행을 거부한다.

전역 플래그(`--port`, `--json`)는 명령줄 어디에 있어도 된다 — dispatch 전에 선추출되므로 `--cmd` 가 삼키지 못한다. `--` 뒤는 전부 그대로 통과된다.

exit code 는 계약이고, contract 스위트가 검증한다:

```
0  성공
1  일반 실패
2  usage 오류
3  대상 해석 실패 (모르는 주소·모호한 주소)
4  서버 연결 불가
5  API 버전 불일치
```

### 세션

```bash
ttym new <name> [-- <cmd...>]              # 기본 cmd: $SHELL
ttym split <ws:name|:name> <new> [-- cmd]  # 대상 옆에 분할
ttym send <ws:name|:name|#id> -- "data"    # PTY 에 raw byte
ttym screen <ws:name|:name|#id> [--json]   # 현재 화면 읽기
ttym await <ws:name|:name|#id> [--timeout ms] -- "prompt"
                                           # 에이전트 턴 또는 셸 명령 — 라우팅은 위 참조
ttym commands <addr> [--limit N]           # 명령 이력 (셸 통합)
ttym output <addr> [--cmd N|last] [--raw]  # 그 명령의 출력만 ring 에서 슬라이스
ttym resize <ws:name|:name|#id> <cols> <rows>
ttym kill <ws:name|:name|#id>              # 세션 종료, holder 포함
ttym map refresh [--model M] [--base-url URL] [--note TEXT] [--force] [--dry-run]
```

### 서버 수명

```bash
ttym start [--port 7690]   # 백그라운드 기동. PID: ~/.ttym/ttym.pid
ttym stop                  # 서버 중지. holder 는 생존
ttym restart               # 재시작 → 세션 자동 복구. launchd 가 먼저 살리면 양보
ttym status                # 서버 + 세션 목록
ttym log [-f]              # ~/.ttym/ttym.log
```

### attach — 인터랙티브 TUI

```bash
ttym attach <session-id>
ttym attach <workspace>/<member>
ttym attach <ws>/<member> --new --cmd claude --dangerously-skip-permissions
ttym attach <target> --readonly          # 관찰만
ttym attach <target> --prefix C-a        # prefix 키 변경 (기본 C-b)
```

키 바인딩 (prefix = 기본 `C-b`):

```
C-b d         detach (세션은 계속 돈다)
C-b s         세션 피커
C-b n / p     다음 / 이전 workspace 멤버
C-b ?         도움말
C-b C-b       PTY 에 prefix 문자 그대로 전송
C-]           대체 detach
```

### workspace 컨트롤 플레인

```bash
ttym current [--json]                       # 이 세션의 project/workspace/member
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
# `terminate` 는 없어졌다 — `remove` 의 다른 이름이었다.
```

`--current` 는 모든 ttym 세션에 자동 주입되는 `TTYM_SESSION_ID` 로 workspace 를 해석한다.

### meta — 세션 KV

```bash
ttym meta <session-id>                           # 병합 뷰 (runtime + annotations)
ttym meta <id> --set name=worker                 # 사용자 KV → annotations 로
ttym meta <id> --claude-session <uuid>           # Claude 세션 연결
ttym meta <id> --codex-session <uuid>
```

meta 는 소유권이 갈라져 있다: runtime 키(`claude*`, `codex*`, `stopSeq`, …)는 서버 소유 — 공개 PATCH 는 400 이고, 훅은 내부 API 로 쓴다. 나머지는 전부 사용자 소유(annotations). 분류 규칙은 `@ttym/protocol` 에 있다.

### agent — 훅 설치

```bash
ttym agent install claude       # ~/.claude/settings.json 에 SessionStart+Stop 훅 주입
ttym agent install codex        # ~/.codex/hooks.json (codex_hooks 플래그 필요, v0.114+)
ttym agent uninstall <agent>
ttym agent status
ttym agent info [session-id]    # ttym 세션에 연결된 claude/codex 세션
ttym agent resume [agent]       # 그 세션으로 claude --resume / codex resume
```

</details>

<details>
<summary><b>HTTP API</b> — 모든 라우트, 입출력은 JSON</summary>

기본 베이스 `http://localhost:7690`.

```
GET    /api/version                         API_VERSION — 클라이언트 호환성 확인
GET    /api/sessions                        세션 목록
POST   /api/sessions                        생성 {cmd, cols, rows, cwd?, verify?}
GET    /api/sessions/:id                    세션 하나
DELETE /api/sessions/:id                    종료 (holder 포함)
POST   /api/sessions/:id/send               {data} → PTY 에 raw byte
GET    /api/sessions/:id/screen             현재 화면 덤프 (전체 serialize)
POST   /api/sessions/:id/resize             {cols, rows}
GET    /api/sessions/:id/runtime            조립된 서버 소유 뷰 (terminal·process·agent)
GET|PATCH /api/sessions/:id/annotations     사용자 소유 KV
GET|PATCH /api/sessions/:id/meta            병합 뷰 — 호환 어댑터. runtime 키는 400
POST   /api/sessions/:id/interactions       {prompt, timeoutMs?} → 답변까지 블로킹
GET    /api/sessions/:id/interactions/:iid  202 로 넘어간 interaction 재개
GET    /api/sessions/:id/commands           명령 인덱스 (셸 통합; 신호 없으면 빈 목록)
POST   /api/sessions/:id/commands           실행-후-대기 {data} → exit code (신호 없으면 409)
GET    /api/sessions/:id/commands/:n/output 그 명령의 바이트만 ring 에서 슬라이스
POST   /api/internal/sessions/:id/stop      에이전트 Stop 훅 전용
POST   /api/internal/sessions/:id/agent     훅의 runtime 키 쓰기 전용
POST   /api/upload?name=<file>              raw body → ~/.ttym/drops, Finder 식 이름 중복 처리

GET|PATCH /api/config                       flat 설정 파일 — 모든 클라이언트에 push
GET    /api/map                             작업 지도: workspace + 세션 + 요약 + 신선도
GET|PUT /api/map/prompt                     요약기 지시문 (빈 PUT = 기본값 복귀)
POST   /api/map/refresh                     요약기 실행 ({note?}; single-flight)
GET|POST /api/map/api-key                   write-only 키 저장소; GET 은 {set} 만

GET    /api/projects                        project 집계
GET    /api/workspaces[?project=<p>]        workspace 목록
POST   /api/workspaces                      생성 {id, name, layout, project?}
GET|PATCH|DELETE /api/workspaces/:id        PATCH 는 {map} 배치도 받는다
POST   /api/workspaces/:id/members          멤버 추가 {sessionId, name, role?, tags?}
PATCH|DELETE /api/workspaces/:id/members/:sid
POST   /api/workspaces/:id/split            layout 연산
```

</details>

<details>
<summary><b>WebSocket 프레임 프로토콜</b> — opcode 0x00–0x10</summary>

바이너리 프레임: `uint16 sessionId · uint8 cmd · payload`.

```
0x00 DATA         PTY ↔ viewer 바이트 스트림 (출력에만 seq)
0x01 RESIZE       {cols, rows}
0x02 CREATE       WS 로 세션 생성
0x03 DESTROY      세션 종료됨
0x04 PAUSE        세션 출력 일시정지 (서버 측)
0x05 RESUME
0x06 HELLO        {clientId}
0x07 LIST         세션 목록
0x08 ATTACH       {fromSeq, cols, rows, mode}
0x09 DETACH
0x0a SNAPSHOT     전체 화면, UTF-8 (ATTACH 응답)
0x0b ACK          {seq} — viewer 가 파싱 완료를 확인; 배압과 ring trim 을 이끈다
0x0c PAUSE_VIEW   viewer 측 일시정지 (숨은 pane 은 버퍼 유지, 스트림만 중단)
0x0d RESUME_VIEW
0x0e WORKSPACE    server → client: workspace 변경 (push, 폴링 없음)
0x0f AGENT        server → client: 세션의 에이전트 상태 변경 (kind/active)
0x10 CONFIG       server → client: 설정 파일 변경 — 항상 전체 값, diff 없음
```

</details>

<details>
<summary><b>설정 파일</b> — <code>~/.ttym/config</code>, 모든 표면의 단일 진실</summary>

flat `key = value`, `#` 주석 (ghostty 모델). 서버가 파일을 소유하고 `GET /api/config` 로 서빙한다; 클라이언트가 PATCH 하면 모든 표면(웹·데스크톱·모든 창)이 따라온다. 주석과 모르는 줄은 편집에서 살아남는다. 비밀은 절대 넣지 마라 — 모든 클라이언트에 서빙되는 파일이다.

```
theme        = dark | light         UI + 터미널 팔레트
ui-style     = frame | classic      크롬 스타일
main-view    = preview | map        메인 화면: 세션 미리보기 또는 작업 지도
font-size    = 14                   터미널 폰트 크기 (8–32)
local-echo   = true | false         낙관적 local echo (실험적)
zoom         = 1.0                  데스크톱 창 zoom (앱이 쓴다)
map-model    = haiku                요약기 모델 (작업 지도 참조)
map-base-url =                      있으면 OpenAI 호환 HTTP; 없으면 claude CLI
```

의도적으로 이 파일 밖에 있는 것: 요약기 API 키는 `~/.ttym/map-api-key`(chmod 600) 또는 `OPENAI_API_KEY` 에 산다.

</details>

<details>
<summary><b>환경 변수 · 런타임 경로</b></summary>

```
PORT                   서버 포트 (기본 7690)
TTYM_HOME              ~/.ttym 루트 교체 (테스트 격리)
TTYM_RUNTIME_DIR       holder socket/manifest 디렉토리 (기본 ~/.ttym/run)
TTYM_HOLDER_BIN        holder 바이너리 경로 (기본: dist/ 에서 자동 탐지)
TTYM_GC_DAYS           미참조 snapshot/meta 유예 일수 (기본 14, 0=off)
TTYM_SESSION_ID        ttym 세션 안에 자동 주입 (attach/훅이 사용)
TTYM_PREFIX            attach TUI prefix 키 (기본 C-b)
TTYM_HTTP_TIMEOUT_MS   CLI HTTP 타임아웃 (기본 5000)
TTYM_ATTACH_RETRY_MS   attach 재접속 간격 (기본 1000)
```

```
~/.ttym/
├── config                서버 소유 설정 (설정 파일 참조)
├── map-api-key           요약기 키, 0600 — 절대 서빙 안 됨
├── map-prompt.txt        편집된 요약기 지시문 (없으면 내장 기본값)
├── ttym.pid              서버 PID
├── ttym.log              서버 stdout/stderr (64MB 에서 copy-truncate → .1)
├── drops/                브라우저 드래그드롭으로 올라온 파일
└── run/
    ├── workspaces.json       workspace + 멤버 + 지도 배치 (atomic write)
    ├── session-<id>.json     holder manifest
    ├── session-<id>.sock     holder unix socket
    ├── snapshot-<id>.json    체크포인트 (렌더된 ANSI + offset)
    ├── meta-<id>.json        세션 meta
    └── next-id               세션 id 카운터
```

</details>

<details>
<summary><b>세션 영속성과 integrity</b> — 세션이 어떻게, 얼마나 정직하게 살아남는가</summary>

holder 가 별도 프로세스라서 PTY 는 서버보다 오래 산다.

```bash
ttym start
ttym new work
ttym restart                  # 서버가 내려갔다 올라와도
ttym status                   # 세션은 그대로다. 같은 pid — 붙어서 계속하면 된다
```

복구는 세 겹이다:

- **체크포인트.** 서버가 주기적으로 세션별 렌더된 ANSI 스냅샷을 디스크에 쓴다(유휴 2초 / 최대 30초, applied offset·holder 세대·행별 wrap 비트 포함). 재시작 시 체크포인트로 xterm 을 seed 하고 holder 에는 그 offset 이후의 delta 만 요청한다.
- **컨트롤러 lease.** holder 는 컨트롤러를 하나만 받는다. 새 서버는 명시적으로 `ACQUIRE` 해야 하고, 자리가 차 있으면 거절당한다 — 그리고 거절은 *점유*지 *사망*이 아니다: workspace 복원은 남이 쥔 세션을 부활시키지 않고, 라이벌 서버 부트는 holder 를 건드리기 전에 포트 검사에서 문전 사살된다.
- **소켓 자가치유.** holder 는 5초마다 자기 소켓 경로를 확인하고, 파일이 사라졌으면 다시 바인드하고 manifest 를 다시 쓴다 — 살아 있는 PTY 가 연락두절이 되는 일은 없다.

**integrity 는 일급 플래그다.** 복구가 바이트를 건너뛰어야 했다면(offset 이 holder ring 밖으로 밀려남) 세션은 `/runtime` 에 `integrity: "degraded"` 를 보고하고, `await` 결과에 실리고, CLI 는 stderr 로 경고한다. 리플레이는 이스케이프 시퀀스 한가운데서 시작하지 않는다 — holder 가 UTF-8 + ECMA-48 렉서로 안전 경계를 추적한다. 스트림에 완전한 터미널 리셋(`RIS`)이 나타나야만 플래그가 치유되고, degraded 체크포인트는 쓰긴 하되 복구 기반으로는 절대 쓰지 않는다.

부팅 복구는 workspace 가 참조하는 세션만 되살린다; 미참조 snapshot/meta 는 14일 유예 후 GC 된다(`TTYM_GC_DAYS`, 0=off).

</details>

<details>
<summary><b>훅과 await 의 내부</b> — 에이전트 루프 뒤에서 벌어지는 일</summary>

- **SessionStart**: Claude/Codex 가 시작되면 그 세션 id 가 `TTYM_SESSION_ID` 가 가리키는 ttym 세션에 기록된다 (`claudeSessionId` / `codexSessionId`).
- **UserPromptSubmit** (Claude): 턴마다 활동 플래그를 재장전한다 — 웹의 "실행 중" 점은 낡았을지 모르는 플래그를 영원히 믿는 대신 15분 liveness TTL 을 갖는다.
- **Stop**: 턴 완료를 서버에 보고한다 (`POST /api/internal/sessions/:id/stop`). StopFailure 와 SessionEnd 도 등록되어 있어 실패한 턴은 타임아웃이 아니라 즉시 정산된다.

```
scripts/ttym-claude-hook.sh           Claude SessionStart
scripts/ttym-claude-activity-hook.sh  Claude UserPromptSubmit
scripts/ttym-claude-stop-hook.sh      Claude Stop
scripts/ttym-codex-stop-hook.sh       Codex Stop
scripts/ttym-shell-integration.zsh    zsh OSC 133/633 표시
```

`ttym await` 는 완료 신호를 증거로 고른다:

- **에이전트 pane** (훅 설치됨): 프롬프트 + CR 을 보내고 Stop 훅을 기다린 뒤 **답변**을 읽는다 — 디스크의 구조화 transcript 에서 그 턴의 마지막 assistant 메시지를 먼저(`transcriptSource: "structured"`), 안 되면 xterm marker 와 커서 사이의 렌더된 화면에서(`"screen"`). marker 가 밀려나갔으면 남의 출력 대신 null 을 준다.
- **셸 pane** (통합 신호 관측됨): 명령을 보내고 OSC `133;D` 표시까지 막은 뒤, exit code 와 `[startSeq, endSeq)` 창으로 슬라이스한 출력을 돌려준다.

타임아웃 시 interaction 은 202 + Location 으로 넘어가고 id 로 재개할 수 있다. 여러 멤버 동시 await 는 각자 독립적으로 완료된다.

</details>

<details>
<summary><b>개발 · 데스크톱 릴리즈</b></summary>

```bash
pnpm test                     # vitest — 실제 holder·실제 PTY 를 띄우고 프로덕션 fixture 를 리플레이
pnpm test:e2e                 # Playwright
pnpm --dir packages/server dev
pnpm --dir packages/web dev   # 브라우저 앱 (Vite, 별도 포트)
pnpm desktop:dev              # Tauri 앱 (dev 셸; TTYM_PORT 로 지정)
```

pnpm workspace 멤버: `packages/*` 9개 + Rust `holder/`.

데스크톱 릴리즈:

```bash
pnpm desktop:build            # tauri build → .app  (scripts/build.sh 를 선행하므로
                              #  동봉 폴백 dist 가 최신으로 실린다)
ditto packages/desktop/src-tauri/target/release/bundle/macos/ttym.app /Applications/ttym.app
```

언제 재빌드하나: 앱은 *서빙되는* 웹 UI 를 감싼 네이티브 셸이라 웹 변경은 서버 배포만으로 도달한다 — 재빌드 불필요. `packages/desktop/src-tauri` 가 바뀌었거나, 서버가 없을 때 부트스트랩용으로 쓰는 동봉 `dist/` 를 갱신할 때만 재빌드한다.

</details>

## 문서

- [docs/architecture.md](docs/architecture.md) — 계층, holder 프로토콜, wire 포맷, meta 소유권, 작업 지도, 운영 위생
- [docs/adr-0001-membership.md](docs/adr-0001-membership.md) — workspace 멤버십 모델
