# council 종합 — 네 리뷰의 수렴과 갈림

네 에이전트는 같은 브리핑을 받았고 서로의 답을 보지 못했다.

```
01  계층 경계        holder/서버/프로토콜/클라이언트의 책임 분할
02  반대 논거        v4를 막는 것이 임무
03  상태와 지속성    표현·저장·절단
04  이행 전략        v3의 A·C·D를 언제 어떻게
```

## 1. 네 리뷰가 수렴한 것

### v4를 "새 세대 재설계"로 세우지 말 것

02가 가장 강하게, 04가 이행 관점에서 같은 결론에 이른다.

- building block의 가치는 **독립 배포 소비자**가 있을 때 생긴다. 지금 0명이다
- 클라이언트 전부가 같은 저장소에 있어 인터페이스 변경을 한 커밋에 원자적으로 반영할 수 있다
- 조사한 8개 프로젝트가 요구사항을 공급하고 있다 — paseo에 셀이 있고 orca에 GC가 있다는 사실은
  ttym에 그것이 필요하다는 근거가 아니다
- v2 실패 조건(완료 기준 없는 목표, 축이 전부 미정, 수직 절편 부재)이 지금도 갖춰져 있다
- **AI 인력은 제동장치를 제거한다**: 구현 0% 대신 구현 80%짜리 잘못된 플랫폼

02의 판별식 — 이 셋이 **모두** 참일 때만 v4를 한다.
```
1. 이름과 소유자가 있는 독립 배포 소비자 또는 대체 구현이 실재하고
2. 그 요구가 안정된 CLI/HTTP 어댑터로 충족되지 않으며
3. 수직 절편을 기존 프로덕션과 dual-run해 무손실 롤백할 수 있음이 증명됐을 때
```
"향후 native 앱", "언젠가 외부 사용"은 존재로 세지 않는다.

### building block의 실질은 안정된 CLI 계약이다

플러그인 API도, holder 프로토콜 공개도 아니다.
```
비대화형 세션 생성·열거·조회·입력·resize·종료
스크립트가 판별 가능한 exit code와 구조화 출력
세션 ID와 주소의 안정된 의미
attach가 끊겨도 holder가 사는 lifecycle 계약
CLI와 서버의 버전 불일치 시 명시적 오류
이 계약을 검증하는 e2e 테스트
```
**CLI를 호환 경계로 두면 내부 프로토콜과 상태 표현은 계속 바꿀 수 있다.**

### holder는 셀을 몰라야 한다 (01·03 독립 수렴)

01이 든 반대 근거:
- 대체 holder가 wide char·combining·OSC 8·synchronized output·reflow까지 구현해야 한다
- 브라우저는 계속 xterm을 쓴다. Rust 셀 결과와 xterm 렌더가 갈리면 정답을 정해야 한다
- holder는 41일씩 산다. 구형 holder마다 다른 parser dialect가 남는다
- 100×3000 셀 × 16바이트 = 4.8MB. 현재 560KB~1.2MB의 한 자릿수 이상

재검토 조건: *"서버가 무기한 내려가 있고 출력은 계속 발생해도, 고정된 저장 한도 안에서
정확한 최신 화면과 스크롤백을 반드시 복구해야 한다"* — 지금 이 요구는 없다.

### 저장소 플러그인화 반대 (03)

ring / cast / 셀 스냅샷은 대체재가 아니라 목적이 다르다.
```
holder raw ring     서버 중단 구간을 메우는 복구 로그      임시
서버 headless xterm 현재 렌더링된 셀 상태                런타임 권위
디스크 checkpoint   셀 상태의 영속 체크포인트              영속
asciinema cast      선택적 녹화·재생                      복구에 안 씀
```
플러그인 인터페이스를 만들면 atomic checkpoint·offset 연속성·generation 검증·GC·
포맷 마이그레이션·부분 손상 처리까지 계약해야 한다. 구현체가 하나뿐인데 계약을 먼저
고정하면 내부 개선마다 호환성이 발목을 잡는다.

## 2. 가장 값진 발견 — 이미 있는 자산을 버리고 있다

03이 짚었다. `session-manager.ts:188`이 **holder가 살아 있으면 디스크 스냅샷을 폐기**하고,
`session.ts:302`가 빈 xterm에 holder의 1MB DUMP만 재생한다.

```
디스크 체크포인트   571KB에 3000행   (이미 주기적으로 쓰고 있음)
holder raw ring     1MB에 약 1100행  (교체 시 이것만 씀)
```

**둘은 결합된 게 아니라 배타적이다.** 더 크고 정확한 것을 의도적으로 버리고 작은 것만 쓴다.

고치면 ring 크기 문제 자체가 사라진다 — 체크포인트가 과거를 담당하고 ring은
마지막 체크포인트 이후의 짧은 공백만 담당한다. 새 저장소를 만들 필요가 없다.

## 3. 오늘 겪은 사고의 근본 원인 (01)

> "현재는 새 접속이 기존 서버를 조용히 축출한다. 이것은 교체 가능성이 아니라 **split-brain 위험**이다."

오늘 launchd 서버와 수동 서버가 경쟁해 세션 973을 잃은 것이 정확히 이 메커니즘이다.
01의 처방:
```
ACQUIRE_CONTROLLER { serverInstanceId, expectedHolderIncarnation, takeover: bool }
- 기본 접속은 기존 controller가 있으면 실패
- takeover는 명시적으로만
- 성공 시 lease generation 발급, 이전 controller의 입력·resize는 fencing
```

## 4. 임의 절단 — 손실량이 아니라 침묵이 문제 (03)

측정상 손실은 작다(바이트 39.6% → 행 12.8%). 그럼에도 임의 절단을 유지하면 안 되는 이유는
**깨졌다는 사실을 알 수 없다**는 것이다. UTF-8 continuation, CSI/OSC/DCS 중간, hyperlink
payload 중간에서 잘리면 영향이 여러 행으로 번질 수 있다.

우열:
```
정확한 checkpoint offset + 연속 delta
  > parser-ground 의미 경계
  > screen-clear 경계 (vibetunnel)
  > UTF-8 경계 (orca)
  > 임의 바이트 (ttym)
```
vibetunnel의 screen-clear 경계도 완전하지 않다 — `ED 2`/`ED 3`은 SGR·cursor mode·
scroll region·charset을 초기화하지 않는다. **정상 경로에서는 절단 위치를 찾지 말고
체크포인트 offset부터 이어야 한다.** 안전 anchor 탐색은 overflow fallback에서만.

연속성이 깨졌으면 raw tail을 정상 스냅샷처럼 내보내지 말고 `degraded`로 강등한다.

## 5. wrap flag는 지금 넣어야 한다 (03)

3000행의 wrap 여부는 bitset으로 **약 375바이트**. 571KB 체크포인트 대비 비용이 사실상 없다.
안 넣으면 resize 시 되돌릴 수 없는 정보 손실이다. 셀 프로토콜로 바꿀 때도 같은 필드가 남는다.

## 6. A를 쪼개라 (04)

```
A-1  트리 평탄화 버그 수정 (순수 연산 교체)        즉시   폐기 확률 15%
A-2  소속 모델 변경 (members[] → layout leaf)     보류   v4가 버릴 가능성 높음
```

A-2가 위험한 이유: "workspace 소속 세션은 반드시 pane에 보인다"를 불변식으로 승격하면
배치 없는 세션·클라이언트별 뷰·최소화 상태가 전부 닫힌다. **headless building block을
지향하면서 headless 세션을 금지하는 셈이다.**

A-2 전에 답해야 할 네 질문:
```
세션과 workspace의 cardinality가 정말 항상 1:N인가?
workspace 소속 세션은 반드시 layout leaf여야 하는가?
layout은 서버 전역 문서인가, 클라이언트별 view인가?
name·role·tags는 session 속성인가, membership 속성인가?
```
하나라도 미확정이면 v2→v3 변환을 하지 않는다. **v2→v3→v4 두 번보다 v2→v4 한 번이 우월하다.**

## 7. D는 rollout layer이지 선행 조건이 아니다 (04)

> "세 클라이언트가 동시에 깨지는 구간은 받아들일 조건이 아니라 설계 결함이다."

서버는 이미 HTTP와 WS 양쪽으로 세션 lifecycle을 지원한다. 동시에 깨뜨릴 기술적 이유가 없다.
```
D-transport  공용 client adapter, HTTP lifecycle로 하나씩 이전    지금 가능
D-semantic   주소 문법·new/split·remove/detach/terminate 구분     소속 모델 확정 후
             지금 시작하면 폐기 확률 65%
```

## 8. point of no return의 재정의 (04)

> "변환기를 실행하는 순간이 아니라, **v3로 표현할 수 없는 첫 v4 전용 mutation을
> 프로덕션에 기록하는 순간**이다."

그 전까지는 shadow projection으로 v4 형태를 병행 검증할 수 있다.

## 9. 갈린 지점

**holder 프로토콜 공개**
- 02: 다른 구현자가 없으므로 순수 비용. 하지 말 것
- 01: 교체 가능하려면 wire spec만으로 부족하다 — lifecycle/discovery/manifest schema/
  controller lease/conformance suite까지 공개 계약이어야 한다
- 04: capability negotiation은 필요하되 전역 version이 아니라 기능별

절충: **협상 대상을 holder↔서버가 아니라 서버↔클라이언트로 둔다.** holder 쪽은 내부
구현으로 남기되, 오늘 실제로 물린 두 가지(controller lease, checkpoint offset)만
additive하게 넣는다. 공개 계약화와 conformance suite는 대체 구현이 실재할 때.

## 10. 종합 실행 순서

폐기 확률(04 추정)과 실증된 통증을 함께 본 결과.

```
Tier 1 — 지금. 실증된 결함이고 어느 설계에서도 남는다
  1. A-1 트리 평탄화 수정              폐기 15%  프로덕션 7/7 손상 실측
  2. controller lease (takeover 명시)   폐기 낮음  오늘 973 상실의 근본 원인
  3. checkpoint + delta 복구            폐기 낮음  이미 있는 571KB 자산을 버리는 중
     └ holder에 DUMP_SINCE(offset) 추가 (additive, 구 DUMP 유지)
     └ 체크포인트에 appliedThroughOffset + wrapFlags 기록
  4. reconcile을 삭제기에서 검증기로     폐기 20%  이름·role을 조용히 버리는 중

Tier 2 — 곧. 소유권 분리이며 URL보다 타입이 먼저
  5. C 내부 타입 분리                   폐기 10%
  6. C additive endpoint (/meta 유지)   폐기 20%
  7. 프로덕션 fixture 고정               폐기 5%

Tier 3 — 소속 모델 ADR 이후
  8. 소속 모델 ADR (§6의 네 질문만)     폐기 10%
  9. D-transport (공용 adapter)         폐기 20%
 10. shadow projection 검증             폐기 25%
 11. D-semantic                        폐기 20% (ADR 전 착수 시 65%)

하지 않을 것
  holder 셀 에뮬레이션        요구가 아직 없다
  저장소 플러그인 API         두 번째 구현체가 없다
  전면 재설계 / v4 트랙       판별식 미충족
```

## 11. 내 잠정 결론 중 교정된 것

```
나의 주장                        교정                                    출처
────────────────────────────────────────────────────────────────────────────
"A를 미루자"                     A-1은 즉시, A-2만 보류                  04
"holder 프로토콜 버전 협상 먼저"   소비자가 없다. 필요한 건 lease와 offset  01·02
"D를 앞으로 당기자"               D-transport만. D-semantic은 65% 폐기    04
"v4는 계약 확립"                  계약은 CLI 하나면 된다                   02
"체크포인트를 holder에 맡기자"     디스크에 이미 있다. 버리지만 말면 된다     03
```

살아남은 것: **"재설계에 영향 덜 받는 것부터"라는 기준.** 04가 이를 작업별 폐기 확률로
정량화했고, 네 리뷰 모두 그 기준 자체는 지지한다.
