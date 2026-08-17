#!/usr/bin/env node
/**
 * ttym-glyphs.woff2 를 만든다. 두 글자만 들어 있다.
 *
 *   U+23FA ⏺  BLACK CIRCLE FOR RECORD
 *   U+23F5 ⏵  BLACK MEDIUM RIGHT-POINTING TRIANGLE
 *
 * 왜 필요한가. 안드로이드에는 이 둘을 가진 고정폭 폰트가 없다. U+23FA는
 * 컬러 이모지로 폴백해 1.96셀 폭으로 그려져 다음 칸을 덮고, U+23F5는 글리프가
 * 아예 없어 빈칸이 된다(S24+ 실측). 둘 다 Claude Code가 쓰는 기호다.
 * 유니코드상 둘 다 Neutral(1셀)이라 xterm 계산은 맞고, 폰트만 없는 상황이다.
 *
 * 남의 폰트를 잘라 쓰면 라이선스가 걸리니 두 도형을 직접 그린다. 원과 삼각형뿐이라
 * 손으로 그려도 된다. advance는 0.5em — 터미널이 쓰는 D2Coding의 셀 폭 실측치(14px에서 7px)다.
 *
 * 실행: node scripts/build-glyph-font.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../packages/web/public/ttym-glyphs.woff2');
mkdirSync(dirname(out), { recursive: true });

const py = `
import sys, math
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPM = 1000
ADV = 500          # 0.5em — 터미널 폰트(D2Coding) 셀 폭 실측치(14px에서 7px)
CX, CY = 250, 290  # 셀 안에서의 시각 중심

fb = FontBuilder(UPM, isTTF=True)
order = ['.notdef', 'uni23FA', 'uni23F5']
fb.setupGlyphOrder(order)
fb.setupCharacterMap({0x23FA: 'uni23FA', 0x23F5: 'uni23F5'})

pens = {}

# .notdef — 비워 둔다
p = TTGlyphPen(None); pens['.notdef'] = p.glyph()

# U+23FA 채워진 원. TrueType은 2차 베지어만 쓰므로 45도씩 8조각으로 근사한다.
# 각 조각의 제어점은 두 접선이 만나는 곳 — 중심각 절반의 cos로 밀어낸 거리다.
R = 195
SEG = 8
step = 2 * math.pi / SEG
ext = R / math.cos(step / 2)
pt = lambda a, r: (round(CX + r * math.cos(a)), round(CY + r * math.sin(a)))
p = TTGlyphPen(None)
p.moveTo(pt(0, R))
for i in range(SEG):
    a0 = i * step
    p.qCurveTo(pt(a0 + step / 2, ext), pt(a0 + step, R))
p.closePath()
pens['uni23FA'] = p.glyph()

# U+23F5 오른쪽 삼각형. 원과 시각 무게를 맞춘다.
H = 210
p = TTGlyphPen(None)
p.moveTo((CX - 148, CY + H))
p.lineTo((CX + 172, CY))
p.lineTo((CX - 148, CY - H))
p.closePath()
pens['uni23F5'] = p.glyph()

fb.setupGlyf(pens)
fb.setupHorizontalMetrics({g: (ADV, 0) for g in order})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({
    'familyName': 'ttym glyphs',
    'styleName': 'Regular',
    'psName': 'ttymglyphs-Regular',
    'version': '1.0',
    'copyright': 'Public domain. Two shapes drawn for ttym.',
})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.font.flavor = 'woff2'
fb.save(sys.argv[1])
`;

execFileSync('python3', ['-c', py, out], { stdio: 'inherit' });
const size = (await import('node:fs')).statSync(out).size;
console.log(`${out}  ${size} bytes`);
