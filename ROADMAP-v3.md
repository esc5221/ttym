# ttym v3 — 실행 로드맵

RFD 1 (`rfd-0001-ttym-v3.html`)의 A·B·C·D를 실제로 착수하기 위한 작업 목록.
Phase 0/0.5는 RFD에 없다 — 프로덕션을 켜둔 채 개발하기 위한 격리와,
과거 세션 조사 중 발견된 교체 안전성 문제에서 나왔다.

제약: **프로덕션 서버(port 7690, pid 2713)는 Phase 5까지 절대 정지하지 않는다.**
개발·검증은 전부 dev 서버(port 7691, `~/.ttym-dev`, worktree `~/study/ttym-v3`)에서 한다.

진행: **24/49 (48%)**

---

## Phase 0 — dev 격리 · 5/5 ✔

- [x] git worktree `~/study/ttym-v3` (branch `v3`)
- [x] `TTYM_HOME` env — dev가 프로덕션 `ttym.pid`를 덮어쓰고 종료 시 삭제하던 것 (`5d2a682`)
- [x] worktree 안에서 dist 빌드 (프로덕션 `dist/` 무손상)
- [x] `scripts/dev-env.sh` — port 7691 + `~/.ttym-dev` + v3 holder 바이너리
- [x] 격리 검증 — 프로덕션 pid/세션/holder/로그 무오염 확인

## Phase 0.5 — 교체 안전성 · 4/4 ✔

조사 중 발견. 소켓 고아 문제는 프로덕션에 이미 3건 발생해 있었다.

- [x] 소켓 잃은 holder 영구 고아화 — 재현 → rebind 수정 (`570cfcc`)
      - 원인: `main.rs:221`이 같은 id의 소켓을 무조건 삭제
      - 증상: listener fd는 살아있는데 경로로 도달 불가 → `recover()` ENOENT → manifest 삭제
      - 수정: 5초마다 소켓 존재 확인, 사라졌으면 재bind + manifest 재작성
- [x] `recover()` 순차 실행 → 병렬 (`c494f8e`)
      - 정상 2 + 응답없는 holder 3 기준 **30초 → 10초**
- [x] shutdown 저장 순서 역전 + deadline 5s→15s (`2a3e695`)
      - 무거운 snapshot(1.2s)이 먼저, 가벼운 layout(6KB)이 나중이었음
      - deadline 초과 시 layout만 유실 = `b45f036e` 사고 구조
- [x] RFD §9-4 교체 후 mark 유효성 — **조건부 유효**
      - zsh 세션: 교체 전후 버퍼 완전 일치 (3040행 / 240KB), 20000행 출력해도 동일
      - 이유: holder ring(1MB) > 해당 세션의 xterm 사용량(240KB, 행당 79B)
      - agent 세션도 Phase 4에서 실측 완료 — 손실은 바이트 계산보다 훨씬 작음

## Phase 1 — RFD §9 미해결 · 4/5

RFD가 "B 착수 전 해소" 라고 명시한 항목들.

- [x] **Codex alternate screen 사용 여부** — 미사용 확인. B 설계가 갈라지지 않음
      - Claude Code 기준선이 RFD 관측과 일치(`?1049h` 미출현, `?2004h`/`?25l` 출현) → 방법론 유효
      - Codex도 부팅·실제 응답 중 모두 `?1049h`/`?1047h`/`?47h` 미출현
- [x] 스크롤백 소요량 — 긴 응답 1회 = 103행 (3000행의 3.4%, 29회분)
      - Claude 긴 응답 94,065 B → 103행 (913 B/행)
      - Codex 짧은 응답 43,319 B → 39행 (1111 B/행)
      - RFD 6.1의 "응답이 3000행을 넘는다"는 우려는 현실적이지 않음
      - 다만 행당 바이트가 커서 **holder ring(1MB)이 xterm(약 2.7MB)보다 작다** → 아래 재검증
- [ ] "응답"의 경계 정의 — 도구 호출 중간 출력을 transcript에 포함할지 (결정 사항)
      B 구현 중 관측: transcript 끝에 다음 프롬프트 입력창 렌더가 섞인다.
      끝점을 Stop 시점 커서로 잡는 한 TUI가 그 뒤 그리는 것도 들어온다
- [x] 복원된 세션의 mark — Phase 0.5-4에서 해소
- [ ] `workspaces.json` v2→v3 변환 검증 방법 — 무엇과 비교해 검증할지

## Phase 2 — RFD A·B·C · 4/9

셋은 상호 독립. 순서 없음.

### A. layout을 소속의 단일 장부로
- [ ] `sessionIdsToLayout` 재구성 폐기 → 트리 연산 4개 (split/close/resize/move)
- [ ] `layoutVersion` 동시 편집 검출 (버전 불일치 시 409)
- [ ] 판정: 중첩 layout에 세션을 추가·제거해도 형제 서브트리와 sizes가 입력과 동일

### B. interaction과 transcript
- [x] mark 기반 구간 추출 — **xterm marker 사용** (`63a1fce`)
      RFD가 적은 `baseY + cursorY`는 스크롤백이 밀리면 범위 안에 머문 채
      남의 출력을 가리킨다(실측). marker는 `line === -1`로 소실을 알려주므로
      "구간이 사라졌다"와 "구간이 비었다"를 구분할 수 있다
- [x] interaction 리소스를 서버가 소유 (`9849fe8`, `e47d1a0`)
      200/202 + Location, timeout은 pending 유지 → id로 이어받기
- [x] Stop hook 직결 → CLI 1초 폴링 제거 (`e47d1a0`, `735800f`)
      `POST /api/internal/sessions/:id/stop` ← `ttym hook report-stop`
      StopFailure·SessionEnd도 등록 — 실패로 끝난 턴이 ~120ms에 정리됨
      (기존에는 timeout까지 blocking)
- [x] **판정 통과** — 이전 대화가 있는 실제 Claude 세션에서 검증
      transcript는 이번 응답만, 같은 시점 screen은 19행 전체(이전 대화 포함)

### C. runtime / annotations 분리
- [ ] `meta` → `/runtime` (서버 소유, 읽기 전용) + `/annotations` (사용자 소유)
- [ ] 판정: annotations에 임의 키를 쓴 뒤에도 await이 정상 완료

## Phase 3 — RFD D (CLI 표면) · 0/6

A·B 이후. **시작부터 완료까지 클라이언트 3개가 전부 동작하지 않는다** (RFD 6.4).

- [ ] 주소 통일 — `core:claude` / `:claude` / `#42`. slash 2단 폐기
- [ ] `new` · `split` 동사 분리 (배치는 옵션이 아니라 동사)
- [ ] `remove`/`terminate` 중복 제거
- [ ] `client/` 정렬
- [ ] `native/` 정렬 (Tauri — 빌드 체인 별도)
- [ ] `demo/` 정렬 + WS에서 CREATE/LIST/DESTROY 제거

## Phase 4 — 교체 리허설 (dev) · 4/5

- [x] 기본 무중단 교체 실증 — holder·세션 id·자식 pid·화면 내용 전부 보존 (zsh 세션)
- [x] **agent 세션 교체 손실 실측** — 바이트 39.6% 손실 → 행 12.8% 손실
      - 실제 Claude Code 세션, ring을 64KB로 축소해 프로덕션 비율 재현
      - 교체 전 108,464 B / baseY 39 → 교체 후 65,536 B / baseY 34
      - 유실된 내용은 부팅 배너뿐. 대화 내용 25%/50%/75%/끝 전부 생존
      - 이유: 바이트의 대부분이 redraw 파편이라 최종 셀 상태에 기여하지 않음
      - ⚠ 한계: 69행 규모 테스트. 3000행 규모에서 같은 비율인지는 미확인
- [x] **v2 holder ↔ v3 서버 교차 검증** — 4방향 전부 통과
      - v3 서버 ← v2 holder(4/18 프로덕션 빌드) recover ✔, 화면 보존 ✔
      - v2 서버 ← v2 holder ✔ / v2 서버 ← v3 holder ✔ (롤백 방향)
      - 세션 id·자식 pid·화면 내용 전부 보존. 프로토콜 호환 확인
      - v2 서버는 `TTYM_HOME`을 모르므로 검증 시 `HOME` 자체를 격리해야 함
- [x] **롤백 리허설 (v3 → v2)** — 위 검증에 포함. v2 서버가 두 세대 holder를 모두 recover
- [ ] `workspaces.json` v2→v3 변환을 실데이터로 검증
      ⚠ Phase 2-A 의존 — 변환기가 아직 없어 지금은 검증 불가

## Phase 5 — 프로덕션 교체 · 4/5 (2026-08-06 완료)

- [x] `workspaces.json` 백업 — `~/.ttym/pre-v3-swap/`
- [x] holder pid·세션·claude 목록 기록 (교체 후 대조용)
- [x] dist 교체 후 서버 재시작 → **세션 15/16 복구, claude 39/39 생존**
- [x] 대조 및 실동작 검증 — 프로덕션 `await`이 transcript만 반환(4초)
- [ ] 세션 973 처리 — holder는 살아있으나 접근 불가 (아래)

### 교체에서 배운 것

**launchd가 서버를 감시하고 있었다.** `~/Library/LaunchAgents/com.lullu.ttym-server.plist`,
`KeepAlive: true`. `ttym stop`으로 죽이자 launchd가 즉시 새 서버를 띄웠고,
거기에 `ttym start`로 하나를 더 띄워 **두 서버가 경쟁**했다.
holder는 클라이언트를 하나만 받으므로 나중에 붙은 쪽이 세션을 가져갔고,
포트를 잡은 쪽은 세션을 잃었다.

- 올바른 절차: `launchctl kickstart -k gui/$UID/com.lullu.ttym-server`
- `ttym stop` / `ttym start`는 launchd가 관리하지 않을 때만 쓴다

**세션 973을 잃었다.** 경쟁 중 두 서버가 각각 973을 snapshot에서 복원하려
새 holder를 spawn했고, `main.rs:221`의 "clean stale" 이 원본 holder의 소켓을
지웠다. 원본(pid 65568)은 v2 바이너리라 rebind 로직이 없어 스스로 살아나지 못한다.
안의 claude는 지금도 돌고 있지만 도달할 경로가 없다.
`claudeLastSessionId=38e47f4c-…`, cwd=`/Users/lullu` — `claude --resume`으로 대화 복구 가능.

- v3 holder였다면 `570cfcc`의 rebind가 5초 안에 복구했을 상황이다
- 교체 후 새로 만들어지는 holder부터는 이 시나리오에 면역

**CLI 경로를 dev에서 검증하지 않았다.** 엔드포인트는 curl로 확인했지만
CLI가 `fetchRequest`의 반환 구조를 잘못 읽었고(`response.body.interaction`),
소켓 타임아웃이 5초 기본값이라 blocking 요청을 끊었다. 배포 후에야 드러났다.

## Backlog — 미해결로 남은 것 · 0/8

- [ ] run 디렉토리 누적 정리 정책 (snapshot 184 / meta 240 / 19MB, 세션은 16개)
- [ ] `ttym.log` 로테이션 (130MB, 무한 증가)
- [ ] holder ring 크기 결정 (현재 1MB, `--ring-size` 인자는 있으나 서버가 안 넘김)
      Phase 4 실측상 1MB로 충분해 보임 — 행 손실이 바이트 손실의 1/3
      대규모(3000행) 세션에서의 재확인은 남음
- [ ] `TTYM_RUNTIME_DIR`이 긴 경로면 holder가 panic (unix socket SUN_LEN ~104B 초과)
- [ ] holder ring이 ANSI 시퀀스·UTF-8 경계를 무시하고 자름
      vibetunnel은 화면소거 시퀀스 지점에서만, orca는 UTF-8 경계까지 보정
- [ ] agent 훅을 provider registry로 (paseo 방식) — 지금은 Claude Stop 하나에 고정
- [ ] `StopFailure`/`SessionEnd` 미구독 → agent가 실패로 끝나면 await이 timeout까지 대기
- [ ] flaky test 1건 규명 (`b2f615d9`에서 73/73 중 1건 실패 후 재실행 통과)
- [ ] `ttym restart` ESRCH 에러 (`b45f036e`에서 미해결)
- [ ] agent-bus 활성화 여부 결정 (현재 `null`, SQLite 파일만 존재)
