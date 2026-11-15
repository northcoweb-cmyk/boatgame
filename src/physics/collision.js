// 2D (water-plane) collision world. Static colliders (pilings, docks, seawall
// segments, rocks, buoys, bridge piers, moored boats) live in a spatial hash;
// dynamic colliders (AI boats) are tested directly. Boats collide as a chain
// of circles fitted to the hull outline. Impulse response deflects and scrapes
// rather than bouncing, and reports impacts for damage / FFB / audio / camera.
import { Vector3 } from 'three';
import { clamp } from '../core/math.js';

const CELL = 40;
const _p = new Vector3();
const _n = new Vector3();
const _v = new Vector3();
const _j = new Vector3();
const _c = new Vector3();
const _t = new Vector3();

export class CollisionWorld {
  constructor() {
    this.cells = new Map();
    this.colliders = [];
    this.dynamic = [];
    this._seen = 0;
  }

  _key(ix, iz) { return ix * 73856093 ^ iz * 19349663; }

  add(c) {
    c.id = this.colliders.length;
    c.mark = 0;
    c.damage = c.damage ?? 1;
    c.yMin = c.yMin ?? -50;
    c.yMax = c.yMax ?? 50;
    this.colliders.push(c);
    let x0, x1, z0, z1;
    if (c.type === 'circle') { x0 = c.x - c.r; x1 = c.x + c.r; z0 = c.z - c.r; z1 = c.z + c.r; }
    else if (c.type === 'segment') { x0 = Math.min(c.ax, c.bx) - c.r; x1 = Math.max(c.ax, c.bx) + c.r; z0 = Math.min(c.az, c.bz) - c.r; z1 = Math.max(c.az, c.bz) + c.r; }
    else { // obb
      c.cos = Math.cos(c.angle); c.sin = Math.sin(c.angle);
      const ex = Math.abs(c.hx * c.cos) + Math.abs(c.hz * c.sin), ez = Math.abs(c.hx * c.sin) + Math.abs(c.hz * c.cos);
      x0 = c.x - ex; x1 = c.x + ex; z0 = c.z - ez; z1 = c.z + ez;
    }
    for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
      for (let iz = Math.floor(z0 / CELL); iz <= Math.floor(z1 / CELL); iz++) {
        const k = this._key(ix, iz);
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k).push(c);
      }
    }
    return c;
  }
  addCircle(x, z, r, opts = {}) { return this.add({ type: 'circle', x, z, r, ...opts }); }
  addSegment(ax, az, bx, bz, r, opts = {}) { return this.add({ type: 'segment', ax, az, bx, bz, r, ...opts }); }
  addBox(x, z, hx, hz, angle, opts = {}) { return this.add({ type: 'obb', x, z, hx, hz, angle, ...opts }); }

  query(x, z, r, out) {
    out.length = 0;
    this._seen++;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this.cells.get(this._key(ix, iz));
        if (!list) continue;
        for (const c of list) { if (c.mark !== this._seen) { c.mark = this._seen; out.push(c); } }
      }
    }
    for (const d of this.dynamic) if (Math.hypot(d.x - x, d.z - z) < r + d.reach) out.push(d);
    return out;
  }

  // circle (x,z,r) vs collider -> fills res {pen, nx, nz, px, pz}; returns bool
  static circleVs(c, x, z, r, res) {
    let cx, cz, cr;
    if (c.type === 'circle') { cx = c.x; cz = c.z; cr = c.r; }
    else if (c.type === 'segment') {
      const dx = c.bx - c.ax, dz = c.bz - c.az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? clamp(((x - c.ax) * dx + (z - c.az) * dz) / l2, 0, 1) : 0;
      cx = c.ax + dx * t; cz = c.az + dz * t; cr = c.r;
    } else {
      // obb: closest point in box frame
      const lx = (x - c.x) * c.cos + (z - c.z) * c.sin;
      const lz = -(x - c.x) * c.sin + (z - c.z) * c.cos;
      const qx = clamp(lx, -c.hx, c.hx), qz = clamp(lz, -c.hz, c.hz);
      if (qx === lx && qz === lz) {
        // centre inside the box: push out along the shallowest axis
        const ox = c.hx - Math.abs(lx), oz = c.hz - Math.abs(lz);
        let nlx = 0, nlz = 0, pen;
        if (ox < oz) { nlx = Math.sign(lx) || 1; pen = ox + r; } else { nlz = Math.sign(lz) || 1; pen = oz + r; }
        res.nx = nlx * c.cos - nlz * c.sin; res.nz = nlx * c.sin + nlz * c.cos; res.pen = pen;
        res.px = x - res.nx * r; res.pz = z - res.nz * r;
        return true;
      }
      cx = c.x + qx * c.cos - qz * c.sin; cz = c.z + qx * c.sin + qz * c.cos; cr = 0;
    }
    const dx = x - cx, dz = z - cz;
    const d = Math.hypot(dx, dz);
    const pen = r + cr - d;
    if (pen <= 0) return false;
    res.nx = d > 1e-6 ? dx / d : 1; res.nz = d > 1e-6 ? dz / d : 0;
    res.pen = pen;
    res.px = x - res.nx * r; res.pz = z - res.nz * r;
    return true;
  }
}

// Hull outline -> chain of circles in body space.
export function hullCircles(def) {
  const L = def.length, B = def.beam;
  const bowZ = -L * (1 - def.comFromStern), sternZ = L * def.comFromStern;
  const n = Math.max(4, Math.round(L / (B * 0.55)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const z = bowZ + (sternZ - bowZ) * t;
    const w = t < 0.35 ? 0.35 + 0.65 * Math.sin((t / 0.35) * Math.PI / 2) : 1;
    out.push({ z, r: B * 0.5 * w * 0.98 });
  }
  return out;
}

const _res = { pen: 0, nx: 0, nz: 0, px: 0, pz: 0 };
const _list = [];

// Resolve contacts for a boat; returns strongest impact {speed, x, z, nx, nz, collider} or null.
export function resolveBoatCollisions(phys, circles, world, out) {
  const b = phys.body;
  let best = null, bestSpeed = 0;
  const reach = phys.def.length * 0.6 + 2;
  world.query(b.pos.x, b.pos.z, reach, _list);
  if (_list.length === 0) return null;
  for (const hc of circles) {
    _c.set(0, 0, hc.z);
    b.localToWorld(_c, _p);
    for (const c of _list) {
      if (b.pos.y + 1.5 < c.yMin || b.pos.y - 1.5 > c.yMax) continue;
      if (!CollisionWorld.circleVs(c, _p.x, _p.z, hc.r, _res)) continue;
      _n.set(_res.nx, 0, _res.nz);
      _t.set(_res.px, _p.y, _res.pz);
      b.pointVelocity(_t, _v);
      if (c.vx !== undefined) { _v.x -= c.vx; _v.z -= c.vz; }
      const vn = _v.dot(_n);
      // positional correction (horizontal only)
      const corr = Math.max(0, _res.pen - 0.01) * 0.85;
      b.pos.x += _n.x * corr; b.pos.z += _n.z * corr;
      if (vn < 0) {
        const e = c.bouncy ?? 0.12;
        const k = b.invMassAt(_t, _n);
        const jn = (-(1 + e) * vn) / k;
        _j.copy(_n).multiplyScalar(jn);
        // friction: scrape along the obstacle
        const vtx = _v.x - _n.x * vn, vtz = _v.z - _n.z * vn;
        const vt = Math.hypot(vtx, vtz);
        if (vt > 1e-4) {
          const jt = Math.min(0.35 * jn, vt / k);
          _j.x -= (vtx / vt) * jt; _j.z -= (vtz / vt) * jt;
        }
        b.applyImpulseAtPoint(_j, _t);
        if (c.onHit) c.onHit(-vn, _n);
        if (-vn > bestSpeed) {
          bestSpeed = -vn;
          best = out;
          out.speed = -vn; out.x = _t.x; out.y = _t.y; out.z = _t.z; out.nx = _n.x; out.nz = _n.z; out.collider = c;
        }
      }
    }
  }
  return best;
}
