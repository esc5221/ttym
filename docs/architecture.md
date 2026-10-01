# 아키텍처

ttym의 모든 성질은 한 가지 결정에서 나온다: **PTY가 서버 밖에서 산다.**

## 계층

```
CONSUMER   @ttym/web        브라우저 앱 (대시보드·분할·에이전트 상태)
           @ttym/desktop    Tauri 앱 — 같은 계약 위의 다른 껍데기
           셸이 있는 무엇이든 — CLI가 호환 경계다

CONTRACT   @ttym/cli        headless 표면. new · split · send · await · screen
           @ttym/protocol   wire 포맷. 서버·클라이언트가 같은 구현을 쓴다
           @ttym/api        두 앱이 공유하는 HTTP 클라이언트

CORE       @ttym/server     터미널 상태의 권위 — 셀 그리드·스크롤백·마커,
                            세션·워크스페이스·interaction
           @ttym/ui         웹 터미널 컴포넌트 + mux
           @ttym/shared     서버와 클라이언트가 합의해야 하는 도메인 규칙

BASE       ttym-holder      세션당 하나, Rust, detached. PTY 소유.
                            서버와는 unix socket뿐 — 서버가 죽어도 안 죽는 이유
```

낮은 계층일수록 재설계에 강하다. 결함은 아래부터 고치고, 표면은 마지막에 바꾼다.

## holder ↔ 서버

holder는 바이트만 안다. 터미널 에뮬레이션은 서버의 headless xterm이 한다 —
holder에 셀 모델을 넣으면 대체 구현의 비용이 커지고, 서버의 xterm과 진실이
갈라진다.

```
frame     [u32 len LE][u8 cmd][payload]
STATE     접속 시 세션 정보 + 능력 광고 (lease, generation, baseOffset, nextOffset)
DATA_*    입출력. holder는 출력의 누적 byte offset을 센다
DUMP_SINCE(offset) → REPLAY{base, end, gap, bytes}
ACQUIRE / ACQUIRED / DENIED / EVICTED     controller lease
```

**복구**: 서버는 세션마다 렌더된 ANSI 체크포인트를 주기적으로 디스크에 쓴다
(idle 2초 / 최대 30초, `appliedThroughOffset`·holder `generation`·행별 wrap
bit 포함). 재접속하면 체크포인트를 xterm에 seed하고 holder에는 그 offset
이후의 델타만 요청한다. 요청 지점이 ring 밖이면 holder가 `gap=true`로
답하고, 서버는 이를 정상 복구로 위장하지 않는다.

**lease**: holder는 controller를 하나만 받는다. lease를 아는 서버는
`ACQUIRE`로 명시적으로 얻고, 이미 점유돼 있으면 `takeover` 없이는 거절된다.
lease를 모르는 구 서버는 1.5초 침묵 후 legacy로 승격된다 — 하위호환.
이 프레임들이 생기기 전에는 새 접속이 기존 서버를 조용히 축출했고, 그것이
서버 두 개가 경쟁할 때 세션을 잃는 경로였다.

**소켓 자가복구**: 같은 id의 holder가 새로 뜨면 기존 소켓 파일을 지운다.
holder는 5초마다 자기 소켓 경로를 확인하고, 사라졌으면 재bind하고 manifest를
다시 쓴다. 이게 없으면 살아있는 PTY에 아무도 도달할 수 없는 고아가 생긴다.

## wire 프로토콜 (서버 ↔ 클라이언트)

```
[u16 sessionId LE][u8 cmd][payload]
DATA     (서버→클라)   [u32 seq] 프리픽스 — 재생·ACK용
SNAPSHOT (서버→클라)   [u32 seq] 프리픽스 — 스냅샷이 렌더된 시점의 watermark.
                      클라이언트는 이걸로 fromSeq를 갱신해, 스냅샷 재동기화가
                      또 다른 스냅샷 폴백으로 연쇄되는 것을 끊는다
DATA     (클라→서버)   프리픽스 없음 — 키 입력 바이트 그대로
```

클라이언트의 스냅샷 적용은 `term.reset()`이 아니라 **단일 write의 in-band
RIS**(`\x1bc` + snap)다. xterm 5.x에서 단일 write 청크는 원자적으로 파싱되므로
리셋과 재묘화가 한 프레임에 떨어진다 — reset() 호출은 화면을 먼저 비워 빈
프레임(깜빡임)을 만들고, xterm 내부 write 버퍼의 미처리 바이트도 남긴다.

DATA 프레임은 **방향에 따라 모양이 다르다.** 디코더도 방향을 안다 —
`decodeServerFrame` / `decodeClientFrame`. 하나의 대칭 decode로 합쳤을 때
서버가 7바이트 이상의 입력 프레임 앞 4바이트를 seq로 먹었고, 한글 IME가
음절+공백을 한 프레임으로 커밋하는 순간 글자가 사라졌다. 회귀 테스트가
실제 PTY로 이 시나리오를 고정하고 있다.

`API_VERSION`은 HTTP+WS 표면 전체의 버전이다. CLI는 `/api/version`으로
확인하고 불일치면 exit 1로 멈춘다 — 조용한 오동작 금지.

## interaction (에이전트 request/response)

`ttym await`은 화면 덤프가 아니라 **그 턴에 에이전트가 한 말**을 돌려준다.

```
제출     서버가 xterm marker로 버퍼 위치를 잡고 프롬프트를 512바이트 조각으로(20ms 간격) 쓴 뒤 CR.
         한 번에 쓰면 macOS PTY가 ~1KB만 받고 나머지는 holder가 나중에 써서, Claude가 가끔
         앞 조각을 버렸다. 잠든 에이전트면 깨운 뒤 쓴다
완료     에이전트 Stop hook → POST /api/internal/sessions/:id/stop
         훅이 Stop 입력의 last_assistant_message·transcript_path(Codex는 turn_id도)를 그대로 넘긴다
         StopFailure·SessionEnd도 등록 — 실패한 턴은 timeout이 아니라 즉시 정리
답       훅이 준 마지막 답 → 없으면 transcript에서 이 턴의 마지막 text → 없으면 marker부터의 화면 행
turn     transcript를 다시 읽어 요약(시간·도구·수정 파일)과 ttym turn(outline/full)을 만든다
         (agent-turn.ts — Claude는 시간 범위, Codex는 task_started~task_complete)
타임아웃  interaction은 pending으로 남고 id로 이어받는다 (202 + Location, ttym await --id).
         끝난 것은 6시간 보관
```

행 번호 대신 xterm marker를 쓰는 이유: 행 번호는 스크롤백이 밀린 뒤에도
범위 안에 남아 **남의 출력을 조용히 가리킨다.**

## HTTP API — 밖에서 쓸 때 알아둘 것

```
POST /api/sessions {cmd,cwd,cols,rows,verify}
    verify:true면 2초 기다린다 — 그 안에 PTY가 끝나면(잘못된 명령) 400과 함께 정리한다.
    살아 있는지는 2초가 지나야 알 수 있어서 "살아 있으면 즉시"는 불가능하다. 빠른 생성이
    필요하면 verify를 빼고, 끝났는지는 워크스페이스 멤버의 status로 본다
GET  /api/sessions/:id/screen[?format=text]
    기본은 ANSI 스냅샷. format=text는 터미널 버퍼의 행 그대로(공백 보존). 잠든 pane은 잠들 때 화면
GET  /api/workspaces[/:id]
    멤버마다 status: running | exited | gone. 끝난 세션의 멤버는 일부러 남는다 —
    웹이 그 자리에 restart/close를 띄운다
409  충돌은 code로 읽는다: member_name_taken · session_in_other_workspace · workspace_name_taken
```

## 임베드 (다른 앱 안의 패널)

소비처 앱이 자기 화면에 ttym 패널을 넣는 경로. 쓰는 법은 docs/embedding.md.

```
등록      ~/.ttym/embed-consumers.json (ttym embed consumer …). id → 키 해시·출처·워크스페이스·실행 프로필.
          서버는 mtime이 바뀌면 다시 읽는다. 지우거나 키를 바꾸면 그 소비처의 grant가 끝난다
grant     POST /api/embed/v1/grants (소비처 키) — admin 리스너에서만(기본 <home>/embed.sock,
          TTYM_EMBED_ADMIN). 메인 포트에서는 404라 프록시가 실수로 넘겨도 열리지 않는다.
          메모리에만, 토큰은 해시로. 범위마다 권한(terminal.read · terminal.write · tabs.write).
          등록 밖의 요청은 400. 3초마다 sweep — 소비처 삭제·키 교체가 조용한 소켓도 닫는다
WS        /embed/v1/ws. 첫 프레임 HELLO에 grant가 없으면 아무것도 처리하지 않는다 (루프백도).
          수신 프레임은 authorizeInbound, push는 sendPush 안의 filterOutbound (embed/authorize.ts)
          — 표에 없는 CMD는 거부. AGENT·VIEW·CONFIG push는 grant 연결에 안 간다
탭        /api/embed/v1/workspaces/:ws/tabs. 탭 = 워크스페이스 멤버. 워크스페이스마다 직렬화
패널      packages/web/embed → web/dist/embed/v1 (상대경로 빌드). sdk.js가 iframe으로 띄운다
패널 경로  /embed/v1/*는 상대경로만, 결과가 루트 하위인지 확인, 정해진 확장자만 (//etc/hosts 사고)
gate      /embed/v1/*·/api/embed/v1/*는 remote gate(허용 호스트·로그인 쿠키)를 건너뛴다.
          소비처 프록시가 자기 Host·Origin으로 넘기므로, 거기서는 키·grant가 검사다
```

grant가 막는 것은 패널이 닿는 범위다. 탭 안의 셸은 ttym을 띄운 OS 사용자로 돌고 루프백
무인증 API를 부를 수 있으므로, 소비처마다 전용 인스턴스를 둔다.

## meta 소유권

```
runtime (서버 소유)   claude*/codex* 매핑 + 레거시 핸드셰이크 키
                      공개 PATCH → 400. hook은 /api/internal/.../agent 로
annotations (사용자)  그 외 전부. GET/PATCH /annotations
/meta                 병합 뷰 — 호환 어댑터
/runtime              조립된 읽기 전용 뷰 (terminal·process·agent)
```

분류 규칙은 `@ttym/protocol`에 있다 — 서버는 강제하고 CLI는 라우팅하므로
같은 답이 필요하다.

## 작업 지도 (map)

```
생산   ttym map refresh — stale(lastSeq > 요약의 atSeq) 세션의 화면 꼬리를
       모델 1회 배치 호출로 요약. base-url 유무로 OpenAI 호환/claude -p 분기
저장   세션 요약  → meta.mapSummary (annotations — 사용자 소유 절반)
       줄기 배치  → workspace.map {stream, column, order} (workspaces.json)
소비   GET /api/map — 서버가 세션×요약×신선도를 조립. 웹 map 뷰는 그리기만
```

요약은 관측에만 붙는다: 신호가 없으면 빈 목록, 모델이 빼먹은 세션은 빈
요약으로 마킹("내용 없음"도 결론), 낡은 요약은 stale로 정직하게 노출.

## 운영 위생

- `ttym.log`는 64MB 초과 시 copy-truncate (`.1` 한 세대). 모든 writer가
  O_APPEND라 열린 fd가 그대로 살아남는다 — holder는 몇 주씩 살기 때문에
  rename 로테이션은 불가능하다.
- 런타임 디렉토리는 부팅 + 매일: 라이브 세션도 워크스페이스 멤버도 아닌
  세션의 snapshot/meta를 14일 유예 후 정리한다 (`TTYM_GC_DAYS`, 0=off).
- 부팅 복구는 workspace가 참조하는 세션만 되살린다 — 디스크의 모든
  스냅샷을 PTY로 부활시켰던 사고의 방어선.

## 테스트

`pnpm test` — 161+. 실제 holder를 spawn하고, WS 프로토콜로 실제 PTY를
구동하며, 프로덕션 런타임 디렉토리의 비식별 캡처(워크스페이스 7 ·
스냅샷 180 · meta 241)를 실규모로 재생해 부팅·복구·v2 왕복을 고정한다.
CLI는 빌드된 실물(`dist/ttym`)로 e2e를 돈다.
