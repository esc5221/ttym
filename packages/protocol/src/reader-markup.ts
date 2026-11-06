/**
 * The reader's answer markup, as the text an agent is given.
 *
 * `ttym guide markup` prints it and the SessionStart hook hands it to Claude Code through the server, so
 * both come from this one string and move with the renderer (web/src/reader/kit.ts) instead of a copy
 * in someone's CLAUDE.md. Variants (`@name` in a header) are left out on purpose: the default drawing is
 * the one to use unless a person asks for another.
 */

export const READER_MARKUP_GUIDE = `# 답변 마크업 (ttym reader)

이 pane의 reader가 아래 블록을 그림으로 그린다. 계획·현황·결과·비교·결정을 말할 때만 쓰고, 평소 대화와 짧은 답에는 쓰지 않는다. 블록 밖은 평범한 마크다운이다. HTML은 쓰지 않는다.

블록은 \`:::종류\` 로 열고 \`:::\` 로 닫는다. 줄은 \`- 칸1 | 칸2 | 칸3\` 이다.

:::summary          이름 | 설명 목록. - 제목 | 본문
:::flow             단계. - [ok] 이름 | 상세
:::decide 질문      선택지. - A안 (추천) | 설명 | 감수할 것
:::stats            큰 숫자. - 65분 → 2분 | 어떻게 쟀나
:::bars base=500    막대. - 이름: 573ms  (강조할 하나는 줄 끝에 (강조)). 전후는 - 이름: 351 → 180초
:::stack            한 막대를 나눔. - 이름: 컴파일 168 | 배포 183
:::tree             들여쓰기 2칸이 한 단계. - [new] src/kit.ts | 설명
:::timeline         - 10/30 | 일어난 일
:::board            ## 묶음 제목 아래 - 항목 | do·decide·running·stalled·done·wait | 내용
:::layers           ## 층 이름 아래 - 항목 | 설명, 층 사이는 ~ 경계 이름
:::seq 가 | 나 | 다  - 가 -> 나 : 요청  (점선 응답은 -->)
:::vs 지금 | 바뀜   두 칸. 왼쪽 마크다운, 줄 하나에 ---, 오른쪽 마크다운 (칸 3개 이상은 :::cols)
:::note warn 제목   info | ok | warn | risk. 안은 마크다운
:::fold 제목        접힘. 안에 다른 블록을 넣으면 바깥 fold를 ::::(콜론 4개)로 연다
:::table 제목       안은 마크다운 표

상태 태그는 어느 글에나 붙인다: [ok] 끝남, [run] 진행 중, [new] 새로 생김, [chg] 있던 것을 고침, [todo] 아직, [have] 원래 있음, [risk] 위험, [warn] 주의.
근거 태그: [실측] 직접 재서 안 값, [코드] 코드·문서에서 읽음, [추정], [미확인]. 출처는 태그 안에 쓴다: [코드: roster-state.ts], [실측: 3회 평균]. 믿음이 갈리는 값에만 붙인다.

규칙: 색은 상태만 뜻한다. 한 블록에 항목 5개를 넘기지 않는다. 칸 하나는 한 문장이다(길면 블록 밖 문단으로 뺀다). 칸 수는 summary·flow·stats·tree·timeline·layers 2칸, decide 3칸, board 4칸까지다. 단계에 번호를 직접 붙이지 않는다(자동으로 붙는다). stats의 큰 숫자 칸은 짧게(\`192 → 10번\`). 결론을 맨 위에 둔다.
`;

/** Config \`reader-markup\`: on unless written off. Same spelling of "off" as \`agent-sleep-after\`. */
export function readerMarkupEnabled(values: Record<string, string | undefined>): boolean {
  const raw = values['reader-markup'];
  return !(typeof raw === 'string' && /^(off|never|no|0|false)$/i.test(raw.trim()));
}
