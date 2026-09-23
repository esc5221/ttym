// Renders the social cards and PNG icons: node scripts/brand/make-cards.mjs (needs playwright + Chrome)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../site/brand');
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1280, height: 640 } });
for (const [src, dst] of [['og.html', 'og.png'], ['og-internals.html', 'og-internals.png']]) {
  await p.goto('file://' + resolve(here, src));
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: resolve(out, dst) });
}
// README: the hero card (transparent corners) and the film poster with a play button.
const assets = resolve(here, '../../docs/assets');
await p.setViewportSize({ width: 1760, height: 560 });
await p.goto('file://' + resolve(here, 'readme-hero.html'));
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: resolve(assets, 'hero.png'), omitBackground: true });
await p.goto('file://' + resolve(here, 'readme-hero.html') + '?ko');
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: resolve(assets, 'hero-ko.png'), omitBackground: true });
await p.setViewportSize({ width: 1760, height: 990 });
await p.goto('file://' + resolve(here, 'readme-poster.html'));
await p.evaluate(() => document.fonts.ready);
await p.waitForLoadState('load');
await p.screenshot({ path: resolve(assets, 'film.jpg'), type: 'jpeg', quality: 86 });
for (const [name, size] of [['apple-touch-icon.png', 180], ['favicon-32.png', 32]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0}</style><img src="file://${resolve(out, 'favicon.svg')}" width="${size}" height="${size}">`);
  await p.screenshot({ path: resolve(out, name), omitBackground: true });
}
await b.close();
console.log('og.png, og-internals.png, docs/assets/hero.png, hero-ko.png, film.jpg, apple-touch-icon.png, favicon-32.png');
