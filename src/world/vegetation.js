// Palms: the attached Tropical Palm Tree model, instanced across islands,
// beaches, promenades and villa yards with per-instance scale/rotation/lean and
// hue jitter, a wind-sway vertex shader, and a distance LOD (model up close, a
// light procedural palm far away). Instance sets are rebuilt around the camera.
import * as THREE from 'three';
import { bakeModel } from '../assets/assets.js';
import { ISLANDS, MARINAS, heightAt, shoreDistance, isBeachShore, isResidentialIsland, WORLD_HALF } from './geography.js';
import { rng } from '../core/math.js';

const windUniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.6, -0.6) } };

function addSway(mat, strength) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec2 uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        float h = max(position.y, 0.0) / 11.0;
        vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float ph = ip.x * 0.11 + ip.z * 0.07;
        float sway = sin(uTime * 1.3 + ph) * 0.5 + sin(uTime * 2.7 + ph * 1.7) * 0.25;
        float frond = smoothstep(0.75, 1.0, h);
        vec2 w = uWind * (h * h * 0.35 + frond * (0.25 + 0.2 * sin(uTime * 4.0 + ph + position.x))) * ${strength.toFixed(2)};
        transformed.xz += w * (0.6 + sway * 0.6);
        transformed.y -= frond * abs(sway) * 0.15;
      }`);
  };
  mat.customProgramCacheKey = () => 'palm-sway-' + strength;
}

function lodPalmGeometry() {
  const parts = [], cols = [];
  const trunk = new THREE.CylinderGeometry(0.14, 0.26, 10.5, 5, 4);
  const p = trunk.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i) + 5.25; p.setXYZ(i, p.getX(i) + Math.pow(y / 10.5, 2) * 0.6, y, p.getZ(i)); }
  parts.push(trunk.toNonIndexed()); cols.push([0.45, 0.36, 0.26]);
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const g = new THREE.BufferGeometry();
    const L = 3.6, W = 0.7;
    const v = [0, 0, 0, L * 0.5, 0.5, W, L, -0.9, 0, 0, 0, 0, L, -0.9, 0, L * 0.5, 0.5, -W];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.computeVertexNormals();
    g.rotateY(a);
    g.translate(0.6, 10.4, 0);
    parts.push(g); cols.push([0.2, 0.42, 0.14]);
  }
  let n = 0; for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  parts.forEach((g, i) => {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    for (let k = 0; k < g.attributes.position.count; k++) col.set(cols[i], (o + k) * 3);
    o += g.attributes.position.count;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

export class Vegetation {
  constructor(game, extraSpots = []) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'palms';
    const density = game.quality.foliage;
    const R = rng(1234);
    const spots = [];
    const tryAdd = (x, z) => {
      const h = heightAt(x, z);
      if (h < 0.25) return;
      spots.push({ x, z, y: h, s: 0.75 + R() * 0.55, r: R() * Math.PI * 2, lean: (R() - 0.5) * 0.22, hue: R() });
    };
    // fictional islands: rings + interior clusters
    for (const isl of ISLANDS) {
      const n = Math.round((isl.r * isl.r) / 650 * density);
      for (let i = 0; i < n; i++) { const a = R() * Math.PI * 2, d = Math.sqrt(R()) * isl.r * 0.95; tryAdd(isl.x + Math.cos(a) * d, isl.z + Math.sin(a) * d); }
    }
    // promenades / beaches along the real coastline (sdf 6..26 m inland)
    const step = 30 / Math.max(0.3, density);
    for (let x = -WORLD_HALF + 200; x < WORLD_HALF - 200; x += step) {
      for (let z = -WORLD_HALF + 200; z < WORLD_HALF - 200; z += step) {
        const jx = x + (R() - 0.5) * step, jz = z + (R() - 0.5) * step;
        const s = shoreDistance(jx, jz);
        const beach = isBeachShore(jx, jz);
        if ((s > 6 && s < 24) || (beach && s > 30 && s < 110 && R() < 0.5)) tryAdd(jx, jz);
      }
    }
    for (const m of MARINAS) for (let i = 0; i < 10; i++) tryAdd(m.x - m.out[0] * (10 + R() * 30) + m.along[0] * (R() - 0.5) * m.width, m.z - m.out[1] * (10 + R() * 30) + m.along[1] * (R() - 0.5) * m.width);
    for (let i = 0; i < 900 * density; i++) {
      const x = -1600 + R() * 3720, z = -1100 + R() * 2050;
      if (isResidentialIsland(x, z) && shoreDistance(x, z) > 12) tryAdd(x, z);
    }
    for (const p of extraSpots) tryAdd(p.x + (R() - 0.5) * 4, p.z + (R() - 0.5) * 4);
    this.spots = spots;

    // near LOD: the attached model, baked per material
    const palm = game.assets.cloneModel('palm', { cloneMaterials: true });
    this.parts = bakeModel(palm, { mergeUntextured: false });
    this.near = this.parts.map((p) => {
      addSway(p.material, 1.0);
      p.material.side = THREE.DoubleSide;
      const im = new THREE.InstancedMesh(p.geometry, p.material, 320);
      im.count = 0; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(320 * 3).fill(1), 3);
      this.group.add(im);
      return im;
    });
    const farMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
    addSway(farMat, 1.0);
    this.far = new THREE.InstancedMesh(lodPalmGeometry(), farMat, spots.length);
    this.far.count = 0; this.far.frustumCulled = false;
    this.far.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3).fill(1), 3);
    this.group.add(this.far);
    this.matrices = spots.map((s) => {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(s.lean, s.r, s.lean * 0.5, 'YXZ'));
      return new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y - 0.2, s.z), q, new THREE.Vector3(s.s, s.s, s.s));
    });
    this.colors = spots.map((s) => new THREE.Color().setHSL(0.22 + (s.hue - 0.5) * 0.06, 0.15, 0.92 + s.hue * 0.12));
    this._last = new THREE.Vector3(1e9, 0, 0);
    this.nearDist = game.quality.palmNear;
    this.farDist = game.quality.drawDistance;
    game.scene.add(this.group);
  }

  update(time, camPos, windVec) {
    windUniforms.uTime.value = time;
    windUniforms.uWind.value.set(windVec.x, windVec.z).multiplyScalar(0.1);
    if (camPos.distanceToSquared(this._last) < 40 * 40) return;
    this._last.copy(camPos);
    let n = 0, f = 0;
    const nd2 = this.nearDist * this.nearDist, fd2 = this.farDist * this.farDist;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      const dx = s.x - camPos.x, dz = s.z - camPos.z, d2 = dx * dx + dz * dz;
      if (d2 < nd2 && n < 320) {
        for (const im of this.near) { im.setMatrixAt(n, this.matrices[i]); im.setColorAt(n, this.colors[i]); }
        n++;
      } else if (d2 < fd2) {
        this.far.setMatrixAt(f, this.matrices[i]); this.far.setColorAt(f, this.colors[i]); f++;
      }
    }
    for (const im of this.near) { im.count = n; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
    this.far.count = f; this.far.instanceMatrix.needsUpdate = true; this.far.instanceColor.needsUpdate = true;
  }
}
