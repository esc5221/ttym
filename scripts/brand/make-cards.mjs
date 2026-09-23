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
// README: the film poster with a play button.
const assets = resolve(here, '../../docs/assets');
await p.setViewportSize({ width: 1760, height: 990 });
await p.goto('file://' + resolve(here, 'readme-poster.html'));
await p.evaluate(() => document.fonts.ready);
await p.waitForLoadState('load');
await p.screenshot({ path: resolve(assets, 'film.jpg'), type: 'jpeg', quality: 86 });
// README: the process diagram, cut from the internals page so the two never drift apart.
// The stop-the-server button row is hidden; outside the rounded figure stays transparent.
{
  const d = await b.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
  await d.goto('file://' + resolve(here, '../../site/internals.html'));
  await d.addStyleTag({ content: 'html, body, .page-internals { background: transparent !important; } #procFig figcaption, #procFig .up, #procFig .down { display: none; } #procFig { margin: 0; }' });
  await d.evaluate(() => document.fonts.ready);
  await d.locator('#procFig').screenshot({ path: resolve(assets, 'architecture.png'), omitBackground: true });
  await d.close();
}
for (const [name, size] of [['apple-touch-icon.png', 180], ['favicon-32.png', 32]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>html,body{margin:0}</style><img src="file://${resolve(out, 'favicon.svg')}" width="${size}" height="${size}">`);
  await p.screenshot({ path: resolve(out, name), omitBackground: true });
}
await b.close();
console.log('og.png, og-internals.png, docs/assets/film.jpg, architecture.png, apple-touch-icon.png, favicon-32.png');
