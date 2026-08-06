# ttym

> 🇬🇧 English: [README.md](README.md)

**서버보다 오래 사는 PTY** 위에 세운 터미널 멀티플렉서. 서버를 재시작하거나
교체해도 그 안에서 돌던 에이전트·빌드·ssh는 그대로 이어진다 — 같은 프로세스,
같은 화면.

말뿐인 성질이 아니다: 프로덕션 인스턴스를 한낮에 무중단 교체하며 전 세션이
자식 pid 하나 안 바뀌고 살아남는 것을 반복 실증했다.

```sh
ttym new claude               # 세션 하나 (default workspace 편의 소속)
ttym split :claude logs       # 진짜 split — 중첩과 비율이 유지된다
ttym send :claude -- 'hi'     # PTY에 바이트 전송
ttym await :claude -- '빌드 왜 깨져?'   # 에이전트에 묻고 이번 답만 받기
ttym screen '#42'             # 미소속 세션도 id로 항상 주소 가능
```

## 구성

```
packages/
  web        브라우저 앱             cli        headless 표면 (호환 경계)
  desktop    Tauri 앱               protocol   wire 포맷 — 양끝이 같은 구현
  ui         터미널 컴포넌트          api        두 앱이 공유하는 HTTP 클라이언트
  server     터미널 상태 · 세션 · 워크스페이스 · 에이전트 interaction
  shared     서버와 클라이언트가 합의해야 하는 도메인 규칙
holder/      Rust. 세션당 1개의 detached 프로세스가 PTY를 소유
```

핵심 결정은 holder다: 서버와 unix socket으로만 이어져 있어 **서버가 죽어도
아무것도 따라 죽지 않는다.** 서버는 그 위의 모든 의미 — 셀 그리드·스크롤백·
체크포인트·transcript — 를 소유하고, 재접속 시 마지막 렌더 체크포인트를
깔고 holder에는 그 이후 델타만 요청한다. controller lease가 서버 둘이 한
PTY를 조용히 뺏는 것을 막는다.

Claude Code·Codex 세션은 터미널 위에 request/response를 얹는다:
`ttym await`은 화면 덤프가 아니라 **이번 턴의 transcript만** 돌려주고,
에이전트의 Stop hook이 완료를 알린다 — 실패한 턴은 timeout이 아니라
수 밀리초 안에 정리된다.

## 실행

```sh
pnpm install
./scripts/build.sh          # Rust holder + 서버 번들 + CLI 번들 → dist/
./dist/ttym start           # :7690, 웹 앱 포함
open http://127.0.0.1:7690
```

`pnpm test`는 실제 holder를 spawn하고, wire 프로토콜로 실제 PTY를 구동하며,
프로덕션 런타임 디렉토리의 비식별 캡처를 실규모로 재생한다.

## 문서

- [docs/architecture.md](docs/architecture.md) — 계층, holder 계약, 복구, interaction
- [docs/adr-0001-membership.md](docs/adr-0001-membership.md) — 세션 소속 모델 결정 기록

## 라이선스

당분간 비공개.
