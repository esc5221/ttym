#!/usr/bin/env node
// 폰 화면 검증용 브라우저를 띄우고 그대로 열어둔다.
// 닫으려면 이 프로세스를 종료하면 된다.
//
//   node scripts/phone-preview.mjs [workspaceId]
//
// localStorage의 ttym-surface=phone 을 심어서, 데스크톱 크롬으로도 폰 경로를
// 타게 만든다. hasTouch/isMobile은 pointer:coarse까지 흉내내지만 강제 지정을
// 함께 걸어두면 뷰포트를 넓혀 봐도 폰 화면이 유지된다.

import { chromium } from 'playwright';

const WS = process.argv[2] ?? '16b5cfdf';
const BASE = process.env.TTYM_UI ?? 'http://127.0.0.1:7690';

// Galaxy S24+ 는 playwright 프리셋에 없다(S24만 있고 그건 360x780/DPR3).
// S24+ 는 물리 1440x3120에 DPR 3.5라 CSS 뷰포트가 411x891이 된다.
const S24_PLUS = {
  viewport: { width: 411, height: 891 },
  deviceScaleFactor: 3.5,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S926B) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/145.0.7632.6 Mobile Safari/537.36',
};

// 411 CSS px는 맥 화면에서 폭의 1/4밖에 안 된다. 실제 S24+는 같은 411을
// 6.7인치에 채우고 DPR 3.5로 그리니 물리적으로 훨씬 크다. force-device-scale-factor는
// 레이아웃 계산은 411 그대로 두고 표시 배율만 올린다 — 폰 화면을 확대경으로
// 들여다보는 셈이라, 뷰포트를 키워 레이아웃을 바꿔버리는 것과는 다르다.
const SCALE = Number(process.env.PREVIEW_SCALE ?? 2);

const browser = await chromium.launch({
  headless: false,
  args: [
    '--window-position=40,40',
    `--force-device-scale-factor=${SCALE}`,
    '--high-dpi-support=1',
  ],
});

const ctx = await browser.newContext({
  ...S24_PLUS,
  ignoreHTTPSErrors: true,
});

await ctx.addInitScript(() => {
  try { localStorage.setItem('ttym-surface', 'phone'); } catch {}
});

const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [브라우저 오류]', m.text());
});
page.on('pageerror', (e) => console.log('  [페이지 예외]', e.message));

const url = `${BASE}/#w/${WS}`;
await page.goto(url, { waitUntil: 'domcontentloaded' });

const vp = page.viewportSize();
console.log(`띄웠다: ${url}`);
console.log(`뷰포트 ${vp.width}x${vp.height} · Galaxy S24+ · ${SCALE}배 확대 · surface=phone 강제`);
console.log('');
console.log('  카드를 탭하면 전체화면, 좌우 스와이프로 옆 pane, ‹ list 로 복귀');
console.log('  더 크게: PREVIEW_SCALE=2.5 node scripts/phone-preview.mjs');
console.log('  다른 workspace: node scripts/phone-preview.mjs <id>');
console.log('');
console.log('종료하려면 Ctrl-C. 그때까지 브라우저는 열려 있다.');

// 브라우저를 닫지 않고 붙잡아 둔다
await new Promise(() => {});
