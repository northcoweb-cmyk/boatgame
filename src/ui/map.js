// Nautical chart: baked once from the height field (depth tints, 1/2/5/8 m
// contours, land, channels, bridges), used by the heading-up minimap and the
// full-screen chart (zoom, pan, centre, destination markers, your trail).
import { WORLD_HALF, WORLD_SIZE, MARINAS, DESTINATIONS, BRIDGES, CHANNELS, urbanMask } from '../world/geography.js';
import { clamp } from '../core/math.js';

const RES = 1024;

export class ChartMap {
  constructor(game) {
    this.game = game;
    this.img = this.bake();
    this.mini = document.getElementById('minimap');
    this.mctx = this.mini.getContext('2d');
    this.canvas = document.getElementById('chart-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.zoom = 1; this.miniZoom = 1;
    this.center = { x: 0, z: 0 };
    this.trail = [];
    this.open = false;
    let drag = null;
    this.canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: this.center.x, cz: this.center.z }; });
    window.addEventListener('mouseup', () => { drag = null; });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const s = this.scale();
      this.center.x = drag.cx - (e.clientX - drag.x) / s;
      this.center.z = drag.cz - (e.clientY - drag.y) / s;
    });
    this.canvas.addEventListener('wheel', (e) => { this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 0.85 : 1.18), 0.6, 8); }, { passive: true });
  }

  bake() {
    const t = this.game.terrain;
    const c = document.createElement('canvas');
    c.width = c.height = RES;
    const g = c.getContext('2d');
    const im = g.createImageData(RES, RES);
    const H = new Float32Array(RES * RES);
    for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
      const x = -WORLD_HALF + (i + 0.5) * WORLD_SIZE / RES, z = -WORLD_HALF + (j + 0.5) * WORLD_SIZE / RES;
      H[j * RES + i] = t.sampleBaked(x, z);
    }
    for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
      const h = H[j * RES + i];
      const k = (j * RES + i) * 4;
      let r, gg, b;
      if (h > 0) {
        const x = -WORLD_HALF + (i + 0.5) * WORLD_SIZE / RES, z = -WORLD_HALF + (j + 0.5) * WORLD_SIZE / RES;
        const u = urbanMask(x, z);
        const sand = h < 1.2 ? 1 : 0;
        r = sand ? 232 : 214 - u * 40; gg = sand ? 214 : 205 - u * 40; b = sand ? 170 : 168 - u * 20;
      } else {
        const d = -h;
        const tt = clamp(d / 9, 0, 1);
        r = 120 - 100 * tt; gg = 225 - 135 * tt; b = 228 - 70 * tt;
      }
      // contours
      const hr = H[j * RES + Math.min(RES - 1, i + 1)], hd = H[Math.min(RES - 1, j + 1) * RES + i];
      for (const cv of [-1, -2, -5, -8]) if ((h - cv) * (hr - cv) < 0 || (h - cv) * (hd - cv) < 0) { r *= 0.7; gg *= 0.78; b *= 0.85; }
      if ((h > 0) !== (hr > 0) || (h > 0) !== (hd > 0)) { r = 40; gg = 70; b = 90; }
      im.data[k] = r; im.data[k + 1] = gg; im.data[k + 2] = b; im.data[k + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    const P = (x, z) => [(x + WORLD_HALF) / WORLD_SIZE * RES, (z + WORLD_HALF) / WORLD_SIZE * RES];
    // channels (dashed magenta like real charts)
    g.setLineDash([6, 6]); g.strokeStyle = 'rgba(200,60,160,0.55)'; g.lineWidth = 1.5;
    for (const ch of CHANNELS) { g.beginPath(); ch.pts.forEach((p, i) => { const [a, b] = P(p[0], p[1]); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke(); }
    g.setLineDash([]);
    // bridges
    g.strokeStyle = 'rgba(30,30,30,0.85)'; g.lineWidth = 3;
    const tut = BRIDGES[0]; let [a, b] = P(tut.x0, tut.z); let [c2, d2] = P(tut.x1, tut.z); g.beginPath(); g.moveTo(a, b); g.lineTo(c2, d2); g.stroke();
    for (const [x0, x1] of BRIDGES[1].spans) { [a, b] = P(x0, BRIDGES[1].z); [c2, d2] = P(x1, BRIDGES[1].z); g.beginPath(); g.moveTo(a, b); g.lineTo(c2, d2); g.stroke(); }
    return c;
  }

  W2C(x, z) { return [(x + WORLD_HALF) / WORLD_SIZE * RES, (z + WORLD_HALF) / WORLD_SIZE * RES]; }

  addTrail(x, z) {
    const l = this.trail[this.trail.length - 1];
    if (!l || Math.hypot(l[0] - x, l[1] - z) > 25) { this.trail.push([x, z]); if (this.trail.length > 2000) this.trail.shift(); }
  }

  markers() {
    const g = this.game;
    const list = [];
    for (const m of MARINAS) list.push({ x: m.x, z: m.z, c: '#ffd166', label: m.name, icon: '⚓' });
    for (const d of DESTINATIONS) if (d.kind !== 'marina') list.push({ x: d.x, z: d.z, c: '#ff8f7a', label: d.name, icon: d.kind === 'lighthouse' ? '✦' : '●' });
    if (g.villas.home) list.push({ x: g.villas.home.lot.x, z: g.villas.home.lot.z, c: '#ffffff', label: 'Home', icon: '⌂' });
    return list;
  }

  drawMini(dt) {
    const g = this.game, ctx = this.mctx, W = this.mini.width;
    const p = g.player.pos;
    const hdg = g.player.mode === 'helm' && g.boat ? g.boat.phys.heading : (() => { const d = g.camera.getWorldDirection(this._d || (this._d = g.camera.position.clone())); return Math.atan2(d.x, -d.z); })();
    ctx.save();
    ctx.clearRect(0, 0, W, W);
    ctx.beginPath(); ctx.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2); ctx.clip();
    const span = 900 / this.miniZoom; // metres across
    const s = W / span * WORLD_SIZE / RES; // canvas px per chart px
    ctx.translate(W / 2, W / 2);
    ctx.rotate(-hdg);
    const [cx, cz] = this.W2C(p.x, p.z);
    ctx.globalAlpha = 0.92;
    ctx.drawImage(this.img, -cx * s, -cz * s, RES * s, RES * s);
    ctx.globalAlpha = 1;
    const toM = (x, z) => [((x - p.x) / span) * W, ((z - p.z) / span) * W];
    // trail
    ctx.strokeStyle = 'rgba(63,184,255,0.8)'; ctx.lineWidth = 2; ctx.beginPath();
    this.trail.slice(-200).forEach((t, i) => { const [a, b] = toM(t[0], t[1]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
    ctx.stroke();
    for (const m of this.markers()) {
      const [a, b] = toM(m.x, m.z);
      if (Math.abs(a) > W || Math.abs(b) > W) continue;
      ctx.fillStyle = m.c; ctx.beginPath(); ctx.arc(a, b, 4, 0, Math.PI * 2); ctx.fill();
    }
    // AI boats
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (const ab of g.traffic.boats) { const [a, b] = toM(ab.x, ab.z); if (Math.abs(a) < W && Math.abs(b) < W) ctx.fillRect(a - 1.5, b - 1.5, 3, 3); }
    ctx.restore();
    // you (always up)
    ctx.fillStyle = '#5ff2ff';
    ctx.beginPath(); ctx.moveTo(W / 2, W / 2 - 9); ctx.lineTo(W / 2 + 6, W / 2 + 7); ctx.lineTo(W / 2, W / 2 + 3); ctx.lineTo(W / 2 - 6, W / 2 + 7); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 12px system-ui'; ctx.textAlign = 'center';
    ctx.save(); ctx.translate(W / 2, W / 2); ctx.rotate(-hdg); ctx.fillText('N', 0, -W / 2 + 16); ctx.restore();
    void dt;
  }

  scale() { return Math.min(this.canvas.width, this.canvas.height) / WORLD_SIZE * this.zoom; }

  drawChart() {
    const c = this.canvas;
    if (c.width !== c.clientWidth || c.height !== c.clientHeight) { c.width = c.clientWidth; c.height = c.clientHeight; }
    const ctx = this.ctx, s = this.scale();
    ctx.fillStyle = '#0a2a44'; ctx.fillRect(0, 0, c.width, c.height);
    const ox = c.width / 2 - (this.center.x + WORLD_HALF) * s, oy = c.height / 2 - (this.center.z + WORLD_HALF) * s;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.img, ox, oy, WORLD_SIZE * s, WORLD_SIZE * s);
    const P = (x, z) => [ox + (x + WORLD_HALF) * s, oy + (z + WORLD_HALF) * s];
    ctx.strokeStyle = 'rgba(63,184,255,0.9)'; ctx.lineWidth = 2; ctx.beginPath();
    this.trail.forEach((t, i) => { const [a, b] = P(t[0], t[1]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
    ctx.stroke();
    ctx.font = '600 13px system-ui'; ctx.textAlign = 'left';
    for (const m of this.markers()) {
      const [a, b] = P(m.x, m.z);
      ctx.fillStyle = m.c; ctx.beginPath(); ctx.arc(a, b, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(8,20,32,0.75)'; const w = ctx.measureText(m.label).width + 12; ctx.fillRect(a + 9, b - 10, w, 20);
      ctx.fillStyle = '#fff'; ctx.fillText(m.label, a + 15, b + 4);
    }
    const p = this.game.player.pos;
    const [a, b] = P(p.x, p.z);
    ctx.fillStyle = '#5ff2ff'; ctx.beginPath(); ctx.arc(a, b, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    // scale bar
    ctx.fillStyle = '#fff'; ctx.fillRect(c.width - 160, c.height - 30, 1000 * s, 3);
    ctx.fillText('1 km', c.width - 160, c.height - 38);
  }
}
