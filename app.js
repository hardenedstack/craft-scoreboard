/* Craft Scoreboard. Everything below renders from the scoreboard.json data baked into the page (#data). */
(() => {
  'use strict';
  const D = JSON.parse(document.getElementById('data').textContent);
  const $ = (s, r = document) => r.querySelector(s);
  const root = document.documentElement;
  const byId = Object.fromEntries(D.apps.map(a => [a.id, a]));
  const crafts = D.apps.filter(a => a.kind === 'craft');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const isStage = root.classList.contains('stage');
  const isOg = root.classList.contains('og');

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // fixed English month names: toLocaleDateString builds a new formatter per call (slow on phones)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = iso => { if (!iso) return null; const [y, m, d] = iso.split('-'); return `${+d} ${MONTHS[m - 1]} ${y}`; };
  const measured = a => a.versions.filter(v => v.status === 'measured');
  const latestMeasured = a => measured(a).at(-1) || null;
  const latest = a => a.versions.at(-1);
  const shortName = a => a.short || a.name;
  const ytUrl = id => 'https://www.youtube.com/watch?v=' + id;
  const parseVer = s => {
    const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?\s*$/.exec(s || '');
    return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
  };
  const cmpVer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const secs = t => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
  const clock = n => [Math.floor(n / 3600), Math.floor(n / 60) % 60, Math.floor(n % 60)].map(x => String(x).padStart(2, '0')).join(':');
  const clamp = x => Math.max(0, Math.min(1, x));
  const ease = x => { x = clamp(x); return 1 - Math.pow(1 - x, 3); };
  const distinctHosts = (v, sc) => [...new Set((v.connections_detail || []).filter(c => c.scenario === sc).map(c => c.host))];

  /* What the map and cards say about one app in one scenario */
  function connState(app, sc) {
    const v = latestMeasured(app);
    const top = latest(app);
    if (!v) return { kind: top && top.status === 'not_tested' ? 'untested' : 'coming', text: top && top.status === 'not_tested' ? 'not tested' : 'test coming' };
    const c = v.connections && v.connections[sc];
    if (!c) return { kind: 'unmeasured', text: 'not measured', v };
    if (c.count === 0) return { kind: 'quiet', text: sc === 'closed' && /left running/.test(c.how) ? '0 left running' : '0 connections', v, c };
    return { kind: 'traffic', text: c.count + ' hosts', v, c, count: c.count };
  }

  /* ── New since your last visit (stored only in this browser) ─────────────── */
  let lastVisit = null;
  try { lastVisit = localStorage.getItem('sb_last_visit'); localStorage.setItem('sb_last_visit', new Date().toISOString().slice(0, 10)); } catch (e) { /* storage blocked */ }
  const isNew = v => !!(lastVisit && v && v.date && v.status === 'measured' && v.date > lastVisit);

  /* ── Theme toggle ─────────────────────────── */
  const themeBtn = $('#theme');
  const currentTheme = () => root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const labelTheme = () => themeBtn.setAttribute('aria-label', currentTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  labelTheme();
  themeBtn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* storage blocked */ }
    labelTheme();
    if (map) map.recolor();
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { labelTheme(); if (map) map.recolor(); });

  /* ── Copy link ─────────────────────────── */
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const url = D.site.url + '#' + b.dataset.copy;
    const done = ok => {
      const old = b.dataset.label || b.textContent;
      b.dataset.label = old;
      b.textContent = ok ? 'Link copied' : url;
      b.classList.toggle('copied', ok);
      setTimeout(() => { b.textContent = old; b.classList.remove('copied'); }, 2200);
    };
    try { navigator.clipboard.writeText(url).then(() => done(true), () => done(false)); } catch (err) { done(false); }
  });

  /* ── Lab network map ─────────────────────────── */
  const canvas = $('#map');
  const readout = $('#readout');
  let map = null;

  // Sequence timing (seconds). Boot: rings, PC, apps, then measured traffic. Replay: 1 s on screen = 4 min of lab time.
  const BOOT = { pc: .25, nodes: .8, nodeStep: .11, lock: .45, traffic: 2.3, trafficLen: 1.4 };
  const LAB_SPEED = 240;
  const REPLAY_LEAD = 1.2;

  class LabMap {
    constructor(cv) {
      this.cv = cv;
      this.ctx = cv.getContext('2d');
      this.sc = 'working';
      this.packets = [];
      this.hover = null;
      this.visible = true;
      this.nodes = []; this.hosts = []; this.edges = [];
      this.seqStart = null;
      this.recolor();
      this.layout();
      new ResizeObserver(() => { this.layout(); this.drawStatic(); if (!this.hover) this.showReadout(null); }).observe(cv);
      cv.addEventListener('pointermove', e => this.pick(e));
      cv.addEventListener('pointerdown', e => this.pick(e, true));
      cv.addEventListener('pointerleave', () => { this.hover = null; this.showReadout(null); });
      new IntersectionObserver(es => { this.visible = es[0].isIntersecting; if (this.visible) this.kick(); }).observe(cv);
      document.addEventListener('visibilitychange', () => this.kick());
      reduceMotion.addEventListener('change', () => { this.kick(); this.drawStatic(); });
      // first paint is the standby frame; the boot sequence runs once the page has loaded
      const go = () => setTimeout(() => { this.started = true; this.replay(); }, isStage ? 0 : 700);
      if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
      this.drawStatic();
    }
    recolor() {
      const cs = getComputedStyle(root);
      const g = n => cs.getPropertyValue(n).trim();
      this.c = { fg: g('--fg'), muted: g('--muted'), line: g('--line'), lineStrong: g('--line-strong'), accent: g('--accent'), traffic: g('--traffic'), quiet: g('--quiet'), panel: g('--panel'), bg: g('--bg-deep') };
      this.fontMono = g('--font-mono');
      this.fontDisplay = g('--font-display');
      this.drawStatic();
    }
    /* seconds into the current sequence; "finished" when motion is off */
    seqT(now) {
      if (reduceMotion.matches || isOg) return 999;
      if (!this.started || this.seqStart == null) return 0;
      return (now - this.seqStart) / 1000;
    }
    replay() {
      this.seqStart = performance.now();
      // after the first boot, switching back to "while you work" skips straight to the traffic
      if (this.sc === 'working' && this.booted) this.seqStart -= BOOT.traffic * 1000 - 200;
      this.booted = true;
      this.packets = [];
      this.lastEvent = null;
      this.kick();
      this.drawStatic();
    }
    setScenario(sc) {
      this.sc = sc;
      this.layout();
      this.replay();
      this.showReadout(null);
    }
    layout() {
      const r = this.cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = r.width; this.h = r.height;
      if (!this.w || !this.h) return;
      this.cv.width = Math.round(this.w * dpr); this.cv.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = this.w, h = this.h;
      this.small = w < 560;
      this.scale = Math.max(.85, Math.min(1.9, w / 820));
      const order = ['pdfcraft', 'photocraft', 'gridcraft', 'deckcraft', 'wordcraft'];
      const pairs = order.map(id => byId[id]).filter(Boolean);
      this.nodes = []; this.hosts = []; this.edges = [];
      if (this.small) {
        this.cx = w * .5; this.cy = h * .5;
        const top = h * .1, step = (h * .8) / (pairs.length - 1);
        pairs.forEach((a, i) => {
          const y = top + step * i;
          this.nodes.push({ app: a, x: w * .31, y, side: -1, i: i * 2 });
          this.nodes.push({ app: byId[a.compare_to], x: w * .68, y, side: 1, i: i * 2 + 1 });
        });
        this.netX = w - 8;
      } else {
        this.cx = w * .5; this.cy = h * (isStage ? .58 : .54);
        this.rxI = w * .245; this.ryI = h * (isStage ? .27 : .29);
        this.rxO = w * .465; this.ryO = h * (isStage ? .36 : .4);
        const rows = [-50, -25, 0, 25, 50];
        pairs.forEach((a, i) => {
          const ar = rows[i] * Math.PI / 180;
          const al = Math.PI - ar;
          this.nodes.push({ app: a, x: this.cx + this.rxI * Math.cos(al), y: this.cy + this.ryI * Math.sin(al), side: -1, i: i * 2 });
          this.nodes.push({ app: byId[a.compare_to], x: this.cx + this.rxI * Math.cos(ar), y: this.cy + this.ryI * Math.sin(ar), side: 1, ang: rows[i], i: i * 2 + 1 });
        });
      }
      const clusterAng = { acrobat: -80, 'word-web': 86, 'excel-web': -17 };
      const clusterR = { 'excel-web': .93 };   // Excel's label sits at 0 degrees: its count goes up and out, clear of the label
      const arcs = { acrobat: [-116, -24], 'word-web': [20, 96], 'excel-web': [-14, 14], 'powerpoint-web': [10, 40], photoshop: [-40, -10] };
      for (const n of this.nodes) {
        n.state = connState(n.app, this.sc);
        if (n.state.kind !== 'traffic') continue;
        const v = n.state.v;
        const hosts = distinctHosts(v, this.sc);
        const rows = (v.connections_detail || []).filter(c => c.scenario === this.sc);
        n.cluster = { shown: hosts.length, total: n.state.count };
        n.timeline = this.sc === 'closed' && n.state.c.timeline ? n.state.c.timeline : null;
        const [a0, a1] = arcs[n.app.id] || [n.ang - 15, n.ang + 15];
        hosts.forEach((hst, i) => {
          const meta = rows.find(c => c.host === hst);
          const H = { host: hst, meta, app: n.app, node: n, weight: this.weight(rows, hst), flash: 0, k: i, at: meta && meta.time ? secs(meta.time) : null };
          if (this.small) {
            H.x = this.netX;
            H.y = Math.min(h - 14, Math.max(14, n.y + (i - (hosts.length - 1) / 2) * Math.min(9, (h * .5) / hosts.length)));
          } else {
            const t = hosts.length === 1 ? .5 : i / (hosts.length - 1);
            H.ang = (a0 + (a1 - a0) * t) * Math.PI / 180;
            const rr = i % 2 ? 1 : .955;
            H.x = this.cx + this.rxO * rr * Math.cos(H.ang); H.y = this.cy + this.ryO * rr * Math.sin(H.ang);
          }
          this.hosts.push(H);
          this.edges.push({ from: n, to: H });
        });
        if (!this.small) {
          const mid = (clusterAng[n.app.id] ?? (a0 + a1) / 2) * Math.PI / 180;
          const cr = clusterR[n.app.id] ?? .78;
          n.clusterAt = { x: this.cx + this.rxO * cr * Math.cos(mid), y: this.cy + this.ryO * cr * Math.sin(mid) };
        }
      }
      for (const e of this.edges) {
        const mx = (e.from.x + e.to.x) / 2, my = (e.from.y + e.to.y) / 2;
        const dx = mx - this.cx, dy = my - this.cy, d = Math.hypot(dx, dy) || 1;
        const bend = this.small ? 0 : 26 * this.scale;
        e.cp = { x: mx + dx / d * bend, y: my + dy / d * bend };
        e.rate = 0.35 + 0.55 * e.to.weight;
      }
      this.pc = { x: this.cx, y: this.cy, w: (this.small ? 80 : 132) * Math.min(this.scale, 1.5), h: (this.small ? 44 : 60) * Math.min(this.scale, 1.5) };
      this.timeline = this.nodes.map(n => n.timeline).find(Boolean) || null;
    }
    weight(rows, host) {
      const r = rows.filter(c => c.host === host);
      const req = r.reduce((s, c) => s + (c.requests || 0), 0);
      const mb = r.reduce((s, c) => s + (c.mb_up || 0) + (c.mb_down || 0) + (c.kb_up || 0) / 1000, 0);
      if (!req && !mb) return .45;
      return Math.min(1, .45 + Math.log10(1 + req) / 4 + Math.log10(1 + mb * 10) / 5);
    }
    kick() {
      if (this.raf) return;
      if (!this.started || reduceMotion.matches || document.hidden || !this.visible) { this.drawStatic(); return; }
      const loop = now => {
        this.raf = null;
        if (reduceMotion.matches || document.hidden || !this.visible) return;
        this.frame(now, true);
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
    drawStatic() { if (this.w && (reduceMotion.matches || !this.raf)) this.frame(performance.now(), false); }
    q(e, t) {
      const u = 1 - t;
      return { x: u * u * e.from.x + 2 * u * t * e.cp.x + t * t * e.to.x, y: u * u * e.from.y + 2 * u * t * e.cp.y + t * t * e.to.y };
    }
    /* Visibility of every element at sequence time t (seconds) */
    stateAt(t) {
      const st = { ring: ease(t / .7), pc: ease((t - BOOT.pc) / .5), labT: null };
      const boot = this.sc === 'working';
      if (!boot) { st.ring = 1; st.pc = 1; }
      for (const n of this.nodes) {
        const t0 = BOOT.nodes + n.i * BOOT.nodeStep;
        n.a = boot ? ease((t - t0) / .35) : 1;
        n.locked = boot ? t > t0 + BOOT.lock : true;
      }
      if (this.timeline) {
        const tl = this.timeline;
        const lt = secs(tl.start) + Math.max(0, t - REPLAY_LEAD) * LAB_SPEED;
        st.labT = Math.min(lt, secs(tl.end));
        st.replayDone = lt >= secs(tl.end);
      }
      const n = this.hosts.length;
      for (const H of this.hosts) {
        if (st.labT != null && H.at != null) H.a = st.labT < H.at ? 0 : ease((st.labT - H.at) / 40);
        else if (boot) H.a = ease((t - BOOT.traffic - H.k * (BOOT.trafficLen / Math.max(8, n))) / .4);
        else H.a = ease((t - .3) / .5);
      }
      for (const nd of this.nodes) {
        if (!nd.cluster) continue;
        const mine = this.hosts.filter(H => H.node === nd);
        nd.countNow = st.labT != null
          ? mine.filter(H => H.a > 0).length
          : Math.round(nd.cluster.total * Math.min(1, mine.reduce((s, H) => s + H.a, 0) / Math.max(1, mine.length)));
      }
      return st;
    }
    frame(now, live) {
      const { ctx, w, h, c } = this;
      if (!w || !h) return;
      const s = this.scale;
      const ms = Math.min(s, 1.5);
      const t = this.seqT(now);
      const time = now / 1000;
      const dt = Math.min(.05, (now - (this.last || now)) / 1000);
      this.last = now;
      const st = this.stateAt(t);
      ctx.clearRect(0, 0, w, h);

      // rings + radar
      ctx.save();
      ctx.globalAlpha = Math.max(.25, st.ring);
      if (!this.small) {
        const rk = .94 + .06 * st.ring;
        ctx.setLineDash([2, 6]);
        ctx.strokeStyle = c.lineStrong; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(this.cx, this.cy, this.rxO * rk, this.ryO * rk, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = c.line;
        ctx.beginPath(); ctx.ellipse(this.cx, this.cy, this.rxI * rk, this.ryI * rk, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(this.cx, this.cy, this.rxI * .45, this.ryI * .45, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = c.lineStrong;
        for (let i = 0; i < 72; i++) {
          const a = i / 72 * Math.PI * 2, l = i % 6 ? 4 : 9;
          const x = this.cx + this.rxO * Math.cos(a), y = this.cy + this.ryO * Math.sin(a);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l * this.ryO / this.rxO); ctx.stroke();
        }
        this.text('INTERNET', this.cx - this.rxO + 14 * s, this.cy - 8 * s, { size: 10.5 * s, color: c.muted, mono: true, track: 2.4 * s });
        // boot: one expanding scan ring; afterwards a slow radar sweep
        if (live && this.sc === 'working' && t < 1.4) {
          const p = ease(t / 1.4);
          ctx.strokeStyle = this.alpha(c.accent, .6 * (1 - p)); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.ellipse(this.cx, this.cy, this.rxO * p, this.ryO * p, 0, 0, Math.PI * 2); ctx.stroke();
        } else if (live && ctx.createConicGradient && !isOg) {
          const a = (time / 9) * Math.PI * 2;
          const g = ctx.createConicGradient(a, this.cx, this.cy);
          g.addColorStop(0, this.alpha(c.accent, 0)); g.addColorStop(.86, this.alpha(c.accent, 0)); g.addColorStop(1, this.alpha(c.accent, .11));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.ellipse(this.cx, this.cy, this.rxO, this.ryO, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = this.alpha(c.accent, .3); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(this.cx, this.cy); ctx.lineTo(this.cx + this.rxO * Math.cos(a), this.cy + this.ryO * Math.sin(a)); ctx.stroke();
        }
      } else {
        ctx.setLineDash([2, 5]); ctx.strokeStyle = c.lineStrong;
        ctx.beginPath(); ctx.moveTo(this.netX, 8); ctx.lineTo(this.netX, h - 8); ctx.stroke(); ctx.setLineDash([]);
        ctx.save(); ctx.translate(this.netX - 6, h / 2); ctx.rotate(-Math.PI / 2);
        this.text('INTERNET', 0, 0, { size: 10.5, color: c.muted, mono: true, align: 'center', track: 2 });
        ctx.restore();
        if (live && this.sc === 'working' && t < 1.4) {
          const p = ease(t / 1.4);
          ctx.strokeStyle = this.alpha(c.accent, .5 * (1 - p)); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(this.cx, this.cy, Math.max(w, h) * .6 * p, 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.restore();

      // PC -> app links grow out as each app comes online
      for (const n of this.nodes) {
        if (n.a <= 0) continue;
        ctx.strokeStyle = n.state.kind === 'traffic' && n.countNow ? this.alpha(c.traffic, .35) : this.alpha(c.lineStrong, .6);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(this.pc.x, this.pc.y); ctx.lineTo(this.pc.x + (n.x - this.pc.x) * n.a, this.pc.y + (n.y - this.pc.y) * n.a); ctx.stroke();
      }

      // app -> host edges
      for (const e of this.edges) {
        if (e.to.a <= 0) continue;
        ctx.strokeStyle = this.alpha(c.traffic, .22 * e.to.a);
        ctx.beginPath(); ctx.moveTo(e.from.x, e.from.y); ctx.quadraticCurveTo(e.cp.x, e.cp.y, e.to.x, e.to.y); ctx.stroke();
      }

      // packets
      if (live) {
        for (const e of this.edges) {
          if (e.to.a > .6 && Math.random() < e.rate * dt * 1.2) this.packets.push({ e, t: 0, sp: .45 + Math.random() * .3 });
        }
        if (this.packets.length > 260) this.packets.splice(0, this.packets.length - 260);
        for (const p of this.packets) {
          p.t += dt * p.sp;
          if (p.t >= 1 && !p.done) { p.done = true; p.e.to.flash = 1; }
        }
        this.packets = this.packets.filter(p => p.t < 1);
        for (const H of this.hosts) H.flash = Math.max(0, H.flash - dt * .9);
      }
      const pk = live ? this.packets : this.edges.flatMap(e => [.38, .72].map(tt => ({ e, t: tt })));
      for (const p of pk) {
        if (p.e.to.a <= 0) continue;
        for (let k = 4; k >= 0; k--) {
          const tt = p.t - k * .022;
          if (tt < 0) continue;
          const pt = this.q(p.e, tt);
          ctx.fillStyle = this.alpha(c.traffic, (k === 0 ? 1 : .5 - k * .1) * p.e.to.a);
          ctx.beginPath(); ctx.arc(pt.x, pt.y, (k === 0 ? 2.4 : 1.8) * Math.min(s, 1.4), 0, Math.PI * 2); ctx.fill();
        }
      }

      // hosts: a new host arrives with a ring burst
      for (const H of this.hosts) {
        if (H.a <= 0) continue;
        const r = (2.2 + H.flash * 2.4) * Math.min(s, 1.4);
        if (H.a < 1) {
          ctx.strokeStyle = this.alpha(c.traffic, .7 * (1 - H.a)); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(H.x, H.y, r + 22 * H.a * Math.min(s, 1.4), 0, Math.PI * 2); ctx.stroke();
        }
        if (H.flash > 0) {
          ctx.fillStyle = this.alpha(c.traffic, .18 * H.flash);
          ctx.beginPath(); ctx.arc(H.x, H.y, r * 3.2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = this.alpha(c.traffic, (.55 + .45 * H.flash) * Math.max(.3, H.a));
        ctx.beginPath(); ctx.arc(H.x, H.y, r, 0, Math.PI * 2); ctx.fill();
      }

      // host labels: on a landing packet, on arrival in a replay, or on hover; never over app labels or each other
      const placed = [];
      for (const n of this.nodes) {
        placed.push({ x0: n.side < 0 ? n.x - 190 * s : n.x - 12 * s, x1: n.side < 0 ? n.x + 12 * s : n.x + 210 * s, y0: n.y - 26 * s, y1: n.y + 22 * s });
        if (n.clusterAt) placed.push({ x0: n.clusterAt.x - 70 * s, x1: n.clusterAt.x + 70 * s, y0: n.clusterAt.y - 22 * s, y1: n.clusterAt.y + 24 * s });
      }
      placed.push({ x0: this.pc.x - this.pc.w / 2 - 30 * s, x1: this.pc.x + this.pc.w / 2 + 30 * s, y0: this.pc.y - this.pc.h / 2, y1: this.pc.y + this.pc.h / 2 + 70 * s });
      placed.push({ x0: 0, x1: w * .45, y0: h - 34 * s, y1: h });
      if (isStage) placed.push({ x0: 0, x1: w * .45, y0: 0, y1: 70 * s });
      const fs = Math.max(12, 10.5 * s);
      ctx.font = `400 ${fs}px ${this.fontMono}`;
      const arriving = H => H.at != null && st.labT != null && H.a > 0 && st.labT - H.at < 360;
      const order = this.hosts.filter(H => this.hover === H || (!this.small && !isOg && H.a > 0 && (H.flash > .05 || arriving(H))))
        .sort((a, b) => (b === this.hover) - (a === this.hover) || arriving(b) - arriving(a) || b.flash - a.flash);
      for (const H of order) {
        const tw = ctx.measureText(H.host).width;
        let out = Math.cos(H.ang ?? 0) >= 0 ? 1 : -1;
        if (out > 0 && H.x + 9 * s + tw > w - 8) out = -1;
        if (out < 0 && H.x - 9 * s - tw < 8) out = 1;
        const lx = H.x + out * 9 * s, ly = H.y + (Math.sin(H.ang ?? 0) < 0 ? -7 : 9) * s;
        const box = { x0: out > 0 ? lx : lx - tw, y0: ly - fs * .7, y1: ly + fs * .7 };
        box.x1 = box.x0 + tw;
        if (H !== this.hover && placed.some(r => box.x0 < r.x1 + 6 && box.x1 > r.x0 - 6 && box.y0 < r.y1 + 2 && box.y1 > r.y0 - 2)) continue;
        placed.push(box);
        const a = this.hover === H || arriving(H) ? 1 : Math.min(1, H.flash * 1.6);
        this.text(H.host, lx, ly, { size: fs, color: this.alpha(c.fg, a * .92 * Math.max(.3, H.a)), mono: true, align: out > 0 ? 'left' : 'right' });
      }

      // cluster counts climb as hosts appear
      for (const n of this.nodes) {
        if (!n.cluster || this.small || !n.clusterAt || !n.countNow) continue;
        const { x, y } = n.clusterAt;
        this.text(String(n.countNow), x, y, { size: 30 * s, color: c.traffic, mono: true, weight: 600, align: 'center' });
        const lbl = n.cluster.shown < n.cluster.total ? `HOSTS · ${n.cluster.shown} SHOWN` : 'HOSTS';
        this.text(lbl, x, y + 16 * s, { size: 10 * s, color: c.muted, mono: true, align: 'center', track: 1.6 * s });
      }

      // app nodes
      for (const n of this.nodes) {
        if (n.a <= 0) continue;
        ctx.save(); ctx.globalAlpha = n.a;
        const kind = n.state.kind;
        const r = 6.5 * ms;
        const checking = ((kind === 'quiet' || kind === 'traffic') && !n.locked) || (this.sc === 'working' && kind === 'traffic' && !n.countNow);
        const flowing = kind === 'traffic' && n.locked && n.countNow > 0;
        if (checking || (kind === 'traffic' && !flowing)) {
          // a spinning ring while the result locks in (and, in a replay, before the first connection)
          ctx.strokeStyle = checking ? c.accent : this.alpha(c.traffic, .8); ctx.lineWidth = 1.5;
          const a0 = (live ? time : 0) * 6;
          ctx.beginPath(); ctx.arc(n.x, n.y, r, a0, a0 + Math.PI * 1.3); ctx.stroke();
        } else if (kind === 'quiet') {
          if (live) {
            const ph = ((time + n.y * .013) % 3.4) / 3.4;
            ctx.strokeStyle = this.alpha(c.quiet, .55 * (1 - ph)); ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(n.x, n.y, r + ph * 16 * ms, 0, Math.PI * 2); ctx.stroke();
          } else {
            ctx.strokeStyle = this.alpha(c.quiet, .35); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 7, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.fillStyle = c.quiet;
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
        } else if (flowing) {
          ctx.shadowColor = c.traffic; ctx.shadowBlur = 16 * s;
          ctx.fillStyle = c.traffic; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = c.bg; ctx.strokeStyle = c.muted; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
        }
        if (this.hover === n) {
          ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2); ctx.stroke();
        }
        const lx = n.x + n.side * (r + 10 * ms);
        const align = n.side < 0 ? 'right' : 'left';
        const nm = this.small ? (n.app.short || n.app.name).replace('Microsoft ', '').replace(' for the web', ' web') : shortName(n.app);
        const muted = kind === 'coming' || kind === 'untested' || kind === 'unmeasured';
        this.text(nm, lx, n.y - 2 * s, { size: (this.small ? 12 : 13.5 * s), color: muted ? c.muted : c.fg, weight: 700, align, display: true });
        if (n.state.v && n.state.v.version && !this.small && n.side < 0) this.text(n.state.v.version, lx, n.y - 17 * s, { size: 10 * s, color: c.muted, mono: true, align });
        let sub = n.state.text.toUpperCase(), col = muted ? c.muted : kind === 'quiet' ? c.quiet : c.traffic;
        if (checking) { sub = 'CHECKING…'; col = c.accent; }
        else if (kind === 'traffic') sub = `${n.countNow || 0} HOSTS`;
        this.text(sub, lx, n.y + 13 * ms, { size: 10.5 * (this.small ? 1 : s), color: col, mono: true, align, track: 1 * s, weight: 500 });
        ctx.restore();
      }

      // the PC
      ctx.save();
      ctx.globalAlpha = Math.max(.35, st.pc);
      const { x, y } = this.pc, bw = this.pc.w * (.9 + .1 * st.pc), bh = this.pc.h;
      ctx.shadowColor = this.alpha(c.accent, .55); ctx.shadowBlur = 22 * s * st.pc;
      ctx.fillStyle = c.bg; ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5;
      this.rrect(x - bw / 2, y - bh / 2, bw, bh, 4); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      this.text('YOUR PC', x, y - bh * .12, { size: (this.small ? 13 : 17 * ms), color: c.fg, weight: 800, align: 'center', display: true, track: .6 });
      const pcSub = !this.started && !reduceMotion.matches && !isOg ? 'STARTING' : this.sc === 'closed' ? 'APPS CLOSED' : 'LAB PC';
      this.text(pcSub, x, y + bh * .24, { size: 9.5 * (this.small ? 1 : ms), color: c.accent, mono: true, align: 'center', track: 1.6 });
      ctx.restore();

      // lab clock during the after-close replay
      if (st.labT != null) {
        const cy2 = y + bh / 2 + (this.small ? 18 : 28 * ms);
        this.text(st.replayDone ? 'LAB CLOCK · END OF CAPTURE' : 'LAB CLOCK · 1 S = 4 MIN', x, cy2, { size: 9.5 * (this.small ? 1 : ms), color: c.muted, mono: true, align: 'center', track: 1.4 });
        this.text(clock(st.labT), x, cy2 + (this.small ? 18 : 24 * ms), { size: (this.small ? 18 : 26 * ms), color: c.fg, mono: true, weight: 600, align: 'center' });
        const ev = [...this.timeline.events].reverse().find(e => secs(e.time) <= st.labT);
        if (ev && ev !== this.lastEvent) { this.lastEvent = ev; this.evAt = now; if (!this.hover) this.showReadout(null); }
        if (ev && !this.small) {
          const fade = live ? ease((now - (this.evAt || 0)) / 400) : 1;
          this.text(ev.text, x, cy2 + 54 * ms, { size: 13 * ms, color: this.alpha(c.fg, .9 * fade), align: 'center' });
        }
      }
    }
    rrect(x, y, w, h, r) {
      const ctx = this.ctx;
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    text(str, x, y, o) {
      const ctx = this.ctx;
      ctx.font = `${o.weight || 400} ${Math.max(12, o.size)}px ${o.mono ? this.fontMono : this.fontDisplay}`;
      ctx.fillStyle = o.color; ctx.textAlign = o.align || 'left'; ctx.textBaseline = 'middle';
      if ('letterSpacing' in ctx) ctx.letterSpacing = (o.track || 0) + 'px';
      ctx.fillText(str, x, y);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    alpha(col, a) {
      if (col.startsWith('#')) {
        const n = parseInt(col.length === 4 ? col.slice(1).split('').map(ch => ch + ch).join('') : col.slice(1, 7), 16);
        return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
      }
      return col;
    }
    pick(e, tap) {
      const r = this.cv.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      let best = null, bd = tap ? 30 : 22;
      const pcHit = Math.abs(px - this.pc.x) < this.pc.w / 2 && Math.abs(py - this.pc.y) < this.pc.h / 2;
      for (const n of [...this.nodes, ...this.hosts.filter(H => H.a > .5)]) {
        const d = Math.hypot(n.x - px, n.y - py);
        if (d < bd) { bd = d; best = n; }
      }
      if (!best && pcHit) best = this.pc;
      if (best !== this.hover) {
        this.hover = best;
        this.cv.style.cursor = best ? 'pointer' : 'default';
        this.showReadout(best);
        this.drawStatic();
      }
    }
    showReadout(n) {
      if (!readout) return;
      const scLabel = D.scenarios[this.sc];
      if (!n || n === this.pc) {
        if (this.timeline) {
          const ev = this.lastEvent || this.timeline.events.at(-1);
          // without motion the whole timeline is listed at once
          const evs = reduceMotion.matches ? this.timeline.events : [ev];
          readout.innerHTML = `<div class="meta">${esc(scLabel.toUpperCase())} · ${reduceMotion.matches ? 'OUR CAPTURE' : 'REPLAY OF OUR CAPTURE'}, ${esc(fmtDate(latestMeasured(byId.acrobat).date).toUpperCase())}</div>
            ${evs.map(e => `<p><b class="num">${esc(e.time.slice(0, 5))}</b> ${esc(e.text)}</p>`).join('')}`;
          return;
        }
        const q = this.nodes.filter(x => x.app.kind === 'craft' && x.state.kind === 'quiet');
        const t = this.nodes.filter(x => x.state.kind === 'traffic');
        readout.innerHTML = `<div class="meta">${esc(scLabel.toUpperCase())} · HOVER OR TAP A NODE</div>
          <p><b class="num">${q.length}</b> Craft app${q.length === 1 ? '' : 's'} measured at <b class="num">0</b> connections. ${t.length ? t.map(x => `${esc(shortName(x.app))}: <b class="num">${x.state.count}</b> hosts`).join(' · ') + '.' : 'No paid app measured in this state.'}</p>`;
        return;
      }
      if (n.host) {
        const m = n.meta || {};
        const extra = [m.time ? 'at ' + m.time : '', m.requests ? m.requests + ' requests' : '', m.mb_up ? m.mb_up + ' MB sent' : '', m.kb_up ? m.kb_up + ' KB sent' : '', m.mb_down ? m.mb_down + ' MB received' : ''].filter(Boolean).join(' · ');
        const v = latestMeasured(n.app);
        readout.innerHTML = `<h3 class="mono">${esc(n.host)}</h3><div class="meta">${esc(m.process || shortName(n.app))} · ${esc(scLabel.toLowerCase())} · ${esc(v.version)} · ${esc(fmtDate(v.date))}</div>
          ${extra ? `<p class="num">${esc(extra)}</p>` : ''}${m.note ? `<p>${esc(m.note)}</p>` : ''}`;
        return;
      }
      const st = n.state, v = st.v;
      let body = '';
      if (st.kind === 'traffic') {
        const hosts = distinctHosts(v, this.sc);
        body = `<div class="big">${st.count}<small>hosts</small></div><p>${esc(st.c.how)}.</p><ul>${hosts.slice(0, 30).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
      } else if (st.kind === 'quiet') {
        body = `<div class="big">0<small>${st.text.includes('left') ? 'left running' : 'connections'}</small></div><p>${esc(st.c.how)}.</p>`;
      } else if (st.kind === 'unmeasured') {
        body = `<p>Not measured in this state for ${esc(v.version)}.</p>`;
      } else {
        body = `<p>${esc(latest(n.app).summary || 'Test coming.')}</p>`;
      }
      const lt = latest(n.app);
      const vline = v ? `${esc(v.version)} · ${esc(fmtDate(v.date))} · ${esc(v.platform)}` : (lt.version ? esc(lt.version) + ' · coming' : 'no result yet');
      readout.innerHTML = `<h3>${esc(n.app.name)}</h3><div class="meta">${vline}</div>${body}`;
    }
  }

  if (isOg) {
    const t = $('.map-title');
    if (t) t.innerHTML = 'The Hardened Stack · Craft Scoreboard<b>Free Craft apps, measured on a real PC</b>';
  }
  if (canvas && canvas.getContext) {
    map = new LabMap(canvas);
    map.showReadout(null);
    const segBtns = document.querySelectorAll('[data-sc]');
    let cycle = null;
    const setSc = sc => { segBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sc === sc))); map.setScenario(sc); };
    segBtns.forEach(b => b.addEventListener('click', () => { clearTimeout(cycle); setSc(b.dataset.sc); }));
    const rp = $('#replay');
    if (rp) rp.addEventListener('click', () => { clearTimeout(cycle); if (map.sc === 'working') map.booted = false; map.replay(); });
    // stage view (screen recordings): boot, hold, the after-close replay, then loop
    if (isStage && !/[?&]hold\b/.test(location.search)) {
      const next = () => { const sc = map.sc === 'working' ? 'closed' : 'working'; setSc(sc); cycle = setTimeout(next, sc === 'closed' ? 16000 : 8000); };
      cycle = setTimeout(next, 8000);
    }
    if (/[?&]sc=closed\b/.test(location.search)) setSc('closed');
    document.fonts && document.fonts.ready.then(() => map.recolor());
  }

  /* ── Count-up for numbers entering the screen ─────────────────────────── */
  function countUp(el, to, decimals) {
    const t0 = performance.now(), dur = 900;
    const step = now => {
      const p = ease((now - t0) / dur);
      el.textContent = (to * p).toFixed(decimals);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ── App cards ─────────────────────────── */
  const gradePill = g => g ? `<span class="pill ${g}">${g}</span>` : '';
  const newPill = v => isNew(v) ? '<span class="pill new">New</span>' : '';
  const connCell = (app, sc) => {
    const st = connState(app, sc);
    const cls = st.kind === 'quiet' ? 'q' : st.kind === 'traffic' ? 't' : 'u';
    const txt = st.kind === 'quiet' ? '0' : st.kind === 'traffic' ? `${st.count} hosts` : st.text;
    return `<div class="n ${cls}">${esc(txt)}</div>`;
  };
  function scoreRow(app, cls) {
    // a retest of one job has no full score: show the newest version that has one
    const v = [...measured(app)].reverse().find(x => x.score != null);
    const lt = latest(app);
    const name = shortName(app);
    if (!v || v.score == null) {
      const why = lt.status === 'not_tested' ? 'Not run in our lab' : `${lt.version ? lt.version + ' · ' : ''}test coming`;
      return `<div class="score-row"><div class="score-top"><span class="who">${esc(name)}</span><span class="val">–</span></div><div class="bar ${cls} empty"><i></i></div><div class="score-cap">${esc(why)}</div></div>`;
    }
    const dec = Number.isInteger(v.score) ? 0 : 1;
    return `<div class="score-row"><div class="score-top"><span class="who">${esc(name)}</span><span class="val"><span class="cu" data-to="${v.score}" data-dec="${dec}">${v.score}</span><small>/${v.of}</small></span></div>
      <div class="bar ${cls}" data-w="${(v.score / v.of * 100).toFixed(1)}"><i></i></div>
      <div class="score-cap">${esc(v.version)} · ${esc(fmtDate(v.date))} · ${esc(v.platform)}</div></div>`;
  }
  function timeline(app) {
    const pts = app.versions.map(v => ({ v: v.version, p: parseVer(v.version), date: v.date, coming: v.status !== 'measured' }));
    const ls = app.latest_seen && parseVer(app.latest_seen.version);
    if (ls && !pts.some(x => cmpVer(x.p, ls) === 0)) pts.push({ v: app.latest_seen.version, p: ls, release: true, date: app.latest_seen.checked });
    pts.sort((a, b) => cmpVer(a.p, b.p));
    const num = p => p[0] * 1000 + p[1] + p[2] / 100;
    const lo = num(pts[0].p), hi = num(pts.at(-1).p);
    const pos = x => pts.length === 1 ? 0 : (num(x.p) - lo) / (hi - lo) * 100;
    const lastTested = [...pts].reverse().find(x => !x.coming && !x.release);
    const nodes = pts.map((x, i) => {
      const cls = ['tl-node', x.release ? 'release' : x.coming ? 'coming' : '', i === 0 ? 'first' : '', i === pts.length - 1 && pts.length > 1 ? 'last' : ''].join(' ');
      const sub = x.release ? 'newest seen' : x.coming ? 'test coming' : fmtDate(x.date);
      return `<div class="${cls}" data-left="${pos(x)}"><i></i><span>${esc(x.v)}<small>${esc(sub)}</small></span></div>`;
    }).join('');
    const tested = lastTested ? `<div class="tested" data-left="0" data-width="${pos(lastTested)}"></div>` : '';
    return `<div class="timeline" role="img" aria-label="${esc(app.name)} versions: ${esc(pts.map(x => x.v + (x.coming ? ' (test coming)' : x.release ? ' (newest release seen)' : ' (tested)')).join(', '))}"><div class="track"></div>${tested}${nodes}</div>`;
  }
  function chips(app) {
    const ms = measured(app);
    const first = ms[0];
    const last = latest(app);
    return `<ul class="chips">${app.tracked.map(t => {
      const a = first && first.results && first.results[t.key];
      const b = last !== first ? last.results && last.results[t.key] : undefined;
      const fmt = (v, r) => {
        if (!r) return `<span class="v">${esc(v.version)}</span><span class="q">?</span>`;
        const val = t.key === 'connections' ? `${r.value} connections` : r.value;
        return `<span class="v">${esc(v.version)}</span><span>${esc(val)}</span>${gradePill(r.grade)}`;
      };
      let line;
      if (!first) line = fmt(last, null) + ' <span class="v">first test coming</span>';
      else if (last === first) line = fmt(first, a);
      else line = `${fmt(first, a)}<span class="arrow" aria-label="then, now">→</span>${fmt(last, b)}`;
      return `<li class="chip"><span class="what">${esc(t.label)}</span><span class="tn">${line}</span></li>`;
    }).join('')}</ul>`;
  }
  function proof(app) {
    const v = measured(app).find(x => x.proof);
    if (!v) return '';
    const p = v.proof;
    return `<figure class="proof" data-proof>
      <div class="proof-stage" data-ar="${p.width / p.height}">
        <img src="${esc(p.before)}" width="${p.width}" height="${p.height}" alt="${esc(p.before_caption)}" loading="lazy" decoding="async">
        <img class="after" src="${esc(p.after)}" width="${p.width}" height="${p.height}" alt="${esc(p.after_caption)}" loading="lazy" decoding="async">
        <span class="proof-tag before">Before</span><span class="proof-tag after">After Apply</span>
        <span class="proof-handle" aria-hidden="true"></span>
        <input type="range" id="proof-${esc(app.id)}" min="0" max="100" value="50" aria-label="Drag to compare before and after: ${esc(p.label)}">
      </div>
      <figcaption>
        <span class="label">Proof from the lab · ${esc(app.name)} ${esc(v.version)}</span>
        <span class="proof-what">${esc(p.label)}</span>
        <span class="proof-step"><i class="pill coming">Before</i> ${esc(p.before_caption.replace(/^Before:\s*/, ''))}</span>
        <span class="proof-step"><i class="pill fail">After</i> <b>${esc(p.after_caption.replace(/^After Apply:\s*/, ''))}</b></span>
        <span class="proof-hint">Drag the line to compare.</span>
        <span class="mono proof-src">${esc(p.source)}</span>
      </figcaption>
    </figure>`;
  }
  function videos(app) {
    const out = app.versions.map((v, i, arr) => v.video
      ? `<a class="btn ${i === arr.length - 1 || !arr[i + 1].video ? 'primary' : ''}" href="${esc(ytUrl(v.video.id))}" rel="noopener" title="${esc(v.video.title)}">Watch the ${esc(v.version)} test</a>`
      : `<span class="pill coming">${esc(v.version)} video coming</span>`);
    return `<div class="videos">${out.join('')}</div>`;
  }
  function card(app) {
    const paid = byId[app.compare_to];
    const v = latestMeasured(app) || latest(app);
    return `<article class="app" id="${esc(app.id)}" aria-labelledby="h-${esc(app.id)}">
      <header class="app-head">
        <h3 id="h-${esc(app.id)}">${esc(app.name)}</h3>${newPill(latestMeasured(app))}
        <span class="vs">vs <b>${esc(paid.name)}</b> · ${esc(app.category)}</span>
        <div class="tools"><button type="button" class="btn" data-copy="${esc(app.id)}">Copy link</button><a class="btn" href="${esc(app.source_url)}" rel="noopener">Source code</a></div>
      </header>
      <div class="app-body">
        <div>
          <div class="label">Score on the same jobs</div>
          <div class="scores">${scoreRow(app, '')}${scoreRow(paid, 'paid')}</div>
          <p class="summary">${esc(v.summary)}</p>
          ${v.status === 'measured' && v.use_for ? `<ul class="fit"><li><span class="k yes">Use it for</span><span>${esc(v.use_for)}</span></li><li><span class="k not">Not yet for</span><span>${esc(v.not_yet_for)}</span></li></ul>` : ''}
          <div class="conn">
            <div class="h side"></div><div class="h">${esc(app.name)}</div><div class="h">${esc(shortName(paid))}</div>
            <div class="h side">${esc(D.scenarios.working)}</div>${connCell(app, 'working')}${connCell(paid, 'working')}
            <div class="h side">${esc(D.scenarios.closed)}</div>${connCell(app, 'closed')}${connCell(paid, 'closed')}
          </div>
        </div>
        <div>
          <div class="label">Versions tested</div>
          ${timeline(app)}
          <div class="label chips-label">Then → now</div>
          ${chips(app)}
          ${videos(app)}
        </div>
      </div>
      ${proof(app)}
    </article>`;
  }

  // below-the-fold UI renders in its own task so the first paint isn't held up
  const later = fn => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 1));
  later(() => { renderCards(); renderChecker(); });

  function renderCards() {
    const appsEl = $('#apps-list');
    if (!appsEl) return;
    // one card per task, so no single task blocks the page for long (Lighthouse TBT on phones)
    appsEl.innerHTML = '';
    let i = 0;
    const next = () => {
      appsEl.insertAdjacentHTML('beforeend', card(crafts[i++]));
      if (i < crafts.length) setTimeout(next, 0); else setTimeout(() => wireCards(appsEl), 0);
    };
    next();
  }

  function wireCards(appsEl) {
    // positions go through CSSOM: the page's CSP blocks inline style attributes
    appsEl.querySelectorAll('[data-w]').forEach(el => el.style.setProperty('--w', el.dataset.w + '%'));
    appsEl.querySelectorAll('[data-left]').forEach(el => el.style.setProperty('left', el.dataset.left + '%'));
    appsEl.querySelectorAll('[data-width]').forEach(el => el.style.setProperty('width', el.dataset.width + '%'));
    appsEl.querySelectorAll('[data-ar]').forEach(el => el.style.setProperty('aspect-ratio', el.dataset.ar));

    // "new since your last visit" banner
    const fresh = D.apps.flatMap(a => a.versions.filter(isNew).map(v => `${a.short || a.name} ${v.version}`));
    const banner = $('#new-banner');
    if (banner && fresh.length) {
      banner.innerHTML = `<span class="pill new">New</span> ${fresh.length} result${fresh.length === 1 ? '' : 's'} since your last visit on ${esc(fmtDate(lastVisit))}: ${esc(fresh.join(', '))}.`;
      banner.hidden = false;
    }

    // before/after sliders
    appsEl.querySelectorAll('[data-proof]').forEach(fig => {
      const input = $('input', fig), after = $('img.after', fig), handle = $('.proof-handle', fig);
      const set = v => { after.style.setProperty('clip-path', `inset(0 0 0 ${v}%)`); handle.style.setProperty('left', v + '%'); };
      input.addEventListener('input', () => { fig.dataset.touched = '1'; set(input.value); });
      set(input.value);
      fig.setPos = v => { if (!fig.dataset.touched) { input.value = v; set(v); } };
    });

    // the slider peeks once when it comes into view: towards the blank page, a pause, then back
    const peek = fig => {
      const t0 = performance.now();
      const step = now => {
        const t = (now - t0) / 1000;
        const v = t < 1.1 ? 50 - 42 * ease(t / 1.1) : t < 2.2 ? 8 : 8 + 42 * ease((t - 2.2) / 1);
        fig.setPos(v);
        if (t < 3.2) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if (!reduceMotion.matches && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => es.forEach(e => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        if (e.target.matches('[data-proof]')) { peek(e.target); return; }
        e.target.classList.remove('pre'); e.target.classList.add('in');
        e.target.querySelectorAll('.cu').forEach(n => countUp(n, +n.dataset.to, +n.dataset.dec));
      }), { threshold: .35 });
      // read every position first, then write: one layout instead of one per card
      const below = [...appsEl.querySelectorAll('.scores')].filter(el => el.getBoundingClientRect().top > innerHeight);
      below.forEach(el => { el.classList.add('pre'); io.observe(el); });
      appsEl.querySelectorAll('[data-proof]').forEach(el => io.observe(el));
    }
    if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  }

  /* ── Is my version behind? ─────────────────────────── */
  function renderChecker() {
    const form = $('#checker');
    if (!form) return;
    const sel = $('#chk-app'), inp = $('#chk-ver'), out = $('#chk-out'), ex = $('#chk-example');
    sel.innerHTML = crafts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    const render = () => {
      const app = byId[sel.value];
      const ls = app.latest_seen;
      const lsP = parseVer(ls.version);
      const p = parseVer(inp.value);
      if (!inp.value.trim()) { out.innerHTML = `<p class="muted">Type the version you have installed, for example <span class="mono">${esc(measured(app)[0] ? measured(app)[0].version : ls.version)}</span>.</p>`; return; }
      if (!p) { out.innerHTML = `<p>That doesn't look like a version number. Type it like <span class="mono">0.9.0</span>.</p>`; return; }
      const mine = `${p[0]}.${p[1]}.${p[2]}`;
      const seen = `${ls.version}, the newest release we had seen (checked ${fmtDate(ls.checked)})`;
      let gap, gapLabel;
      const c = cmpVer(p, lsP);
      if (c > 0) { gap = '0'; gapLabel = `newer than ${seen}`; }
      else if (c === 0) { gap = '0'; gapLabel = `versions behind: ${seen}`; }
      else if (p[0] === lsP[0] && p[1] === lsP[1]) { const n = lsP[2] - p[2]; gap = String(n); gapLabel = `patch release${n === 1 ? '' : 's'} behind ${seen}`; }
      else if (p[0] === lsP[0]) { const n = lsP[1] - p[1]; gap = String(n); gapLabel = `minor version${n === 1 ? '' : 's'} behind ${seen}`; }
      else { const n = lsP[0] - p[0]; gap = String(n); gapLabel = `major version${n === 1 ? '' : 's'} behind ${seen}`; }
      const exact = app.versions.find(v => { const q = parseVer(v.version); return q && cmpVer(q, p) === 0; });
      const newer = app.versions.filter(v => { const q = parseVer(v.version); return q && cmpVer(q, p) > 0; });
      const older = app.versions.filter(v => { const q = parseVer(v.version); return q && cmpVer(q, p) < 0 && v.status === 'measured'; });
      const line = v => {
        if (v.status !== 'measured') return `<li><span class="mono">${esc(v.version)}</span> <span class="pill coming">test coming</span> <span>${esc(v.summary)}</span></li>`;
        const rs = app.tracked.map(t => v.results[t.key] ? `${esc(t.label)}: ${esc(t.key === 'connections' ? v.results[t.key].value + ' connections' : v.results[t.key].value)}` : '').filter(Boolean).join(' · ');
        return `<li><span class="mono">${esc(v.version)}</span> <span class="pill ${v.score / v.of >= .9 ? 'pass' : 'partial'}">${v.score}/${v.of}</span> <span>${rs} <span class="muted">(${esc(fmtDate(v.date))})</span></span></li>`;
      };
      let found = '';
      if (exact) found += `<p><b>We tested ${esc(mine)}.</b></p><ul>${line(exact)}</ul>`;
      else found += `<p><b>We haven't tested ${esc(mine)}.</b> ${older.length ? `The closest older version we tested is ${esc(older.at(-1).version)}.` : ''}</p>${older.length ? `<ul>${line(older.at(-1))}</ul>` : ''}`;
      if (newer.length) found += `<p class="muted">Newer versions in our tests:</p><ul>${newer.map(line).join('')}</ul>`;
      out.innerHTML = `<div class="gap">${esc(gap)}<small>${esc(gapLabel)}</small></div>${found}
        <p class="muted">These are our lab results for the versions shown. A version we haven't tested can behave differently. <a href="#${esc(app.id)}">See the ${esc(app.name)} card</a>.</p>`;
    };
    sel.value = 'pdfcraft'; inp.value = '0.9.0';
    const clearEx = () => { if (ex) ex.hidden = true; };
    sel.addEventListener('change', () => { clearEx(); render(); });
    inp.addEventListener('input', () => { clearEx(); render(); });
    form.addEventListener('submit', e => { e.preventDefault(); render(); });
    render();
  }
})();
