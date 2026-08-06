# ttym v4 — 설계 토론 브리핑

## 이 문서의 목적

ttym의 다음 세대(v4) 아키텍처를 정하기 전에, 외부 관점의 비판을 받기 위한 브리핑이다.
당신은 principal architecture engineer로서 답한다. 듣기 좋은 말은 필요 없다.
근거 없는 동의보다 근거 있는 반대가 훨씬 가치 있다.

---

## 1. ttym이 무엇인가

웹 기반 터미널 멀티플렉서. 서버가 PTY 세션을 관리하고, workspace 단위로 여러
멤버(터미널/AI 에이전트)를 묶어 협업·자동화한다. 사용자는 1명(개발자 본인).

핵심 구조는 3층이다.

```
[3] 클라이언트    브라우저(웹), CLI attach, native(Tauri), demo   — 화면
[2] 서버          Node. HTTP API + WebSocket + 세션/워크스페이스 관리
[1] holder        Rust 바이너리. PTY를 소유. 서버와 unix socket으로 통신
```

**결정적 성질: holder가 서버와 분리된 프로세스라, 서버를 죽였다 살려도
PTY 안의 프로세스(claude, ssh, 빌드 등)가 죽지 않는다.**

- holder는 `detached: true`, `stdio: 'ignore'`로 spawn된다
- 서버 종료 코드에 `Don't call session.kill() — holders should survive server restart` 주석이 있다
- 서버 부팅 시 runtime dir의 manifest를 스캔해 살아있는 holder에 재접속한다
- holder는 1MB ring buffer를 갖고, 재접속 시 DUMP로 화면을 복원한다
- holder는 클라이언트를 **하나만** 받는다. 새 접속이 기존 접속을 축출한다

오늘 이 성질로 프로덕션 서버를 무중단 교체했다(세션 15개, claude 프로세스 38개 생존).

## 2. 현재 규모

```
프로덕션 세션      15개 (claude 에이전트 13개 + ssh + python 모니터 등)
claude 프로세스    38개 (세션당 claude + MCP 서버 2~3개)
서버 RSS           93~151 MB
holder RSS         세션당 560KB ~ 1.2MB
가동                직전까지 41일 무재시작
```

서버는 launchd LaunchAgent(`KeepAlive: true`)로 관리된다.

## 3. 최근 확정한 사실 (전부 실측)

**터미널 출력의 성질**
```
                        raw bytes    렌더된 행    행당 bytes
Claude 긴 응답 1회        94,065       103         913
Codex 짧은 응답 1회       43,319        39       1,111
zsh 출력                      —          —          79
```
- agent TUI는 같은 행을 반복해 다시 그린다. raw 바이트의 대부분이 redraw 파편이다
- 같은 3000행이 raw로는 2.7MB, 렌더된 ANSI 스냅샷으로는 571KB (4.7배 차이)
- Claude Code와 Codex 모두 alternate screen(`?1049h`)을 쓰지 않는다

**교체 시 손실**
- ring을 축소해 비율을 재현한 결과: 바이트 39.6% 손실 시 렌더된 행은 12.8%만 손실
- 사라진 것은 부팅 배너뿐, 대화 본문은 생존
- 바이트 기준 용량 계산은 실제 손실을 과대평가한다

**마커의 성질**
- 응답 구간의 시작점을 행 인덱스(`baseY + cursorY`)로 기록하면, 스크롤백이 밀릴 때
  그 숫자가 **범위 안에 머문 채 남의 출력을 가리킨다** (silent corruption)
- xterm `registerMarker`는 행을 추적하고 스크롤아웃 시 `line === -1`을 준다

## 4. 조사한 8개 프로젝트 (전부 clone 후 소스 확인)

**지속성 계보**
- `abduco` (C, 268KB): dtach 후계. PTY 소유 + detach만. 터미널 에뮬레이션도 스크롤백도 없음. 의도적으로 최소
- `tmux`: 서버가 pane마다 grid(셀 배열) 소유. 클라이언트는 뷰. **서버가 죽으면 전부 죽음**
- `mosh` (MIT): 터미널을 "동기화할 상태 객체"로 봄. 서버가 에뮬레이터를 돌려 `Framebuffer`를 만들고 diff/patch로 동기화. **뷰포트만, 스크롤백 없음**
- `conmon` (CRI-O): 런타임이 죽어도 컨테이너가 살도록 PTY 감시를 분리. 출력은 **파일**에 쓰고 `--log-size-max`로 제한

**agent 계보 (2026년 등장)**
- `claude-squad` (Go, 47파일): PTY/지속성을 **tmux에 위임**. `tmux new-session -d ...` 호출 + git worktree
- `vibetunnel` (TS+Swift): 세션당 디렉토리에 **asciinema cast 파일** append. 화면소거 ANSI 시퀀스(`\x1b[3J`, `\x1b[2J`, `\x1bc`, `?1049h/l`)를 감지해 **그 지점에서만** 파일을 자름
- `cmux` (Swift 8113파일, libghostty): macOS 네이티브. **"does not checkpoint arbitrary live process state"**를 명시. 레이아웃·cwd·스크롤백(best effort)만 복원하고, agent는 native session id로 `--resume`
- `paseo` (TS 2707파일 + iOS/Android): 상주 데몬(6767) + 멀티 클라이언트. PTY는 **별도 worker 프로세스**. `TerminalCell[]` 셀 그리드를 프로토콜로 전송. `TerminalStateSnapshot { state, revision, replayPreamble }`, `captureTerminalLines(start, end)`, `scrollbackLines`, `includeWrapFlags`(resize 시 reflow). agent 훅을 provider registry로 관리(claude/codex/opencode), 이벤트 5종(`UserPromptSubmit`/`Stop`/`StopFailure`/`SessionEnd`/`Notification`)
- `orca` (TS 10204 + Electron): ADE. agent마다 git worktree. PTY는 Electron main에 있어 **앱 종료 시 사망**. 스크롤백을 디스크에 저장(store 5MB / replay 512KB)하고 GC. 자를 때 **UTF-8 경계**까지만 보정. plugin capabilities + consent gate

**핵심 대조**
- 조사한 신규 프로젝트 중 **서버/앱을 죽였다 살려도 세션이 사는 것은 ttym뿐**(paseo는 구조상 가능해 보이나 미확인)
- orca·cmux는 프로세스 지속성을 명시적으로 포기하고 agent의 `--resume`에 위임
- 버퍼를 자르는 정밀도: ttym(임의 바이트) < orca(UTF-8 경계) < vibetunnel(ANSI 의미 경계)

## 5. ttym이 지금 뒤처진 지점

```
상태 표현        raw 바이트 ring          (paseo·mosh·tmux는 셀)
버퍼 자르기      임의 바이트 절단          (UTF-8도 ANSI 시퀀스도 무시)
스크롤백 수명    메모리 1MB 고정, GC 없음  (orca는 GC, vibetunnel은 prune, conmon은 로테이션)
agent 훅         Claude Stop 1종 하드코딩  (paseo는 5종 + provider registry)
확장점           HTTP/WS만, 플러그인 없음  (tmux·orca·paseo는 있음)
resize 시 reflow  미고려                   (paseo는 wrap flag를 프로토콜에 포함)
holder 프로토콜   문서 없음, 버전 협상 없음  (제3자가 다른 holder를 만들 수 없음)
```

## 6. 사용자가 원하는 방향

원문 그대로:

> tmux같이 범용성 좋으면서 pluggable, customizable하고, applicable(앱이나 클라이언트,
> 웹 등 원하는대로 짤 수 있는느낌. 백엔드도 holder 이런거도 그 위에서 구축 가능하게)
> building block을 깔끔하게 만들고, 그 위에 이걸 가장 잘 소화하는게 우리 웹,
> 네이티브 클라이언트가 되는 느낌

관찰 하나: tmux가 building block인 이유는 클라이언트가 우수해서가 아니라
**headless로 조작 가능해서**다. claude-squad는 tmux UI를 전혀 쓰지 않고
`tmux new-session -d`만 호출한다.

## 7. 직전 세대(v3)에서 이미 한 것 / 남은 것

RFD 1(v3)은 네 변경으로 구성된다.
- **A. layout을 소속의 단일 장부로** — 현재 layout 연산이 트리를 평탄화해 중첩과 비율을 파괴한다. 미착수
- **B. interaction과 transcript** — 완료. 응답 구간을 xterm marker로 잡고, 서버가 interaction을 소유하고, agent 훅이 직접 완료를 알린다(1초 폴링 제거)
- **C. runtime/annotations 분리** — meta에서 프로토콜 상태를 분리. B가 절반을 이미 해결. 미착수
- **D. CLI 표면 정리** — 주소 체계 통일, 동사 분리. 미착수. **클라이언트 3개가 동시에 안 도는 구간이 생긴다**

A는 `workspaces.json`을 v2→v3로 **일방향 변환**한다(복원 경로 없음).

## 8. 답을 원하는 질문

1. **계층 경계를 어디서 잘라야 하는가.** holder / 서버 / 프로토콜 / 클라이언트의 책임을
   어떻게 나눠야 "그 위에 다른 것을 지을 수 있는" 물건이 되는가.

2. **building block이 되기 위해 실제로 필요한 최소 조건은 무엇인가.**
   tmux·conmon·paseo를 볼 때, 문서화된 프로토콜인가, 안정된 CLI인가, 플러그인 API인가,
   아니면 다른 것인가.

3. **상태 표현을 어느 층이 책임져야 하는가.** holder가 바이트만 다루고 서버가 셀을
   다루는 현재 구조를 유지할 것인가, holder도 셀을 알아야 하는가(mosh 방식),
   아니면 디스크 파일을 계약으로 삼을 것인가(vibetunnel 방식).

4. **지속성 저장소를 교체 가능하게 만드는 것이 값을 하는가.** ring / 디스크 cast /
   셀 스냅샷 중 고르게 할 것인가, 하나로 정할 것인가.

5. **v3의 A·C·D를 v4 관점에서 어떻게 재배치해야 하는가.** 특히 A는 저장 포맷을
   일방향 변환하므로, v4가 모델을 바꿀 가능성이 있다면 지금 하면 손해다.

6. **반대 논거.** v4를 지향하는 것 자체가 틀렸을 가능성. 과거에 v2 설계를 33일 하고
   구현은 0%로 3개월 방치한 전례가 있다. "building block을 만들겠다"가
   실사용자 1명짜리 프로젝트에서 과잉설계일 가능성을 진지하게 검토해달라.

## 9. 제약

- 실사용자 1명. 클라이언트(web/native/demo)는 전부 같은 저장소 안. 외부 소비자는 알려진 것 없음
- 프로덕션이 지금 돌고 있다. 세션 15개, claude 38개. 재설계 중에도 계속 돌아야 한다
- 개발 인력은 사실상 무제한(AI 코딩). 일정 산정은 무의미하다. 대신 **되돌리기 비용**이 진짜 제약이다
- Rust(holder) + TypeScript(서버/클라이언트) 혼합. 언어 추가는 신중해야 한다
