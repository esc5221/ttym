# ttym v3 — 실행 로드맵

RFD 1 (`rfd-0001-ttym-v3.html`)의 A·B·C·D를 실제로 착수하기 위한 작업 목록.
Phase 0/0.5는 RFD에 없다 — 프로덕션을 켜둔 채 개발하기 위한 격리와,
과거 세션 조사 중 발견된 교체 안전성 문제에서 나왔다.

제약: **프로덕션 서버(port 7690, pid 2713)는 Phase 5까지 절대 정지하지 않는다.**
개발·검증은 전부 dev 서버(port 7691, `~/.ttym-dev`, worktree `~/study/ttym-v3`)에서 한다.

진행: **18/44 (41%)**

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
      - 교체 전후 버퍼 완전 일치 (3040행 / 240KB), 20000행 출력해도 동일
      - 이유: holder ring(1MB) > xterm scrollback(3000행 ≈ 240KB)
      - 손익분기 행당 350 bytes. 프로덕션 실측 161~194 bytes → 마진 2배 미만

## Phase 1 — RFD §9 미해결 · 2/5

RFD가 "B 착수 전 해소" 라고 명시한 항목들.

- [ ] **Codex alternate screen 사용 여부** ← 다음. 15분
      쓴다면 B의 mark 방식이 에이전트별로 갈라진다
- [~] 스크롤백 소요량 — 행당 161~194B 측정됨. 응답 1회분이 3000행 중 얼마인지 미측정
- [ ] "응답"의 경계 정의 — 도구 호출 중간 출력을 transcript에 포함할지 (결정 사항)
- [x] 복원된 세션의 mark — Phase 0.5-4에서 해소
- [ ] `workspaces.json` v2→v3 변환 검증 방법 — 무엇과 비교해 검증할지

## Phase 2 — RFD A·B·C · 0/9

셋은 상호 독립. 순서 없음.

### A. layout을 소속의 단일 장부로
- [ ] `sessionIdsToLayout` 재구성 폐기 → 트리 연산 4개 (split/close/resize/move)
- [ ] `layoutVersion` 동시 편집 검출 (버전 불일치 시 409)
- [ ] 판정: 중첩 layout에 세션을 추가·제거해도 형제 서브트리와 sizes가 입력과 동일

### B. interaction과 transcript
- [ ] mark 기반 구간 추출 (`baseY + cursorY`)
- [ ] interaction 리소스를 서버가 소유 (200/202 + Location으로 이어받기)
- [ ] Stop hook 직결 → CLI 1초 폴링 제거
- [ ] 판정: 이전 대화가 있는 세션의 await 반환값이 이번 요청의 출력만 포함

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

## Phase 4 — 교체 리허설 (dev) · 1/4

- [x] 기본 무중단 교체 실증 — holder·세션 id·자식 pid·화면 내용 전부 보존
- [ ] v2 holder ↔ v3 서버 교차 검증 (프로덕션의 살아있는 holder는 구 바이너리)
- [ ] `workspaces.json` v2→v3 변환을 실데이터로 검증
- [ ] 롤백 리허설 (v3 → v2 되돌리기)

## Phase 5 — 프로덕션 교체 · 0/5

- [ ] `workspaces.json` 백업 (RFD 6.2 — 일방향 변환, 롤백 경로 없음)
- [ ] holder pid 16개 기록 (교체 후 대조용)
- [ ] `kill -TERM 2713` → v3 서버 start
- [ ] 대조: holder 16 / 세션 16 / claude 인스턴스 생존
- [ ] 실패 시 롤백 절차 실행

## Backlog — 미해결로 남은 것

- [ ] run 디렉토리 누적 정리 정책 (snapshot 184 / meta 240 / 19MB, 세션은 16개)
- [ ] `ttym.log` 로테이션 (130MB, 무한 증가)
- [ ] holder ring 크기 결정 (현재 1MB, `--ring-size` 인자는 있으나 서버가 안 넘김)
- [ ] flaky test 1건 규명 (`b2f615d9`에서 73/73 중 1건 실패 후 재실행 통과)
- [ ] `ttym restart` ESRCH 에러 (`b45f036e`에서 미해결)
- [ ] agent-bus 활성화 여부 결정 (현재 `null`, SQLite 파일만 존재)
