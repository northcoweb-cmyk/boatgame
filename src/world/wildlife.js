// Life on and above the bay: a dolphin pod that arcs alongside your bow wake,
// rays gliding under the sandbar shallows, seagulls circling and crying, pelicans
// skimming, and the occasional business jet on approach (attached Plane model).
import * as THREE from 'three';
import { SANDBARS, heightAt } from './geography.js';
import { makeMatrix } from '../assets/assets.js';
import { bus } from '../core/events.js';
import { clamp, smoothstep } from '../core/math.js';

function dolphinGeometry() {
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const r = Math.sin(Math.PI * Math.pow(t, 0.8)) * 0.32 * (t < 0.15 ? 0.6 + t * 2.6 : 1);
    pts.push(new THREE.Vector2(Math.max(r, 0.01), t * 2.4 - 1.2));
  }
  const body = new THREE.LatheGeometry(pts, 12);
  body.rotateX(-Math.PI / 2);
  const fin = new THREE.ConeGeometry(0.16, 0.42, 4); fin.translate(0, 0.42, 0.1);
  const fluke = new THREE.BoxGeometry(0.75, 0.04, 0.22); fluke.translate(0, 0, 1.25);
  const merge = [body, fin, fluke].map((g) => g.toNonIndexed());
  let n = 0; for (const g of merge) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3); let o = 0;
  for (const g of merge) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.computeVertexNormals();
  // countershading: darker on top
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const y = pos[i * 3 + 1]; const k = y > 0.05 ? 0.42 : 0.72; col.set([k * 0.82, k * 0.88, k * 0.95], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export class Wildlife {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'wildlife';
    // dolphins
    this.dolphinMesh = new THREE.InstancedMesh(dolphinGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3 }), 4);
    this.dolphinMesh.count = 0;
    this.dolphinMesh.frustumCulled = false;
    this.group.add(this.dolphinMesh);
    this.pod = null;
    this.podCooldown = 40;
    // rays (dark silhouettes drawn just under the surface on sandbars)
    const ray = new THREE.BufferGeometry();
    ray.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.9, 1.0, 0, 0.1, 0, 0, 0.5, 0, 0, -0.9, 0, 0, 0.5, -1.0, 0, 0.1, 0, 0, 0.5, 0.05, 0, 2.0, -0.05, 0, 2.0], 3));
    ray.computeVertexNormals();
    this.rayMat = new THREE.MeshBasicMaterial({ color: 0x0b2a32, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6 });
    this.rays = [];
    for (let i = 0; i < 9; i++) {
      const sb = SANDBARS[i % SANDBARS.length];
      this.rays.push({ sb, a: Math.random() * Math.PI * 2, r: 60 + Math.random() * sb.a * 0.6, s: 0.9 + Math.random() * 0.8, w: (Math.random() < 0.5 ? -1 : 1) * (0.015 + Math.random() * 0.02) });
    }
    this.rayMesh = new THREE.InstancedMesh(ray, this.rayMat, this.rays.length);
    this.rayMesh.renderOrder = 4;
    this.rayMesh.frustumCulled = false;
    this.group.add(this.rayMesh);
    // seagulls: flapping via vertex shader
    const gull = new THREE.BufferGeometry();
    gull.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.25, 0.75, 0.05, 0, 0, 0, 0.18, 0, 0, -0.25, 0, 0, 0.18, -0.75, 0.05, 0], 3));
    gull.computeVertexNormals();
    this.gullMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.8, side: THREE.DoubleSide });
    this.gullTime = { value: 0 };
    this.gullMat.onBeforeCompile = (sh) => {
      sh.uniforms.uT = this.gullTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uT;').replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 ip = instanceMatrix * vec4(0.0,0.0,0.0,1.0);
        transformed.y += abs(position.x) * sin(uT * 7.0 + ip.x * 0.3 + ip.z * 0.2) * 0.6;`);
    };
    this.gulls = [];
    for (let i = 0; i < 26; i++) this.gulls.push({ cx: 0, cz: 0, r: 20 + Math.random() * 40, a: Math.random() * 6.28, w: 0.25 + Math.random() * 0.3, h: 9 + Math.random() * 14, home: null });
    this.gullMesh = new THREE.InstancedMesh(gull, this.gullMat, this.gulls.length);
    this.gullMesh.frustumCulled = false;
    this.group.add(this.gullMesh);
    this.gullCryT = 3;
    // plane flyover
    this.plane = game.assets.cloneModel('plane', { cloneMaterials: false });
    this.plane.scale.setScalar(1);
    this.plane.visible = false;
    this.planeT = 30;
    this.group.add(this.plane);
    game.scene.add(this.group);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1);
  }

  update(dt, time, waves, boat, camPos) {
    const m = this._m, q = this._q, e = this._e, p = this._p;
    // ---------- dolphins: escort the bow at 8-25 kn in deeper water
    this.podCooldown -= dt;
    if (boat && !this.pod && this.podCooldown < 0) {
      const sp = boat.phys.t.speed;
      if (sp > 4 && sp < 13 && boat.phys.t.waterDepth > 2.5 && Math.random() < dt * 0.05) {
        this.pod = { t: 0, life: 25 + Math.random() * 10, members: [0, 1, 2].slice(0, 2 + (Math.random() < 0.5 ? 1 : 0)).map((k) => ({ side: k % 2 ? 1 : -1, off: 3 + k * 2.2, phase: k * 1.3, lag: k * 2 })) };
        bus.emit('dolphins', { start: true });
      }
    }
    if (this.pod && boat) {
      const P = this.pod;
      P.t += dt;
      const b = boat.phys.body;
      const fx = Math.sin(boat.phys.heading), fz = -Math.cos(boat.phys.heading);
      const fade = smoothstep(0, 3, P.t) * (1 - smoothstep(P.life - 4, P.life, P.t));
      P.members.forEach((mb, i) => {
        const ahead = boat.def.length * 0.4 - mb.lag + Math.sin(time * 0.6 + mb.phase) * 1.5;
        const x = b.pos.x + fx * ahead + (-fz) * mb.side * (boat.def.beam * 0.5 + mb.off);
        const z = b.pos.z + fz * ahead + fx * mb.side * (boat.def.beam * 0.5 + mb.off);
        const cyc = (time * 0.7 + mb.phase) % 1;
        const arc = Math.sin(cyc * Math.PI);
        const h = waves.heightFast(x, z, time);
        const y = h - 1.6 + (cyc < 0.45 ? arc * 2.3 : -0.4) * fade - (1 - fade) * 3;
        const pitch = Math.cos(cyc * Math.PI) * 0.7;
        e.set(-pitch, -boat.phys.heading + Math.PI, 0, 'YXZ'); q.setFromEuler(e);
        p.set(x, y, z);
        this.dolphinMesh.setMatrixAt(i, m.compose(p, q, this._s.set(1, 1, 1)));
        if (cyc < 0.05 && arc < 0.2 && fade > 0.5 && Math.random() < 0.3) this.game.wake.splash(x, h, z, 0.25);
      });
      this.dolphinMesh.count = P.members.length;
      this.dolphinMesh.instanceMatrix.needsUpdate = true;
      if (P.t > P.life || boat.phys.t.speed < 2) { this.pod = null; this.dolphinMesh.count = 0; this.podCooldown = 90 + Math.random() * 60; bus.emit('dolphins', { start: false, escorted: P.t > 10 }); }
    }
    // ---------- rays
    this.rays.forEach((r, i) => {
      r.a += r.w * dt * 4;
      const x = r.sb.x + Math.cos(r.a) * r.r, z = r.sb.z + Math.sin(r.a) * r.r * (r.sb.b / r.sb.a);
      const h = waves.heightFast(x, z, time, 0.3);
      const depth = -heightAt(x, z);
      e.set(Math.sin(time * 2 + i) * 0.05, -(r.a + (r.w > 0 ? Math.PI / 2 : -Math.PI / 2)) + Math.PI, Math.sin(time * 1.6 + i) * 0.15, 'YXZ');
      q.setFromEuler(e);
      p.set(x, h + 0.01, z);
      const vis = clamp(1.6 - depth, 0.2, 1);
      this.rayMesh.setMatrixAt(i, m.compose(p, q, this._s.set(r.s * vis, 1, r.s * vis)));
    });
    this._s.set(1, 1, 1);
    this.rayMesh.instanceMatrix.needsUpdate = true;
    // ---------- gulls circle around the camera's nearby shore points / the boat
    this.gullTime.value = time;
    const anchor = boat ? boat.phys.body.pos : camPos;
    this.gullCryT -= dt;
    this.gulls.forEach((g, i) => {
      if (!g.home || Math.hypot(g.home.x - anchor.x, g.home.z - anchor.z) > 700) g.home = { x: anchor.x + (Math.random() - 0.5) * 300, z: anchor.z + (Math.random() - 0.5) * 300 };
      g.a += g.w * dt;
      const x = g.home.x + Math.cos(g.a) * g.r, z = g.home.z + Math.sin(g.a) * g.r;
      e.set(0, -g.a - Math.PI / 2 * Math.sign(g.w), -0.3 * Math.sign(g.w), 'YXZ'); q.setFromEuler(e);
      p.set(x, g.h + Math.sin(time * 0.5 + i) * 2, z);
      this.gullMesh.setMatrixAt(i, m.compose(p, q, this._s));
    });
    this.gullMesh.instanceMatrix.needsUpdate = true;
    if (this.gullCryT < 0) { this.gullCryT = 4 + Math.random() * 9; bus.emit('gull', {}); }
    // ---------- plane on approach across the bay (west, toward MIA)
    this.planeT -= dt;
    if (this.planeT < 0 && !this.plane.visible) {
      this.plane.visible = true;
      this.planeFlight = { t: 0, z: camPos.z + (Math.random() - 0.5) * 2000, y: 260 + Math.random() * 120, dur: 70 };
    }
    if (this.plane.visible) {
      const f = this.planeFlight;
      f.t += dt;
      const x = 6000 - (f.t / f.dur) * 12000;
      this.plane.position.set(x, f.y - (f.t / f.dur) * 100, f.z);
      this.plane.rotation.set(0, Math.PI / 2, 0);
      if (f.t > f.dur) { this.plane.visible = false; this.planeT = 120 + Math.random() * 120; }
    }
  }
}

export { makeMatrix };
