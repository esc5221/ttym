// Renders the social card and PNG icons: node scripts/brand/make-cards.mjs (needs playwright + Chrome)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../site/brand');
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1280, height: 640 } });
await p.goto('file://' + resolve(here, 'og.html'));
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: resolve(out, 'og.png') });
for (const [name, size] of [['apple-touch-icon.png', 180], ['favicon-32.png', 32]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0}</style><img src="file://${resolve(out, 'favicon.svg')}" width="${size}" height="${size}">`);
  await p.screenshot({ path: resolve(out, name), omitBackground: true });
}
await b.close();
console.log('og.png, apple-touch-icon.png, favicon-32.png');
