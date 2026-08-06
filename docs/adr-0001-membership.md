# ADR-0001 — 세션은 어디에 속하는가

- 상태: **승인됨** (2026-08-06)
- 결정 범위: 저장 포맷·주소 체계·동사 설계의 전제가 되는 소속 모델

표면을 바꾸기 전에 닫아야 했던 네 가지 결정. 규칙은 *하나라도 미확정이면
저장 포맷을 바꾸지 않는다*였다.

## 결정

```
session      독립 존재. id·cmd·geometry·runtime을 가짐. 이름은 없음
workspace    session에 대한 참조(membership)의 컨테이너
membership   name(workspace 안에서 유일)·role·tags. 배치와 독립
layout       membership의 부분집합을 배치하는 표현. workspace당 하나
불변식        leaf ⊆ members   (유령 pane 금지 — 위반 시 member 자동 생성)
             members ⊄ leaf 허용 (미배치 = headless/최소화. 진단만 남김)
```

## 네 질문과 답

**Q1. 세션 : workspace — 정확히 1인가?** → **0 또는 1.**
`POST /api/sessions`는 소속 없이 세션을 만들고, 실제 배포에도 미소속 세션이
존재해 왔다. "정확히 1"은 그 위에 default workspace라는 장부를 덧씌울 뿐
정보를 더하지 않는다. 스크립트가 세션을 띄워 쓰고 버리는 headless 경로에
workspace 의례가 없어야 한다. `ttym new`가 이름을 갖는 것은 CLI가 default
workspace에 넣어주는 **편의**이지 저장 모델의 불변식이 아니다.

**Q2. 소속 세션은 반드시 layout leaf여야 하는가?** → **아니오.**
layout을 유일한 장부로 승격하면(RFD 1의 A-2) 배치 없는 세션·최소화·나중
배치가 전부 불가능해진다 — headless를 지향하면서 headless 세션을 금지하는
자기모순. `members[]`가 장부, layout은 표현이다. 이 답은 새 설계가 아니라
이미 구현된 동작의 승인이다: 모든 mutation이 두 장부를 한 연산에서 함께
갱신하고, 미배치 member는 삭제 대신 보존+진단된다.

**Q3. layout — 서버 전역 문서인가, 클라이언트별 view인가?** → **workspace당 하나.**
실제로 아팠던 것은 layout 파괴(트리 평탄화)였지 클라이언트 간 경합이 아니다.
줌·일시 최대화 같은 표시 상태는 클라이언트 로컬로 두고 저장하지 않는다.

**Q4. name·role·tags — session 속성인가 membership 속성인가?** → **membership.**
이름의 유일성 범위가 workspace이므로 속성도 거기 산다. 미소속 세션은
`#id`로만 주소된다. 현 저장 구조가 이미 이렇게 돼 있어 마이그레이션 비용 0.

## 귀결

- **RFD 1의 A-2(소속 모델 변경)는 폐기.** 따라서 `workspaces.json`의
  일방향 v2→v3 변환도 취소된다 — 롤백 경로가 영구히 열려 있다.
  v2 왕복은 프로덕션 fixture 테스트가 회귀로 고정한다.
- 주소 체계: `ws:name`은 membership을 해석하고 `#id`는 세션을 직접
  가리킨다. `new`(소속은 편의)와 `split`(배치 동반)의 의미가 여기서 갈린다.

## 명시적으로 닫은 문

세션의 다중 workspace 표시(Q1) · layout의 클라이언트별 저장(Q3) ·
layout의 유일 장부 승격(Q2). 재개 조건은 셋 다 같다:
**독립 배포된 두 번째 소비자의 실재하는 요구.**
