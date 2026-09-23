// ttym site: the opening shot, live chapters for the film, loops that play only on screen.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Opening: the word blinks (CSS), then makes room for the sentence — the film's first 1.5 s.
const hero = document.getElementById('hero');
setTimeout(() => hero.classList.add('settled'), reduced ? 0 : 1500);

// The nav shows once the hero is out of view.
const nav = document.getElementById('nav');
new IntersectionObserver(([e]) => nav.classList.toggle('on', !e.isIntersecting), { threshold: 0.15 }).observe(hero);

// Copy buttons.
for (const b of document.querySelectorAll('.copy')) {
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied'; }
    catch { b.textContent = 'select it'; }
    setTimeout(() => (b.textContent = 'copy'), 1600);
  });
}

// Film chapters: each bar fills across its own span of the film; a click seeks there.
const film = document.getElementById('filmVideo');
const items = [...document.querySelectorAll('#chapters li')].map((li) => ({ li, t: +li.dataset.t, end: +li.dataset.end, bar: li.querySelector('.bar') }));
const horizontal = () => matchMedia('(max-width: 860px)').matches;
function paint() {
  const now = film.currentTime;
  for (const c of items) {
    const f = Math.min(1, Math.max(0, (now - c.t) / (c.end - c.t)));
    c.bar.style.transform = horizontal() ? `scaleX(${f})` : `scaleY(${f})`;
    c.li.classList.toggle('on', now >= c.t && now < c.end);
    c.li.classList.toggle('done', now >= c.end);
  }
}
film.addEventListener('timeupdate', paint);
film.addEventListener('seeked', paint);

// Cloudflare Pages answers a Range request for the mp4 with the whole file (200, measured), and a
// video without byte ranges cannot seek. Once the film is near the viewport, fetch it whole into a
// Blob and swap the source in place (same time, same play state); a blob seeks anywhere.
let seekable = null;
function makeSeekable() {
  if (seekable) return seekable;
  seekable = fetch(film.currentSrc || film.src)
    .then((r) => r.blob())
    .then((blob) => {
      const t = film.currentTime, playing = !film.paused;
      film.src = URL.createObjectURL(blob);
      return new Promise((done) => film.addEventListener('loadedmetadata', () => {
        film.currentTime = t;
        if (playing) film.play().catch(() => {});
        done();
      }, { once: true }));
    })
    .catch(() => {}); // stays streamable; only seeking is lost
  return seekable;
}
new IntersectionObserver(([e], io) => { if (e.isIntersecting) { makeSeekable(); io.disconnect(); } }, { rootMargin: '600px' }).observe(film);

for (const c of items) {
  c.li.addEventListener('click', async () => {
    c.li.classList.add('on');
    await makeSeekable();
    film.currentTime = c.t + 0.05;
    film.play().catch(() => {});
    paint();
  });
}

// Section loops: load and play only while visible; with reduced motion, click to play.
const loops = document.querySelectorAll('.clip video');
const load = (v) => { if (!v.src) v.src = v.dataset.src; };
if (reduced) {
  for (const v of loops) { load(v); v.controls = true; } // preload=none: nothing downloads until play
} else {
  const io = new IntersectionObserver((entries) => {
    for (const { target: v, isIntersecting } of entries) {
      if (isIntersecting) { load(v); v.play().catch(() => {}); } else v.pause();
    }
  }, { threshold: 0.35 });
  for (const v of loops) io.observe(v);
}
