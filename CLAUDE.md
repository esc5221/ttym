# ttym

웹 기반 터미널 멀티플렉서. 서버가 PTY 세션을 관리하고, workspace 단위로 여러 멤버(터미널/에이전트)를 묶어 협업·자동화한다.

## 구조

```
bin/ttym           CLI (Node ESM, 직접 실행)
server/src/        서버 (TypeScript → dist/ttym-server.js)
client/            웹 클라이언트 (@ttym/client)
native/            네이티브 앱 (@ttym/native)
demo/              데모 앱 (@ttym/demo)
scripts/           hook 스크립트들
```

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
ttym workspace send --current runner -- $'echo hello\n'

# Claude/Codex TUI에는 텍스트 + \r (두 번 나눠 보내기)
ttym workspace send --current claude-sub -- $'프롬프트 내용'
ttym workspace send --current claude-sub -- $'\r'
```

핵심: 인터랙티브 TUI(raw mode)는 Enter = CR(0x0d). 일반 쉘은 LF(0x0a).

send API(`POST /api/sessions/:id/send`)는 `Buffer.from(data)` — 이스케이프 해석 없이 문자열을 그대로 바이트로 전달. 따라서:
- CLI에서: `$'\r'` 또는 `$'\x0d'`로 실제 CR 바이트를 보내야 함
- Claude Code Bash tool 환경에서는 `$'...'` ANSI-C quoting이 안 될 수 있음. 이 경우 `printf '\r'` 파이프 등 우회 필요
- await 명령은 `\r` 자동 append 내장 (payload에 CR/LF 없으면 `\r` 추가)

### await (request-response, Claude 전용)

프롬프트 보내고 응답 완료까지 blocking 대기. `\r` 자동 append — 직접 붙일 필요 없음.

```sh
ttym workspace await --current claude-sub --json -- '질문'
ttym workspace await --current claude-sub --json --raw -- '질문'       # ANSI 원본
ttym workspace await --current claude-sub --timeout 60000 --json -- '질문'
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

### Fully Qualified Address

`project/workspace` 형태로 다른 workspace 멤버 접근:
```sh
ttym workspace send demo/onboard claude-sub -- $'hello\r'
ttym workspace screen demo/onboard claude-sub --json
```

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
