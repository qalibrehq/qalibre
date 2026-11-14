// Qalibre site: the order-flow field, headline and section reveals, the QUBO grid, live numbers. No libraries.
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canAnimate = !reduce && 'IntersectionObserver' in window;

  // ---------- Mobile menu ----------
  const menuBtn = document.querySelector('.menu-btn');
  const menu = document.getElementById('menu');
  if (menuBtn && menu) {
    menuBtn.addEventListener('click', () => {
      const open = menuBtn.getAttribute('aria-expanded') !== 'true';
      menuBtn.setAttribute('aria-expanded', String(open));
      menu.hidden = !open;
      document.body.style.overflow = open ? 'hidden' : '';
    });
  }

  // ---------- Reveals: everything is visible at rest; motion arms only when it can play. ----------
  if (canAnimate) {
    document.documentElement.classList.add('armed');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { threshold: 0.2, rootMargin: '0px 0px -6% 0px' });
    document.querySelectorAll('[data-reveal], .rv').forEach((el) => io.observe(el));
  } else {
    document.querySelectorAll('[data-reveal], .rv').forEach((el) => el.classList.add('in'));
  }

  // ---------- The order-flow field: orders stream in, meet at the brass ring, the remainder flows on. ----------
  const canvas = document.querySelector('.hero .flow');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = 1, fx = 0, fy = 0, running = false, raf = 0;
    const parts = [];
    const flashes = [];
    const mobile = () => W < 760;

    function resize() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Orders stream into the phone: its left edge on wide screens, its top on phones.
      const ph = document.querySelector('.hero .phone');
      const hr = canvas.getBoundingClientRect();
      if (ph) {
        const pr = ph.getBoundingClientRect();
        // Desktop: orders arrive from the open space on the right, into the phone's right edge.
        fx = mobile() ? pr.left - hr.left + pr.width / 2 : pr.right - hr.left - 6;
        fy = mobile() ? pr.top - hr.top + 6 : pr.top - hr.top + pr.height * 0.5;
      } else { fx = W * 0.6; fy = H * 0.56; }
    }

    function spawn() {
      const fromTop = Math.random();
      parts.push({
        // Desktop: from the right edge. Phone: from both sides toward the phone's top.
        side: mobile() ? (Math.random() < 0.5 ? -1 : 1) : 1,
        y0: mobile() ? H * (0.45 + fromTop * 0.25) : H * (0.06 + fromTop * 0.88),
        t: 0,
        v: 0.0028 + Math.random() * 0.0034,
        sell: Math.random() < 0.5,
        bend: 0.25 + Math.random() * 0.35,
      });
    }

    // Cubic curve from the left edge into the meeting point.
    function point(p) {
      const t = p.t, x0 = p.side > 0 ? W + 20 : -20, y0 = p.y0, x3 = fx, y3 = fy;
      const x1 = x0 + (x3 - x0) * p.bend, y1 = y0, x2 = x3 + (x0 - x3) * 0.18, y2 = y3;
      const u = 1 - t;
      return [u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3];
    }

    function frame() {
      ctx.clearRect(0, 0, W, H);
      // Desktop: as many orders as the open space beside the phone can hold; a thin strip gets none, never a smudge.
      const room = W - fx;
      const target = mobile() ? 30 : room < 160 ? 0 : Math.min(64, Math.round(room / 7));
      if (parts.length < target && Math.random() < 0.5) spawn();

      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.out !== undefined) {
          // Remainder: a short green streak toward QWAP.
          p.out += 4.2;
          const x = fx + p.out;
          ctx.strokeStyle = 'rgba(15,77,58,0.55)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x - 18, fy); ctx.lineTo(x, fy); ctx.stroke();
          if (x > W + 30) parts.splice(i, 1);
          continue;
        }
        const [px, py] = point(p);
        p.t += p.v;
        const [x, y] = point(p);
        const near = Math.max(0, p.t - 0.7) * 3.3;
        const a = (p.sell ? 0.34 : 0.42) + near * 0.5;
        const col = p.sell ? '17,18,20' : '15,77,58';
        // A short trail shows direction: every order is moving toward the same fair price.
        ctx.strokeStyle = `rgba(${col},${a * 0.45})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(px - (x - px) * 5, py - (y - py) * 5); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = `rgba(${col},${a})`;
        ctx.beginPath(); ctx.arc(x, y, 2.8, 0, Math.PI * 2); ctx.fill();
        if (p.t >= 1) {
          // Matched (most orders) flash brass and settle; the rest continue to QWAP.
          flashes.push({ r: 3, a: 0.55 }); parts.splice(i, 1);
        }
      }

      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i];
        f.r += 1.1; f.a *= 0.93;
        ctx.strokeStyle = `rgba(176,141,87,${f.a})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(fx, fy, f.r, 0, Math.PI * 2); ctx.stroke();
        if (f.a < 0.03) flashes.splice(i, 1);
      }

      if (running) raf = requestAnimationFrame(frame);
    }

    function staticFrame() {
      // Reduced motion: the same picture, still.
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(17,18,20,0.08)';
      ctx.lineWidth = 1;
      for (let k = 0; k < 9; k++) {
        const y0 = H * (0.1 + k * 0.1);
        ctx.beginPath(); ctx.moveTo(-20, y0); ctx.bezierCurveTo(W * 0.35, y0, fx - W * 0.12, fy, fx, fy); ctx.stroke();
      }
      ctx.fillStyle = '#B08D57';
      ctx.beginPath(); ctx.arc(fx, fy, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#F6F4EF';
      ctx.beginPath(); ctx.arc(fx, fy, 2.6, 0, Math.PI * 2); ctx.fill();
    }

    resize();
    window.addEventListener('resize', () => { resize(); if (!canAnimate) staticFrame(); });
    // Fonts and images change the layout after first paint: re-aim at the phone once everything has loaded.
    window.addEventListener('load', () => { resize(); if (!canAnimate) staticFrame(); });
    if (!canAnimate) staticFrame();
    else {
      // Only run while the hero is on screen and the tab is visible: no wasted battery.
      const start = () => { if (!running && !document.hidden) { running = true; raf = requestAnimationFrame(frame); } };
      const stop = () => { running = false; cancelAnimationFrame(raf); };
      new IntersectionObserver((es) => (es[0].isIntersecting ? start() : stop())).observe(canvas);
      document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    }
  }

  // ---------- The living chat: a scam stopped, then a trade made. Never empty. ----------
  const feed = document.querySelector('.hero .feed');
  const halo = document.querySelector('.hero .halo');
  if (feed && canAnimate) {
    // Earlier messages stay at the top, like a real chat; the scripted part plays below them.
    const history = [...feed.querySelectorAll('.history')].map((n) => n.cloneNode(true));
    const tpl = [...feed.children].filter((n) => !n.classList.contains('history')).map((n) => n.cloneNode(true));
    const typing = () => {
      const t = document.createElement('div');
      t.className = 'msg in typing enter';
      t.innerHTML = '<i></i><i></i><i></i><span>Simulating a buy and a sale</span>';
      return t;
    };
    const pulse = (kind) => {
      if (!halo) return;
      halo.className = 'halo';
      void halo.offsetWidth; // restart the animation
      halo.className = `halo go ${kind}`;
    };
    const add = (node) => { node.classList.add('enter'); feed.appendChild(node); return node; };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const play = async () => {
      for (;;) {
        feed.classList.remove('leave');
        feed.replaceChildren(...history.map((n) => n.cloneNode(true)), tpl[0].cloneNode(true));
        await wait(900);
        add(tpl[1].cloneNode(true));                 // a token is pasted
        await wait(700);
        let t = add(typing());                        // the check runs
        await wait(1500);
        t.remove();
        add(tpl[2].cloneNode(true));                  // honeypot: stopped
        pulse('bad');
        await wait(2600);
        add(tpl[3].cloneNode(true));                  // a real token
        await wait(700);
        t = add(typing());
        await wait(1500);
        t.remove();
        const card = add(tpl[4].cloneNode(true));     // checked: tradable
        const btn = card.querySelector('.on');
        btn?.classList.remove('on');
        pulse('good');
        await wait(1500);
        btn?.classList.add('on', 'tap');              // one tap
        await wait(700);
        add(tpl[5].cloneNode(true));                  // done
        pulse('good');
        await wait(3400);
        feed.classList.add('leave');
        await wait(650);
      }
    };
    play();
  }

  // ---------- The QUBO grid: interaction strengths, then the chosen orders light up. ----------
  const grid = document.querySelector('.qubo');
  if (grid) {
    const n = 12;
    const seed = (i, j) => { const x = Math.sin((Math.min(i, j) + 1) * 12.9898 + (Math.max(i, j) + 1) * 78.233) * 43758.5453; return x - Math.floor(x); };
    const cells = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const s = document.createElement('span');
      s.style.setProperty('--a', (i === j ? 0.32 : 0.04 + seed(i, j) * 0.2).toFixed(2));
      grid.appendChild(s);
      cells.push(s);
    }
    const chosen = [0, 2, 3, 6, 8, 11];
    const light = () => chosen.forEach((k, idx) => setTimeout(() => cells[k * n + k].classList.add('pick'), canAnimate ? 240 * idx : 0));
    if (!canAnimate) light();
    else new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { light(); o.disconnect(); } }, { threshold: 0.35 }).observe(grid);
  }

  // ---------- Live numbers: real data only. No API configured or unreachable: the band is removed. ----------
  const band = document.querySelector('.stats');
  const api = document.body.dataset.api;
  if (band) {
    if (!api) band.remove();
    else fetch(`${api}/api/stats`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((s) => {
        // Small numbers read as an empty room: the band appears only once there is real traction.
        if (Number(s.trades) < 50 || Number(s.checked) < 50) return band.remove();
        const set = (key, v) => {
          const el = band.querySelector(`[data-stat="${key}"]`);
          const to = Number(v || 0);
          if (!canAnimate) return (el.textContent = to.toLocaleString('en-US'));
          const t0 = performance.now();
          const step = (now) => {
            const t = Math.min(1, Math.max(0, (now - t0) / 1100));
            el.textContent = Math.round(to * (1 - Math.pow(1 - t, 3))).toLocaleString('en-US');
            if (t < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        };
        set('blocked', s.blocked); set('checked', s.checked); set('trades', s.trades);
      })
      .catch(() => band.remove());
  }
})();
