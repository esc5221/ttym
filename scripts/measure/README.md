# scripts/measure

RFD 1과 ROADMAP-v3.md가 인용하는 관측을 재현하는 도구들.
전부 dev holder를 직접 띄워 동작하므로 실행 중인 서버에 영향이 없다.

빌드된 holder가 필요하다: `./scripts/build.sh`

## capture-pty.mjs

PTY를 통과하는 원시 바이트를 그대로 저장한다. 렌더된 화면으로는 볼 수 없는 것
— TUI가 실제로 어떤 제어 시퀀스를 내보내는지 — 을 확인할 때 쓴다.

```sh
# 부팅 화면만
node scripts/measure/capture-pty.mjs /tmp/codex.bin 16 -- codex

# 실제 응답까지 (8초 뒤 프롬프트 제출 + CR)
node scripts/measure/capture-pty.mjs /tmp/claude.bin 100 \
  --prompt "CFS 스케줄러를 길게 설명해줘" -- claude --dangerously-skip-permissions
```

alternate screen 사용 여부는 `ESC[?1049h` / `?1047h` / `?47h` 출현으로 판정한다.
Claude Code와 Codex 모두 미사용 — RFD §9의 미해결 항목이 이렇게 닫혔다.

## swap-loss.mjs + compare-buffers.mjs

서버 교체가 세션 버퍼에서 무엇을 앗아가는지 측정한다.

holder는 서버보다 오래 살아남으므로, 서버를 재시작하면 화면은 실시간 스트림이
아니라 holder ring의 DUMP로 재구성된다. 두 스트림을 모두 받아 비교한다.

```sh
node scripts/measure/swap-loss.mjs /tmp/agent 65536 \
  '["긴 질문 1","긴 질문 2"]' -- claude --dangerously-skip-permissions

node scripts/measure/compare-buffers.mjs /tmp/agent
```

live 스트림은 이 도구가 접속한 시점부터, DUMP는 세션 시작부터 담긴다. 그래서 출력이
짧은 세션에서는 손실이 음수로 나온다 — ring이 아직 안 찼다는 뜻이고, 측정이
의미를 갖는 것은 ring을 넘긴 뒤부터다.

`--ring-size`를 작게 주면 큰 세션의 ring 대 스크롤백 비율을 짧은 시간에 재현할 수
있다. 실측에서는 바이트를 39.6% 잃어도 렌더된 행은 12.8%만 줄었고, 사라진 것은
부팅 배너뿐이었다. 바이트 기준 계산은 손실을 과대평가한다.

### 실제 교체 전 dry run

살아있는 holder에서 DUMP만 받아 교체 후 화면을 미리 볼 수 있다.

```sh
node scripts/measure/swap-loss.mjs /tmp/probe --attach ~/.ttym/run/session-994.sock
```

**주의**: holder는 한 번에 한 클라이언트만 받는다. 접속하면 지금 붙어 있는 서버가
밀려난다. 건드려도 되는 세션에만 쓸 것.
