// NPC people from the attached human models:
//  * women (standing "WOMEN" model and the two seated scans) — posed figures,
//    instanced, with subtle breathing/bob so nobody stands frozen
//  * men — the rigged base mesh, CPU-skinned once into standing/sitting poses
//    for instanced crowds, plus a handful of fully animated walkers on the
//    promenades, piers and beach that follow paths near the camera.
import * as THREE from 'three';
import { bakeModel } from '../assets/assets.js';
import { Character, prepareRig } from './rig.js';
import { heightAt } from '../world/geography.js';

function bakePosedCharacter(ch) {
  ch.object.updateMatrixWorld(true);
  const mesh = ch.mesh;
  mesh.skeleton.update();
  const src = mesh.geometry;
  const pos = src.attributes.position;
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    mesh.applyBoneTransform(i, v);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.setAttribute('uv', src.attributes.uv);
  g.setIndex(src.index);
  for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export class People {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'people';
    prepareRig(game.assets.models.man);
    // posed men geometries (CPU skinned once)
    const poser = new Character(1, { tint: false });
    poser.pose = 'stand'; poser.speed = 0; poser.update(0.016);
    this.manStand = bakePosedCharacter(poser);
    poser.pose = 'sitFloor'; poser.update(0.016);
    this.manSit = bakePosedCharacter(poser);
    this.manMats = poser.mesh.material;
    this.statics = [];
    this.walkers = [];
    this.time = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
  }

  // spots: { stand: [{x,y,z,face}], seated: [...], wade: [{x,z,face}], walkers: [{path, phase}] }
  populate(spots) {
    const A = this.game.assets;
    const womanParts = bakeModel(A.models.woman);
    const seatA = bakeModel(A.models.womanSeatedA), seatB = bakeModel(A.models.womanSeatedB);
    const tints = [0xffffff, 0xf2e6dc, 0xe8d4c4, 0xd9e8ff, 0xffe0e6];
    const lists = { woman: [], seatA: [], seatB: [], manStand: [], manSit: [] };
    spots.stand.forEach((s, i) => (i % 2 ? lists.woman : lists.manStand).push({ ...s, k: i }));
    spots.seated.forEach((s, i) => (i % 3 === 0 ? lists.manSit : i % 3 === 1 ? lists.seatA : lists.seatB).push({ ...s, k: i }));
    spots.wade.forEach((s, i) => {
      const y = Math.min(0, heightAt(s.x, s.z)) - 0.05;
      (i % 2 ? lists.woman : lists.manStand).push({ x: s.x, y, z: s.z, face: s.face, k: i + 100, wade: true });
    });
    const make = (parts, list, name, multi = true) => {
      if (!list.length) return;
      const meshes = parts.map((p) => {
        const im = new THREE.InstancedMesh(p.geometry, p.material, list.length);
        im.castShadow = true; im.frustumCulled = false;
        if (multi) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3).fill(1), 3);
        this.group.add(im);
        return im;
      });
      list.forEach((s, i) => {
        const c = new THREE.Color(tints[s.k % tints.length]);
        for (const im of meshes) if (im.instanceColor) im.setColorAt(i, c);
      });
      this.statics.push({ name, meshes, list });
    };
    make(womanParts, lists.woman, 'woman');
    make(seatA, lists.seatA, 'seatA');
    make(seatB, lists.seatB, 'seatB');
    const manPartsStand = [{ geometry: this.manStand, material: this.manMats }];
    const manPartsSit = [{ geometry: this.manSit, material: this.manMats }];
    make(manPartsStand, lists.manStand, 'manStand', false);
    make(manPartsSit, lists.manSit, 'manSit', false);
    // animated walkers
    spots.walkers.forEach((w, i) => {
      const ch = new Character(i * 7 + 3);
      ch.pose = 'walk';
      this.group.add(ch.object);
      this.walkers.push({ ch, path: w.path, t: w.phase, dir: 1, speed: 1.15 + (i % 3) * 0.15 });
    });
    this.game.scene.add(this.group);
    this.updateStatics(0, true);
  }

  updateStatics(time, force = false) {
    const cam = this.game.camera.position;
    for (const st of this.statics) {
      st.list.forEach((s, i) => {
        const d2 = (s.x - cam.x) ** 2 + (s.z - cam.z) ** 2;
        if (!force && d2 > 220 * 220) return;
        const breathe = 1 + Math.sin(time * 1.6 + s.k) * 0.008;
        const sway = Math.sin(time * 0.4 + s.k * 1.7) * 0.05;
        const bob = s.wade ? this.game.waves.heightFast(s.x, s.z, time, 0.3) * 0.3 : 0;
        this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (s.face || 0) + sway);
        this._p.set(s.x, (s.y ?? 0) + bob, s.z);
        this._s.set(1, breathe, 1);
        this._m.compose(this._p, this._q, this._s);
        for (const im of st.meshes) im.setMatrixAt(i, this._m);
      });
      for (const im of st.meshes) im.instanceMatrix.needsUpdate = true;
    }
  }

  update(dt, time) {
    this.time = time;
    this.updateStatics(time);
    const cam = this.game.camera.position;
    for (const w of this.walkers) {
      const [a, b] = w.path;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      w.t += (w.dir * w.speed * dt) / len;
      if (w.t > 1) { w.t = 1; w.dir = -1; }
      if (w.t < 0) { w.t = 0; w.dir = 1; }
      const x = a[0] + (b[0] - a[0]) * w.t, z = a[1] + (b[1] - a[1]) * w.t;
      const near = (x - cam.x) ** 2 + (z - cam.z) ** 2 < 260 * 260;
      w.ch.object.visible = near;
      if (!near) continue;
      w.ch.speed = w.speed;
      w.ch.object.position.set(x, Math.max(heightAt(x, z), 0) , z);
      w.ch.object.rotation.y = Math.atan2(b[0] - a[0], b[1] - a[1]) + (w.dir < 0 ? Math.PI : 0);
      w.ch.update(dt);
    }
  }
}
