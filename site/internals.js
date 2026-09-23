// ttym internals: table of contents that follows the reader, a stoppable server in the process
// diagram, and sequence diagrams drawn from the numbered step lists in the page.
const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

// ── Table of contents: the section nearest the top of the viewport is lit. On narrow screens the
// strip scrolls sideways to keep the lit entry in view. A click updates the address bar, so the
// URL can be shared.
const links = [...document.querySelectorAll('#toc a')];
const sections = links.map((a) => document.querySelector(a.getAttribute('href')));
let current = null;
function light(i) {
  if (i === current) return;
  current = i;
  links.forEach((a, j) => a.classList.toggle('on', j === i));
  const a = links[i];
  const strip = a.closest('ol');
  if (strip.scrollWidth > strip.clientWidth) {
    strip.scrollTo({ left: a.offsetLeft - (strip.clientWidth - a.offsetWidth) / 2, behavior: 'smooth' });
  }
}
function onScroll() {
  const line = innerHeight * 0.3;
  let i = 0;
  sections.forEach((s, j) => { if (s.getBoundingClientRect().top <= line) i = j; });
  light(i);
}
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ── 01: stop the server. Holders and their shells keep running; viewers wait to reconnect.
const fig = document.getElementById('procFig');
const kill = document.getElementById('killServer');
const note = document.getElementById('procNote');
const NOTES = {
  up: 'Everything is up. Press the button to see what a server crash or restart takes down.',
  down: 'The server is gone: viewers show their last screen and retry, while every holder keeps its PTY, its child process and its output ring. Section 02 shows how the next server catches up.',
};
kill.addEventListener('click', () => {
  const down = !fig.classList.contains('is-down');
  fig.classList.toggle('is-down', down);
  kill.setAttribute('aria-pressed', String(down));
  kill.textContent = down ? 'Start it again' : 'Stop the server';
  note.textContent = down ? NOTES.down : NOTES.up;
});

// ── Sequence diagrams. Each <figure class="seq"> lists lanes in data-lanes; each <li> in the
// visible step list names data-from / data-to lane indexes. The SVG is drawn at the pixel width
// it gets, so the lane names stay readable on a phone.
function draw(figure) {
  const lanes = JSON.parse(figure.dataset.lanes);
  const list = figure.querySelector('.seq-steps:not([hidden])');
  const svg = figure.querySelector('.seq-svg');
  const steps = [...list.children];
  const W = Math.max(280, Math.round(svg.parentElement.getBoundingClientRect().width * (matchMedia('(max-width: 960px)').matches ? 1 : 0.52)));
  const pad = 46, top = 44, gap = 40, laneW = Math.min(96, (W - 20) / lanes.length - 6);
  const H = top + 26 + steps.length * gap;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const x = (i) => pad + (i * (W - pad * 2)) / (lanes.length - 1);

  lanes.forEach((name, i) => {
    el('line', { x1: x(i), y1: top, x2: x(i), y2: H - 6, class: 'life' }, svg);
    el('rect', { x: x(i) - laneW / 2, y: 6, width: laneW, height: 28, rx: 7, class: 'lane-box' }, svg);
    const t = el('text', { x: x(i), y: 25, 'text-anchor': 'middle', class: 'lane-name' }, svg);
    t.textContent = name;
  });

  steps.forEach((li, k) => {
    const from = +li.dataset.from, to = +li.dataset.to;
    const y = top + 30 + k * gap;
    const g = el('g', { 'data-k': k }, svg);
    let cx, cy;
    if (from === to) {
      // work inside one lane: a small loop to the right
      const x0 = x(from), w = Math.min(34, (W - pad * 2) / (lanes.length - 1) * 0.45);
      el('path', { d: `M${x0},${y - 8} h${w} v16 h${-w + 7}`, class: 'arr' }, g);
      el('path', { d: `M${x0 + 7},${y + 3} l-7,5 l7,5 z`, class: 'hd' }, g);
      cx = x0 + w; cy = y;
    } else {
      const x1 = x(from), x2 = x(to), dir = Math.sign(x2 - x1);
      el('line', { x1, y1: y, x2: x2 - dir * 7, y2: y, class: 'arr' }, g);
      el('path', { d: `M${x2},${y} l${-dir * 9},-5 v10 z`, class: 'hd' }, g);
      cx = (x1 + x2) / 2; cy = y;
    }
    el('circle', { cx, cy, r: 10, class: 'dot' }, g);
    const n = el('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', class: 'no' }, g);
    n.textContent = k + 1;
    const hot = (on) => { g.classList.toggle('hot', on); li.classList.toggle('hot', on); };
    g.addEventListener('mouseenter', () => hot(true));
    g.addEventListener('mouseleave', () => hot(false));
    li.onmouseenter = () => hot(true);
    li.onmouseleave = () => hot(false);
  });
}

const figures = [...document.querySelectorAll('.seq')];
for (const figure of figures) {
  for (const tab of figure.querySelectorAll('.seq-tabs button')) {
    tab.addEventListener('click', () => {
      for (const t of figure.querySelectorAll('.seq-tabs button')) t.setAttribute('aria-selected', String(t === tab));
      for (const ol of figure.querySelectorAll('.seq-steps')) ol.hidden = ol.dataset.flow !== tab.dataset.flow;
      draw(figure);
    });
  }
  draw(figure);
}
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => figures.forEach(draw), 120); });
