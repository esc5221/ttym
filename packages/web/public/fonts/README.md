# 번들 webfont

서버가 same-origin으로 서빙한다. 등록은 `packages/ui/src/terminal-host.ts`의
`BUNDLED_FONTS`가 하고, **폰트 스택에 이름이 등장할 때만** FontFace를 만든다 —
쓰이지 않는 폰트는 바이트 하나 내려받지 않는다.

## Monoplex KR Nerd (기본, 맥 외 플랫폼)

- 출처: [y-kim/monoplex](https://github.com/y-kim/monoplex) v0.0.2 릴리스의 TTF를
  woff2로 포맷 변환 (fontTools). 글리프는 손대지 않았다 — 서브셋팅을 하면
  OFL의 Reserved Font Name 조항상 "Monoplex" 이름을 쓸 수 없게 된다.
- 라이선스: SIL Open Font License 1.1 — 전문은 `MonoplexKR-LICENSE.md`.
  소프트웨어와 함께 번들·재배포 허용, 폰트만 따로 판매하는 것만 금지.
  Reserved Font Name: "Monoplex", "Monoplex KR".
- 원본: IBM Plex Mono + IBM Plex Sans KR (양쪽 다 OFL 1.1).
- 실측 메트릭: upm 1000, 라틴 528 / 한글 1056 — **정확히 2:1**. 터미널에서
  한글이 섞여도 열이 어긋나지 않는 이유가 이것이다.
- Nerd 심볼 포함 (powerline U+E0B0, material 등) — 프롬프트 테마가 깨지지 않는다.
- 웨이트는 400·700만 번들한다. xterm이 쓰는 것이 그 둘이고, 8웨이트 전부는 6MB다.

## D2Coding (폴백)

- 출처: 네이버 [naver/d2codingfont](https://github.com/naver/d2codingfont) (webfont 빌드: npm `d2coding` 1.3.2)
- 라이선스: SIL Open Font License 1.1

## 맥이 예외인 이유

맥의 기본은 시스템 폰트 Menlo다. 다운로드가 없고, 기존 사용자의 화면이 그대로
유지된다. 다만 맥에서도 설정(`font-family`)으로 Monoplex를 고르면 그때 등록되어
정상 동작한다 — 등록이 스택을 보고 이뤄지기 때문이다.
