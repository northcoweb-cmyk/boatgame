// AI boat traffic that follows the Rules of the Road (COLREGs):
//  * routes on a navigation graph built from real water depth (no grounding)
//  * keep to starboard of the route, slow to no-wake speed near marinas,
//    sandbars and destinations
//  * Rule 14 head-on: both alter to starboard; Rule 15 crossing: the vessel
//    with the other on its starboard side gives way (slows + turns starboard,
//    passes astern); Rule 13 overtaking vessel keeps clear; Rule 17 stand-on
//    vessel holds course but takes last-moment action if the give-way vessel
//    (often the player!) doesn't act
//  * sound signals: one short blast when altering to starboard, five short
//    blasts (danger) when someone closes dangerously
//  * they ride the real waves and each other's wakes, throw wakes, and can be
//    hit: impulse exchange, damage, and sinking when their hull fails
import * as THREE from 'three';
import { heightAt, MARINAS, DESTINATIONS, SANDBARS, PLAY_LIMIT } from './geography.js';
import { bakeToVertexColor } from '../assets/assets.js';
import { KNOT, clamp, wrapAngle, rng, smoothstep } from '../core/math.js';
import { bus } from '../core/events.js';

const TYPES = [
  { model: 'runabout', len: 6.7, beam: 2.5, mass: 1400, cruise: [16, 26], weight: 5 },
  { model: 'yacht', len: 11.8, beam: 3.9, mass: 13000, cruise: [12, 20], weight: 3 },
  { model: 'rib', len: 4.1, beam: 1.9, mass: 300, cruise: [8, 12], weight: 2 },
  { model: 'bass', len: 6.6, beam: 2.3, mass: 1150, cruise: [20, 34], weight: 2 },
  { model: 'towboat', len: 11.2, beam: 3.8, mass: 6000, cruise: [14, 20], weight: 1, tow: true },
];

function waterLineClear(ax, az, bx, bz, minDepth = 1.6, lateral = 14) {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(2, Math.ceil(len / 18));
  const nx = -(bz - az) / len, nz = (bx - ax) / len;
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    if (heightAt(x, z) > -minDepth) return false;
    if (heightAt(x + nx * lateral, z + nz * lateral) > -minDepth * 0.7) return false;
    if (heightAt(x - nx * lateral, z - nz * lateral) > -minDepth * 0.7) return false;
  }
  return true;
}

export class BoatTraffic {
  constructor(game, count) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'boat-traffic';
    this.R = rng(99);
    this.buildGraph();
    // baked, instanced models per type
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.05 });
    this.typeMeshes = TYPES.map((t) => {
      const geo = bakeToVertexColor(game.assets.models[t.model], { filter: (o) => !/Passanger/.test(o.name + (o.material && o.material.name)) });
      const im = new THREE.InstancedMesh(geo, mat, count + 2);
      im.count = 0; im.castShadow = true; im.frustumCulled = false;
      this.group.add(im);
      return im;
    });
    this.boats = [];
    const totalW = TYPES.reduce((s, t) => s + t.weight, 0);
    for (let i = 0; i < count; i++) {
      let r = this.R() * totalW, ti = 0;
      while (r > TYPES[ti].weight) { r -= TYPES[ti].weight; ti++; }
      if (i === 0) ti = 4; // always one TowBoatUS on patrol
      this.boats.push(this.spawn(ti));
    }
    game.scene.add(this.group);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1);
    this.towRequest = null;
  }

  buildGraph() {
    const R = this.R, nodes = [];
    const ok = (x, z) => heightAt(x, z) < -2.2 && Math.abs(x) < PLAY_LIMIT - 200 && Math.abs(z) < PLAY_LIMIT - 200;
    // destination & marina approach nodes first
    for (const m of MARINAS) {
      const x = m.x + m.out[0] * (m.depth + 70), z = m.z + m.out[1] * (m.depth + 70);
      if (heightAt(x, z) < -1.5) nodes.push({ x, z, slow: true, kind: 'marina' });
    }
    for (const d of DESTINATIONS) {
      for (let a = 0; a < 6; a++) {
        const x = d.x + Math.cos(a) * (d.r * 0.9), z = d.z + Math.sin(a) * (d.r * 0.9);
        if (ok(x, z)) { nodes.push({ x, z, slow: d.kind !== 'bridge', kind: d.kind }); break; }
      }
    }
    for (let tries = 0; tries < 5000 && nodes.length < 140; tries++) {
      const x = (R() - 0.5) * 2 * (PLAY_LIMIT - 300), z = (R() - 0.5) * 2 * (PLAY_LIMIT - 300);
      if (!ok(x, z)) continue;
      if (nodes.some((n) => (n.x - x) ** 2 + (n.z - z) ** 2 < 280 * 280)) continue;
      nodes.push({ x, z, slow: false, kind: 'open' });
    }
    for (const n of nodes) n.nb = [];
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d > 760) continue;
      if (!waterLineClear(a.x, a.z, b.x, b.z)) continue;
      a.nb.push(j); b.nb.push(i);
    }
    this.nodes = nodes.filter((n) => n.nb.length > 0);
    // re-index after filtering
    const map = new Map(); nodes.forEach((n, i) => { if (n.nb.length) map.set(i, this.nodes.indexOf(n)); });
    for (const n of this.nodes) n.nb = n.nb.map((k) => map.get(k)).filter((k) => k !== undefined);
  }

  spawn(ti, nearFar = null, reuse = null) {
    const t = TYPES[ti], R = this.R;
    let ni = (R() * this.nodes.length) | 0;
    if (nearFar) {
      // respawn far from the camera
      for (let k = 0; k < 20; k++) { const c = (R() * this.nodes.length) | 0; if (Math.hypot(this.nodes[c].x - nearFar.x, this.nodes[c].z - nearFar.z) > 1500) { ni = c; break; } }
    }
    const n = this.nodes[ni];
    const next = n.nb[(R() * n.nb.length) | 0];
    const nn = this.nodes[next];
    const b = {
      ti, t, x: n.x, z: n.z, y: 0, heading: Math.atan2(nn.x - n.x, -(nn.z - n.z)), speed: 0,
      cruise: (t.cruise[0] + R() * (t.cruise[1] - t.cruise[0])) * KNOT, prev: ni, target: next,
      avoid: 0, avoidT: 0, signalT: 0, integrity: 1, sinking: 0, roll: 0, pitch: 0, vx: 0, vz: 0, hitVx: 0, hitVz: 0,
      wake: { distAccum: 0 }, idx: 0, collider: null, horn: 0, rule: '',
    };
    if (reuse) { b.collider = reuse; return b; }
    b.collider = { type: 'obb', x: b.x, z: b.z, hx: t.beam / 2, hz: t.len / 2, angle: b.heading, cos: 1, sin: 0, reach: t.len, vx: 0, vz: 0, yMin: -50, yMax: 50, damage: 1.2, bouncy: 0.15, kind: 'aiboat', ai: b,
      onHit: (speed, n) => this.onHit(b, speed, n) };
    this.game.collisions.dynamic.push(b.collider);
    return b;
  }

  onHit(b, speed, n) {
    // the player hit us: share momentum by mass ratio, take damage
    const pm = this.game.boat ? this.game.boat.phys.body.mass : 1400;
    const k = clamp(pm / (pm + b.t.mass), 0.05, 0.95);
    b.hitVx -= n.x * speed * k * 1.6;
    b.hitVz -= n.z * speed * k * 1.6;
    const dmg = clamp(0.5 * pm * speed * speed / (b.t.mass * 140), 0, 0.8);
    b.integrity -= dmg;
    b.horn = 5; // danger signal
    if (b.integrity <= 0 && !b.sinking) { b.sinking = 0.001; bus.emit('aiSinking', b); }
    bus.emit('aiHorn', { b, blasts: 5 });
  }

  // relative geometry helpers (headings: compass radians, 0 = north)
  static bearingTo(ax, az, bx, bz) { return Math.atan2(bx - ax, -(bz - az)); }

  update(dt, time, waves, player) {
    const boats = this.boats;
    const camPos = this.game.camera.position;
    // build a list of vessels for collision regs: AI + player
    const P = player ? { x: player.pos.x, z: player.pos.z, heading: player.phys.heading, speed: player.phys.t.speed, len: player.def.length, isPlayer: true } : null;
    const counts = this.typeMeshes.map(() => 0);
    for (const b of boats) {
      // ---------------------------------------------- navigation
      const n = this.nodes[b.target];
      const prevN = this.nodes[b.prev];
      // keep to starboard: aim at a point offset 22 m to the right of the leg
      const lx = n.x - prevN.x, lz = n.z - prevN.z, ll = Math.hypot(lx, lz) || 1;
      const rx = -lz / ll, rz = lx / ll;
      const tx = n.x + rx * 22, tz = n.z + rz * 22;
      const dist = Math.hypot(tx - b.x, tz - b.z);
      if (dist < 45) {
        b.prev = b.target;
        const choices = n.nb.length > 1 ? n.nb.filter((k) => k !== b.prevPrev) : n.nb;
        b.prevPrev = b.prev;
        b.target = (choices.length ? choices : n.nb)[(this.R() * (choices.length || n.nb.length)) | 0];
      }
      let desired = Math.atan2(tx - b.x, -(tz - b.z));
      let speedCap = b.cruise;
      // no-wake zones
      for (const m of MARINAS) if (Math.hypot(b.x - m.x, b.z - m.z) < 330) speedCap = Math.min(speedCap, 2.6);
      for (const d of DESTINATIONS) if (d.kind !== 'bridge' && Math.hypot(b.x - d.x, b.z - d.z) < d.r + 60) speedCap = Math.min(speedCap, 3.2);
      for (const s of SANDBARS) if (Math.hypot(b.x - s.x, b.z - s.z) < s.a + 80) speedCap = Math.min(speedCap, 3.0);

      // ---------------------------------------------- collision regulations
      b.rule = '';
      const others = P ? [...boats, P] : boats;
      for (const o of others) {
        if (o === b) continue;
        const dx = o.x - b.x, dz = o.z - b.z;
        const d = Math.hypot(dx, dz);
        if (d > 320) continue;
        const ovx = Math.sin(o.heading) * o.speed, ovz = -Math.cos(o.heading) * o.speed;
        const bvx = Math.sin(b.heading) * b.speed, bvz = -Math.cos(b.heading) * b.speed;
        const rvx = ovx - bvx, rvz = ovz - bvz;
        const rv2 = rvx * rvx + rvz * rvz;
        const tcpa = rv2 > 1e-4 ? -(dx * rvx + dz * rvz) / rv2 : 0;
        const cx = dx + rvx * tcpa, cz = dz + rvz * tcpa;
        const cpa = Math.hypot(cx, cz);
        const safe = 22 + (b.t.len + (o.len || o.t?.len || 6)) * 1.2;
        const relBearing = wrapAngle(BoatTraffic.bearingTo(b.x, b.z, o.x, o.z) - b.heading);
        const relHeading = wrapAngle(o.heading - b.heading);
        if (d < safe * 0.9 && o.isPlayer) { speedCap = Math.min(speedCap, 2.0); if (b.signalT <= 0) { b.horn = 5; b.signalT = 8; bus.emit('aiHorn', { b, blasts: 5 }); } }
        if (tcpa > 0 && tcpa < 45 && cpa < safe) {
          if (Math.abs(relBearing) < 0.26 && Math.abs(Math.abs(relHeading) - Math.PI) < 0.35) {
            b.avoid = 0.55; b.avoidT = 6; b.rule = 'head-on'; // Rule 14: both to starboard
          } else if (relBearing > 0.09 && relBearing < 1.96) {
            b.avoid = 0.75; b.avoidT = 6; speedCap = Math.min(speedCap, b.speed * 0.6 + 1); b.rule = 'give-way'; // Rule 15
          } else if (Math.abs(relBearing) > 1.96) {
            b.rule = 'stand-on (overtaken)'; // Rule 13: overtaking vessel keeps clear
          } else {
            b.rule = 'stand-on'; // Rule 17
            if (cpa < safe * 0.4 && tcpa < 8) { b.avoid = 0.9; b.avoidT = 4; speedCap = Math.min(speedCap, 1.5); b.rule = 'stand-on: last-moment action'; }
          }
          if (o.speed < b.speed * 0.7 && Math.abs(relBearing) < 0.4 && Math.abs(relHeading) < 0.5) { b.avoid = -0.45; b.avoidT = 5; b.rule = 'overtaking'; } // pass on its port
          if (b.avoidT > 5.5 && b.signalT <= 0 && b.rule !== 'stand-on' && d < 250) { b.horn = 1; b.signalT = 10; bus.emit('aiHorn', { b, blasts: 1 }); }
        }
      }
      if (b.avoidT > 0) { b.avoidT -= dt; desired += b.avoid; }
      b.signalT -= dt;
      // look-ahead for shallow water: veer away
      const ahx = b.x + Math.sin(b.heading) * 60, ahz = b.z - Math.cos(b.heading) * 60;
      if (heightAt(ahx, ahz) > -1.4) { desired += 0.8; speedCap = Math.min(speedCap, 3); }

      // ---------------------------------------------- dynamics (kinematic with inertia)
      if (b.sinking) {
        speedCap = 0;
        b.sinking += dt;
      }
      const turnRate = (0.2 + 0.5 / (1 + b.speed * 0.15)) * (b.t.mass > 5000 ? 0.6 : 1);
      const dh = wrapAngle(desired - b.heading);
      b.heading = wrapAngle(b.heading + clamp(dh, -turnRate * dt, turnRate * dt));
      const acc = b.speed < speedCap ? 1.2 * (b.t.mass > 5000 ? 0.4 : 1) : -1.6;
      b.speed = clamp(b.speed + acc * dt, 0, Math.max(speedCap, 0));
      b.hitVx *= Math.exp(-dt * 0.8); b.hitVz *= Math.exp(-dt * 0.8);
      b.vx = Math.sin(b.heading) * b.speed + b.hitVx;
      b.vz = -Math.cos(b.heading) * b.speed + b.hitVz;
      b.x += b.vx * dt; b.z += b.vz * dt;
      // respawn sunk / stuck boats away from the camera
      if (b.sinking > 25 || heightAt(b.x, b.z) > 0) {
        const fresh = this.spawn(b.ti, camPos, b.collider);
        Object.assign(b, fresh);
        b.collider.ai = b;
      }

      // ---------------------------------------------- ride the waves (+ wakes)
      const near = Math.hypot(b.x - camPos.x, b.z - camPos.z) < 900;
      const fx = Math.sin(b.heading), fz = -Math.cos(b.heading);
      const L2 = b.t.len * 0.4, B2 = b.t.beam * 0.45;
      const wh = (x, z) => waves.heightFast(x, z, time) + (near ? this.game.wake.heightAt(x, z) : 0);
      const hb = wh(b.x + fx * L2, b.z + fz * L2), hs = wh(b.x - fx * L2, b.z - fz * L2);
      const hp = wh(b.x - fz * B2, b.z + fx * B2), hst = wh(b.x + fz * B2, b.z - fx * B2);
      const planeLift = smoothstep(4, 12, b.speed) * 0.25;
      const ty = (hb + hs + hp + hst) / 4 + planeLift - (b.sinking ? b.sinking * 0.12 : 0);
      b.y += (ty - b.y) * Math.min(1, dt * 6);
      b.pitch += ((Math.atan2(hb - hs, b.t.len * 0.8) + smoothstep(3, 9, b.speed) * 0.05 * (1 - smoothstep(10, 18, b.speed)) + 0.03 * smoothstep(8, 14, b.speed)) - b.pitch) * Math.min(1, dt * 4);
      b.roll += ((Math.atan2(hp - hst, b.t.beam * 0.9) - wrapAngle(desired - b.heading) * 0.1 * Math.min(1, b.speed / 8) + (b.sinking ? Math.min(0.5, b.sinking * 0.03) : 0)) - b.roll) * Math.min(1, dt * 4);

      // collider
      const c = b.collider;
      c.x = b.x; c.z = b.z; c.angle = b.heading; c.cos = Math.cos(b.heading); c.sin = Math.sin(b.heading); c.vx = b.vx; c.vz = b.vz;

      // render
      this._e.set(b.pitch, -b.heading, b.roll, 'YXZ');
      this._q.setFromEuler(this._e);
      this._p.set(b.x, b.y - 0.35, b.z);
      const im = this.typeMeshes[b.ti];
      b.idx = counts[b.ti]++;
      im.setMatrixAt(b.idx, this._m.compose(this._p, this._q, this._s));

      // wakes near the camera
      if (near && !b.sinking) {
        const w = b.wake;
        w.x = b.x; w.z = b.z; w.y = b.y; w.fx = fx; w.fz = fz; w.vx = b.vx; w.vz = b.vz;
        w.speed = b.speed; w.beam = b.t.beam; w.length = b.t.len; w.throttle = b.speed / Math.max(1, b.cruise); w.mass = b.t.mass;
        w.bowX = b.x + fx * L2; w.bowZ = b.z + fz * L2; w.sternX = b.x - fx * L2; w.sternZ = b.z - fz * L2;
        w.yawRate = clamp(wrapAngle(desired - b.heading), -0.5, 0.5) * turnRate; w.wet = 1; w.sprayK = 0.5;
        this.game.wake.emitBoat(w, dt);
      }
    }
    this.typeMeshes.forEach((im, i) => { im.count = counts[i]; im.instanceMatrix.needsUpdate = true; });
  }

  // nearest AI boats (for positional engine audio)
  nearest(pos, n = 2) {
    return [...this.boats].sort((a, b) => ((a.x - pos.x) ** 2 + (a.z - pos.z) ** 2) - ((b.x - pos.x) ** 2 + (b.z - pos.z) ** 2)).slice(0, n);
  }
}
