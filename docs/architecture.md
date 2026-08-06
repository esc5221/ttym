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
DATA (서버→클라)   [u32 seq] 프리픽스 — 재생·ACK용
DATA (클라→서버)   프리픽스 없음 — 키 입력 바이트 그대로
```

DATA 프레임은 **방향에 따라 모양이 다르다.** 디코더도 방향을 안다 —
`decodeServerFrame` / `decodeClientFrame`. 하나의 대칭 decode로 합쳤을 때
서버가 7바이트 이상의 입력 프레임 앞 4바이트를 seq로 먹었고, 한글 IME가
음절+공백을 한 프레임으로 커밋하는 순간 글자가 사라졌다. 회귀 테스트가
실제 PTY로 이 시나리오를 고정하고 있다.

`API_VERSION`은 HTTP+WS 표면 전체의 버전이다. CLI는 `/api/version`으로
확인하고 불일치면 exit 1로 멈춘다 — 조용한 오동작 금지.

## interaction (에이전트 request/response)

`ttym await`은 화면 덤프가 아니라 **이번 턴의 transcript**를 돌려준다.

```
제출     서버가 xterm marker로 버퍼 위치를 잡고 프롬프트+CR 전송
완료     에이전트 Stop hook → POST /api/internal/sessions/:id/stop
         StopFailure·SessionEnd도 등록 — 실패한 턴은 timeout이 아니라 즉시 정리
추출     marker부터 커서까지의 렌더된 행. marker가 스크롤아웃되면
         (line=-1) null — 엉뚱한 구간을 정답처럼 주지 않는다
타임아웃  interaction은 pending으로 남고 id로 이어받는다 (202 + Location)
```

행 번호 대신 xterm marker를 쓰는 이유: 행 번호는 스크롤백이 밀린 뒤에도
범위 안에 남아 **남의 출력을 조용히 가리킨다.**

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
