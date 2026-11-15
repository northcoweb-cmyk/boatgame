// Procedural rig for the attached static "man base mesh" (A-pose, no skeleton).
// Bones are placed from anatomical proportions of the measured mesh, vertices
// are skinned by region with smooth joint blending, and poses/animations are
// driven procedurally (walk, idle, sit, sit-on-floor, lean, grip, wave, fist
// pump, spray-shield arm, wade). Never stands frozen in an A-pose.
import * as THREE from 'three';
import { mergeGeometries } from '../../vendor/three/addons/utils/BufferGeometryUtils.js';
import { clamp, smoothstep, lerp } from '../core/math.js';
import { toFloatAttrs } from '../assets/assets.js';

const BONES = ['hips', 'spine', 'chest', 'neck', 'head',
  'lUpperArm', 'lForeArm', 'lHand', 'rUpperArm', 'rForeArm', 'rHand',
  'lThigh', 'lShin', 'lFoot', 'rThigh', 'rShin', 'rFoot'];
const B = Object.fromEntries(BONES.map((b, i) => [b, i]));

let SHARED = null;

// Build (once) a skinned geometry + material set + bind joints from the man model.
export function prepareRig(manModel) {
  if (SHARED) return SHARED;
  manModel.updateMatrixWorld(true);
  const byMat = new Map();
  manModel.traverse((o) => {
    if (!o.isMesh) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
    toFloatAttrs(g, ['position', 'normal', 'uv']);
    g.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    for (const k of ['position', 'normal', 'uv']) {
      const a = g.attributes[k];
      if (!a) continue;
      if (a.normalized || !(a.array instanceof Float32Array)) {
        const f = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) f[i * a.itemSize + j] = a.getComponent(i, j);
        g.setAttribute(k, new THREE.BufferAttribute(f, a.itemSize));
      }
    }
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const key = o.material.uuid;
    if (!byMat.has(key)) byMat.set(key, { mat: o.material, geos: [] });
    byMat.get(key).geos.push(g);
  });
  const geos = [], mats = [];
  for (const [, v] of byMat) { geos.push(mergeGeometries(v.geos, false)); mats.push(v.mat); }
  const geo = mergeGeometries(geos, true);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const Hh = bb.max.y - bb.min.y;
  const cx = (bb.max.x + bb.min.x) / 2;
  const W = bb.max.x - bb.min.x; // arm span in A-pose
  // landmarks (fractions of height, from standard proportions)
  const y = (f) => bb.min.y + Hh * f;
  const handX = W / 2;
  const J = {
    hips: [cx, y(0.53), 0], spine: [cx, y(0.62), 0], chest: [cx, y(0.72), 0], neck: [cx, y(0.835), 0], head: [cx, y(0.875), 0],
    lUpperArm: [cx + Hh * 0.105, y(0.815), 0], rUpperArm: [cx - Hh * 0.105, y(0.815), 0],
    lThigh: [cx + Hh * 0.055, y(0.5), 0], rThigh: [cx - Hh * 0.055, y(0.5), 0],
    lShin: [cx + Hh * 0.06, y(0.285), 0], rShin: [cx - Hh * 0.06, y(0.285), 0],
    lFoot: [cx + Hh * 0.065, y(0.045), 0], rFoot: [cx - Hh * 0.065, y(0.045), 0],
  };
  // find hand tip heights from the extreme x vertices
  const pos = geo.attributes.position;
  let lTipY = y(0.5), rTipY = y(0.5), lmx = -1e9, rmn = 1e9;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    if (vx > lmx) { lmx = vx; lTipY = pos.getY(i); }
    if (vx < rmn) { rmn = vx; rTipY = pos.getY(i); }
  }
  const armPt = (sx, tipX, tipY, t) => { const s = J[sx]; return [lerp(s[0], tipX, t), lerp(s[1], tipY, t), 0]; };
  J.lForeArm = armPt('lUpperArm', lmx, lTipY, 0.47); J.lHand = armPt('lUpperArm', lmx, lTipY, 0.86);
  J.rForeArm = armPt('rUpperArm', rmn, rTipY, 0.47); J.rHand = armPt('rUpperArm', rmn, rTipY, 0.86);
  const armDirL = new THREE.Vector3(lmx - J.lUpperArm[0], lTipY - J.lUpperArm[1], 0).normalize();
  const armDirR = new THREE.Vector3(rmn - J.rUpperArm[0], rTipY - J.rUpperArm[1], 0).normalize();

  // skin weights
  const n = pos.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const v = new THREE.Vector3(), tmp = new THREE.Vector3();
  const set = (i, list) => {
    list.sort((a, b) => b[1] - a[1]);
    let tot = 0;
    for (let k = 0; k < 4; k++) tot += list[k] ? list[k][1] : 0;
    for (let k = 0; k < 4; k++) { si[i * 4 + k] = list[k] ? list[k][0] : 0; sw[i * 4 + k] = list[k] ? list[k][1] / tot : 0; }
  };
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const dx = v.x - cx;
    const side = dx >= 0 ? 'l' : 'r';
    const sh = J[side + 'UpperArm'];
    const dir = side === 'l' ? armDirL : armDirR;
    // projection along the arm line
    tmp.set(v.x - sh[0], v.y - sh[1], 0);
    const along = tmp.dot(dir);
    const perp = tmp.clone().addScaledVector(dir, -along).length();
    const armLen = Math.hypot((side === 'l' ? lmx : rmn) - sh[0], (side === 'l' ? lTipY : rTipY) - sh[1]);
    const isArm = Math.abs(dx) > Hh * 0.075 && along > -Hh * 0.02 && perp < Hh * 0.075 && v.y > y(0.45);
    if (isArm) {
      const t = along / armLen;
      const w = [];
      const ua = B[side + 'UpperArm'], fa = B[side + 'ForeArm'], ha = B[side + 'Hand'];
      const shoulderBlend = smoothstep(-0.02, 0.1, t);
      const elbow = smoothstep(0.4, 0.54, t), wrist = smoothstep(0.8, 0.9, t);
      w.push([B.chest, 1 - shoulderBlend]);
      w.push([ua, shoulderBlend * (1 - elbow)]);
      w.push([fa, shoulderBlend * elbow * (1 - wrist)]);
      w.push([ha, shoulderBlend * wrist]);
      set(i, w.filter((x) => x[1] > 1e-4));
      continue;
    }
    if (v.y < y(0.52) && Math.abs(dx) > Hh * 0.002) {
      const leg = side;
      const t = (y(0.5) - v.y) / (y(0.5) - y(0.04));
      const hipBlend = smoothstep(-0.12, 0.08, t);
      const knee = smoothstep(0.43, 0.56, t), ankle = smoothstep(0.88, 0.95, t);
      set(i, [[B.hips, 1 - hipBlend + 1e-5], [B[leg + 'Thigh'], hipBlend * (1 - knee)], [B[leg + 'Shin'], hipBlend * knee * (1 - ankle)], [B[leg + 'Foot'], hipBlend * ankle]].filter((x) => x[1] > 1e-4));
      continue;
    }
    // torso + head
    const t = v.y;
    const wHips = 1 - smoothstep(y(0.55), y(0.63), t);
    const wSpine = smoothstep(y(0.55), y(0.63), t) * (1 - smoothstep(y(0.66), y(0.74), t));
    const wChest = smoothstep(y(0.66), y(0.74), t) * (1 - smoothstep(y(0.82), y(0.85), t));
    const wNeck = smoothstep(y(0.82), y(0.85), t) * (1 - smoothstep(y(0.86), y(0.89), t));
    const wHead = smoothstep(y(0.86), y(0.89), t);
    set(i, [[B.hips, wHips], [B.spine, wSpine], [B.chest, wChest], [B.neck, wNeck], [B.head, wHead]].filter((x) => x[1] > 1e-4));
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.translate(-cx, -bb.min.y, 0);
  for (const k of Object.keys(J)) { J[k][0] -= cx; J[k][1] -= bb.min.y; }
  geo.computeBoundingSphere();
  SHARED = { geo, mats, J, height: Hh };
  return SHARED;
}

const SHIRTS = [0xf4f1ea, 0x2f6fa6, 0xe86a5a, 0x3fb8a8, 0xf2b84b, 0x1d2b3a, 0xc8d8e8, 0xff8fa3];
const SKIN = [[1, 1, 1], [0.92, 0.84, 0.78], [0.78, 0.64, 0.52], [0.6, 0.46, 0.36], [1.04, 0.96, 0.9]];

export class Character {
  constructor(seed = 0, { tint = true } = {}) {
    const S = SHARED;
    this.seed = seed;
    const bones = [];
    const parent = { spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', lUpperArm: 'chest', lForeArm: 'lUpperArm', lHand: 'lForeArm', rUpperArm: 'chest', rForeArm: 'rUpperArm', rHand: 'rForeArm', lThigh: 'hips', lShin: 'lThigh', lFoot: 'lShin', rThigh: 'hips', rShin: 'rThigh', rFoot: 'rShin' };
    for (const name of BONES) {
      const b = new THREE.Bone();
      b.name = name;
      bones.push(b);
    }
    for (const name of BONES) {
      const b = bones[B[name]];
      const j = S.J[name];
      if (parent[name]) {
        const pj = S.J[parent[name]];
        b.position.set(j[0] - pj[0], j[1] - pj[1], j[2] - pj[2]);
        bones[B[parent[name]]].add(b);
      } else b.position.set(j[0], j[1], j[2]);
    }
    this.bones = Object.fromEntries(BONES.map((n) => [n, bones[B[n]]]));
    const skeleton = new THREE.Skeleton(bones);
    // tint: per-character material clones (textures shared)
    const rnd = (k) => { const x = Math.sin(seed * 91.7 + k * 12.3) * 43758.5; return x - Math.floor(x); };
    const mats = S.mats.map((m) => {
      if (!tint) return m;
      const c = m.clone();
      if (c.name === 'pant') c.color.set(SHIRTS[(rnd(1) * SHIRTS.length) | 0]).multiplyScalar(0.85); // swim shorts
      else if (/172/.test(c.name)) { const s = SKIN[(rnd(2) * SKIN.length) | 0]; c.color.setRGB(s[0], s[1], s[2]); }
      else if (/40/.test(c.name)) c.color.setHSL(0.07, 0.3, 0.12 + rnd(3) * 0.35); // hair
      return c;
    });
    this.mesh = new THREE.SkinnedMesh(S.geo, mats);
    this.mesh.add(bones[0]);
    this.mesh.bind(skeleton);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.object = new THREE.Group();
    this.object.add(this.mesh);
    this.scale = 0.94 + rnd(6) * 0.12;
    this.object.scale.setScalar(this.scale);
    this.t = rnd(7) * 10;
    this.pose = 'stand';
    this.action = null; this.actionT = 0;
    this.lean = 0;
    this.lookYaw = 0;
    this.walkPhase = 0;
    this.speed = 0;
  }

  setAction(name, dur = 1.2) { this.action = name; this.actionT = dur; this.actionDur = dur; }

  // Apply a pose. dt in seconds. ctx: { lean, steer, wade }
  update(dt, ctx = {}) {
    this.t += dt;
    const b = this.bones;
    for (const k of BONES) b[k].rotation.set(0, 0, 0);
    const breathe = Math.sin(this.t * 1.6) * 0.025;
    // A-pose arms down to the sides: the bind pose has arms ~40° out
    const armDown = 0.82;
    b.lUpperArm.rotation.z = -armDown; b.rUpperArm.rotation.z = armDown;
    b.lForeArm.rotation.z = 0.06; b.rForeArm.rotation.z = -0.06;
    b.chest.rotation.x = breathe;
    b.head.rotation.y = this.lookYaw + Math.sin(this.t * 0.37 + this.seed) * 0.35;
    b.head.rotation.x = Math.sin(this.t * 0.23 + this.seed * 2) * 0.08;

    if (this.pose === 'walk' || this.pose === 'stand') {
      const sp = this.speed;
      this.walkPhase += dt * (2 + sp * 2.4);
      const amp = clamp(sp / 1.6, 0, 1.1);
      const s = Math.sin(this.walkPhase), c = Math.cos(this.walkPhase);
      b.lThigh.rotation.x = -s * 0.5 * amp; b.rThigh.rotation.x = s * 0.5 * amp;
      b.lShin.rotation.x = Math.max(0, c) * 0.8 * amp; b.rShin.rotation.x = Math.max(0, -c) * 0.8 * amp;
      b.lUpperArm.rotation.x = s * 0.45 * amp; b.rUpperArm.rotation.x = -s * 0.45 * amp;
      b.lForeArm.rotation.x = -0.25 * amp; b.rForeArm.rotation.x = -0.25 * amp;
      b.hips.position.y = SHARED.J.hips[1] + Math.abs(c) * 0.03 * amp;
      b.spine.rotation.y = s * 0.08 * amp;
      if (ctx.wade) { b.lThigh.rotation.x -= 0.1; b.rThigh.rotation.x -= 0.1; }
      if (sp < 0.05) { // idle weight shift
        b.hips.rotation.z = Math.sin(this.t * 0.5 + this.seed) * 0.03;
      }
    } else if (this.pose === 'sit' || this.pose === 'drive') {
      b.hips.position.y = SHARED.J.hips[1];
      b.lThigh.rotation.x = -1.45; b.rThigh.rotation.x = -1.45;
      b.lShin.rotation.x = 1.45; b.rShin.rotation.x = 1.45;
      b.lThigh.rotation.z = 0.08; b.rThigh.rotation.z = -0.08;
      b.spine.rotation.z = ctx.lean ? ctx.lean * 0.25 : 0;
      b.chest.rotation.z = ctx.lean ? ctx.lean * 0.2 : 0;
      if (this.pose === 'drive') {
        b.lUpperArm.rotation.set(-0.95, 0, -0.35); b.rUpperArm.rotation.set(-0.95, 0, 0.35);
        b.lForeArm.rotation.set(-0.5, 0, -0.2 + (ctx.steer || 0) * 0.3); b.rForeArm.rotation.set(-0.5, 0, 0.2 + (ctx.steer || 0) * 0.3);
      } else {
        b.lUpperArm.rotation.x = -0.25; b.rUpperArm.rotation.x = -0.25;
        b.lForeArm.rotation.x = -0.9; b.rForeArm.rotation.x = -0.9;
      }
    } else if (this.pose === 'standDrive') {
      b.lUpperArm.rotation.set(-0.85, 0, -0.42); b.rUpperArm.rotation.set(-0.85, 0, 0.42);
      b.lForeArm.rotation.set(-0.55, 0, -0.25 + (ctx.steer || 0) * 0.35); b.rForeArm.rotation.set(-0.55, 0, 0.25 + (ctx.steer || 0) * 0.35);
      b.lShin.rotation.x = 0.12; b.rShin.rotation.x = 0.12; b.lThigh.rotation.x = -0.08; b.rThigh.rotation.x = -0.08;
      b.spine.rotation.z = (ctx.lean || 0) * 0.2;
    } else if (this.pose === 'sitFloor') {
      b.hips.position.y = SHARED.J.hips[1] * 0.18;
      b.lThigh.rotation.x = -1.2; b.rThigh.rotation.x = -1.2;
      b.lShin.rotation.x = 1.9; b.rShin.rotation.x = 1.9;
      b.lThigh.rotation.z = 0.25; b.rThigh.rotation.z = -0.25;
      b.lUpperArm.rotation.set(-0.5, 0, -0.5); b.rUpperArm.rotation.set(-0.5, 0, 0.5);
      b.lForeArm.rotation.x = -0.8; b.rForeArm.rotation.x = -0.8;
      b.spine.rotation.z = (ctx.lean || 0) * 0.3;
    } else if (this.pose === 'lie') {
      b.hips.position.y = SHARED.J.hips[1];
      this.object.rotation.x = -Math.PI / 2;
    }
    if (this.pose !== 'lie') this.object.rotation.x = 0;

    // actions layered on top
    if (this.action) {
      this.actionT -= dt;
      const k = Math.sin(clamp(1 - this.actionT / this.actionDur, 0, 1) * Math.PI);
      if (this.action === 'fist') { b.rUpperArm.rotation.set(0, 0, armDown - 3.26 * k); b.rForeArm.rotation.z = -0.6 * k; }
      if (this.action === 'wave') { b.rUpperArm.rotation.set(0, 0, armDown - 2.9 * k); b.rForeArm.rotation.z = Math.sin(this.t * 12) * 0.5 * k; }
      if (this.action === 'shield') { b.lUpperArm.rotation.set(-1.3 * k, 0, -0.4); b.lForeArm.rotation.set(-1.4 * k, 0, 0); b.head.rotation.x += 0.3 * k; }
      if (this.action === 'grip') { b.lUpperArm.rotation.z = -0.2; b.rUpperArm.rotation.z = 0.2; b.lUpperArm.rotation.x = -0.6 * k; b.rUpperArm.rotation.x = -0.6 * k; b.spine.rotation.x = 0.2 * k; }
      if (this.action === 'hop') { b.hips.position.y += 0.35 * k; b.lShin.rotation.x = 0.8 * k; b.rShin.rotation.x = 0.8 * k; }
      if (this.actionT <= 0) this.action = null;
    }
  }
}
