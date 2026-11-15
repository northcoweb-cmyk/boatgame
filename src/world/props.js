// Aids to navigation and floating stuff: channel markers (red triangle daymarks
// on the right returning from sea, green squares on the left) with flashing
// lights, no-wake buoys at the marinas, mooring balls, and drifting debris —
// everything floating bobs on the REAL wave function.
import * as THREE from 'three';
import { CHANNELS, MARINAS, heightAt } from './geography.js';
import { makeMatrix } from '../assets/assets.js';
import { LAYER_NO_REFLECT } from '../render/reflection.js';

export class Props {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'props';
    const markers = [];
    for (const ch of CHANNELS) {
      for (let i = 0; i < ch.pts.length - 1; i++) {
        const [ax, az] = ch.pts[i], [bx, bz] = ch.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const fx = (bx - ax) / len, fz = (bz - az) / len;
        const rx = -fz, rz = fx; // starboard when heading inbound
        for (let d = 120; d < len; d += 260) {
          const cx = ax + fx * d, cz = az + fz * d;
          for (const side of [1, -1]) {
            const x = cx + rx * side * ch.width * 0.62, z = cz + rz * side * ch.width * 0.62;
            if (heightAt(x, z) > -0.8) continue;
            markers.push({ x, z, red: side > 0, n: markers.length, face: Math.atan2(-fx, -fz) });
          }
        }
      }
    }
    this.markers = markers;
    const pile = new THREE.CylinderGeometry(0.2, 0.22, 9, 8); pile.translate(0, 1.5, 0);
    const piles = new THREE.InstancedMesh(pile, new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.9 }), markers.length);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-0.8, 0, 0.25, 0.8, 0, 0.25, 0, 1.4, 0.25, 0.8, 0, 0.25, -0.8, 0, 0.25, 0, 1.4, 0.25], 3));
    tri.computeVertexNormals(); tri.translate(0, 4.8, 0);
    const sq = new THREE.BoxGeometry(1.4, 1.4, 0.08); sq.translate(0, 5.5, 0.25);
    const reds = markers.filter((m) => m.red), greens = markers.filter((m) => !m.red);
    const redMesh = new THREE.InstancedMesh(tri, new THREE.MeshStandardMaterial({ color: 0xd8261c, roughness: 0.6, side: THREE.DoubleSide }), Math.max(1, reds.length));
    const greenMesh = new THREE.InstancedMesh(sq, new THREE.MeshStandardMaterial({ color: 0x1f8a3c, roughness: 0.6 }), Math.max(1, greens.length));
    markers.forEach((m, i) => piles.setMatrixAt(i, makeMatrix(m.x, -2, m.z)));
    reds.forEach((m, i) => redMesh.setMatrixAt(i, makeMatrix(m.x, -2, m.z, m.face)));
    greens.forEach((m, i) => greenMesh.setMatrixAt(i, makeMatrix(m.x, -2, m.z, m.face)));
    this.group.add(piles, redMesh, greenMesh);
    for (const m of markers) game.collisions.addCircle(m.x, m.z, 0.5, { kind: 'piling', damage: 0.6 });
    // marker lights
    this.lightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 6, 4), this.lightMat, markers.length);
    this.lights.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(markers.length * 3), 3);
    markers.forEach((m, i) => this.lights.setMatrixAt(i, makeMatrix(m.x, 7.7, m.z)));
    this.lights.layers.enable(LAYER_NO_REFLECT);
    this.group.add(this.lights);

    // floating buoys: no-wake at marina entrances + mooring balls
    const buoys = [];
    for (const m of MARINAS) {
      for (const s of [-1, 1]) buoys.push({ x: m.x + m.out[0] * (m.depth + 40) + m.along[0] * s * 70, z: m.z + m.out[1] * (m.depth + 40) + m.along[1] * s * 70, kind: 'nowake' });
    }
    for (let i = 0; i < 14; i++) buoys.push({ x: 120 + (i % 7) * 45, z: 1080 + Math.floor(i / 7) * 50, kind: 'mooring' });
    for (let i = 0; i < 10; i++) buoys.push({ x: -250 + (i % 5) * 50, z: 3000 + Math.floor(i / 5) * 60, kind: 'mooring' });
    this.buoys = buoys.filter((b) => heightAt(b.x, b.z) < -1);
    const nw = this.buoys.filter((b) => b.kind === 'nowake'), mo = this.buoys.filter((b) => b.kind === 'mooring');
    const nwGeo = new THREE.CylinderGeometry(0.35, 0.4, 1.8, 12); nwGeo.translate(0, 0.6, 0);
    const cols = new Float32Array(nwGeo.attributes.position.count * 3);
    for (let i = 0; i < nwGeo.attributes.position.count; i++) { const y = nwGeo.attributes.position.getY(i); const orange = y > 0.9 && y < 1.3; cols.set(orange ? [1, 0.35, 0.05] : [0.97, 0.97, 0.95], i * 3); }
    nwGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.nwMesh = new THREE.InstancedMesh(nwGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), Math.max(1, nw.length));
    this.moMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }), Math.max(1, mo.length));
    nw.forEach((b, i) => { b.mesh = this.nwMesh; b.idx = i; });
    mo.forEach((b, i) => { b.mesh = this.moMesh; b.idx = i; });
    this.group.add(this.nwMesh, this.moMesh);
    for (const b of this.buoys) game.collisions.addCircle(b.x, b.z, 0.5, { kind: 'buoy', damage: 0.08, bouncy: 0.3 });

    // drifting debris (coconuts, a lost cooler, seaweed mats) — current-carried
    this.debris = [];
    for (let i = 0; i < 40; i++) {
      const x = (Math.random() - 0.5) * 6000, z = (Math.random() - 0.5) * 6000;
      if (heightAt(x, z) < -1.5) this.debris.push({ x, z, s: 0.3 + Math.random() * 0.5, r: Math.random() * 6 });
    }
    this.debrisMesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x6a5232, roughness: 1 }), this.debris.length);
    this.group.add(this.debrisMesh);
    game.scene.add(this.group);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
  }

  update(dt, time, waves, night, camPos, current) {
    const m = this._m, q = this._q, e = this._e, p = this._p;
    for (const b of this.buoys) {
      if (Math.abs(b.x - camPos.x) > 1500 || Math.abs(b.z - camPos.z) > 1500) continue;
      const h = waves.heightFast(b.x, b.z, time);
      e.set(Math.sin(time * 1.3 + b.x) * 0.12, 0, Math.cos(time * 1.1 + b.z) * 0.12);
      q.setFromEuler(e); p.set(b.x, h - 0.25, b.z);
      b.mesh.setMatrixAt(b.idx, m.compose(p, q, this._s));
    }
    this.nwMesh.instanceMatrix.needsUpdate = true;
    this.moMesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      d.x += current.x * dt * 3; d.z += current.z * dt * 3;
      if (heightAt(d.x, d.z) > -0.5) { d.x = (Math.random() - 0.5) * 6000; d.z = (Math.random() - 0.5) * 6000; }
      const h = waves.heightFast(d.x, d.z, time);
      e.set(time * 0.2 + d.r, d.r, 0); q.setFromEuler(e); p.set(d.x, h - 0.1, d.z);
      this.debrisMesh.setMatrixAt(i, m.compose(p, q, this._s.set(d.s, d.s * 0.4, d.s)));
    }
    this._s.set(1, 1, 1);
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    // flashing marker lights: red Fl 4s / green Fl 4s, offset per marker
    for (let i = 0; i < this.markers.length; i++) {
      const mk = this.markers[i];
      const on = ((time + mk.n * 0.7) % 4) < 0.5 ? 1 : 0;
      const k = on * (0.5 + night * 8);
      this._c.setRGB(mk.red ? k : 0.05 * k, mk.red ? 0.05 * k : k, 0.05 * k);
      this.lights.setColorAt(i, this._c);
    }
    this.lights.instanceColor.needsUpdate = true;
  }
}
