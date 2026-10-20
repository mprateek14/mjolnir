'use strict';
// Crackling lightning behind the flying hammer. Every bolt is redrawn at random moments with a new
// jagged path, so no two flashes match. Several trails run at once and small forks branch off them.
(() => {
  const svg = document.querySelector('.bolt');
  if (!svg) return;
  const NS = 'http://www.w3.org/2000/svg';
  const W = 150, H = 44, MID = H / 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v) => Math.max(2, Math.min(H - 2, v));
  const pts = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  // A random walk from the tail to the hammer: uneven steps, no up-and-down pattern, calmer near the head.
  function trail(len, headY, amp) {
    const segs = Math.round(rnd(8, 14));
    const list = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const step = len / segs;
      const x = W - len + t * len + (i > 0 && i < segs ? rnd(-0.4, 0.4) * step : 0);
      const a = amp * (1 - 0.6 * t);
      list.push([x, i === segs ? headY : clamp(headY + rnd(-a, a))]);
    }
    return list;
  }

  // A short side branch that leaves a vertex of the main trail at an angle.
  function fork(main) {
    const i = Math.floor(rnd(2, main.length - 3));
    let [x, y] = main[i];
    const dir = Math.random() < 0.5 ? -1 : 1;
    const list = [[x, y]];
    for (let k = 0; k < Math.round(rnd(2, 4)); k++) {
      x += rnd(5, 11);
      y = clamp(y + dir * rnd(3, 9) + rnd(-3, 3));
      list.push([x, y]);
    }
    return list;
  }

  // name, how long, where it meets the hammer, how wild, thickness, how often it redraws (ms)
  const SPEC = [
    { len: 150, head: MID, amp: 11, w: 2.3, every: [55, 120] },
    { len: 124, head: MID - 6, amp: 13, w: 1.7, every: [45, 105] },
    { len: 138, head: MID + 6, amp: 12, w: 1.5, every: [60, 130] },
    { len: 100, head: MID - 3, amp: 9, w: 1.1, every: [40, 95] },
  ];
  const lines = SPEC.map((s) => {
    const el = document.createElementNS(NS, 'polyline');
    el.setAttribute('stroke-width', s.w);
    svg.appendChild(el);
    return { s, el, main: null };
  });
  const forks = [0, 1].map(() => {
    const el = document.createElementNS(NS, 'polyline');
    el.setAttribute('stroke-width', '1');
    svg.appendChild(el);
    return el;
  });

  const visible = () => !document.hidden && !document.getElementById('sky').hidden;

  function draw(l) {
    l.main = trail(l.s.len, l.s.head, l.s.amp);
    l.el.setAttribute('points', pts(l.main));
    l.el.style.opacity = rnd(0.55, 1).toFixed(2);
  }
  function drawFork(el) {
    const host = lines[Math.floor(rnd(0, 3))];
    if (!host.main || Math.random() < 0.35) { el.style.opacity = 0; return; }   // forks come and go
    el.setAttribute('points', pts(fork(host.main)));
    el.style.opacity = rnd(0.45, 0.9).toFixed(2);
  }

  lines.forEach((l) => draw(l));
  forks.forEach(drawFork);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;   // one still bolt is enough

  const loop = (fn, every) => {
    const go = () => { if (visible()) fn(); setTimeout(go, rnd(every[0], every[1])); };
    setTimeout(go, rnd(0, every[1]));
  };
  lines.forEach((l) => loop(() => draw(l), l.s.every));
  forks.forEach((f) => loop(() => drawFork(f), [70, 170]));
})();
