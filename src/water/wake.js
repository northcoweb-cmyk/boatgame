// Boat wakes. One particle system drives both what you see and what you feel:
//  * GPU: particles are splatted every frame into a world-anchored half-float
//    render target (R = foam, G = wave height) sampled by the ocean shader.
//  * CPU: a spatial hash lets buoyancy probes read the same wake heights, so
//    wakes genuinely rock other boats (and launch the dinghy).
// Emitters: Kelvin arms at the correct 19.47° half-angle, hull wash, prop wash
// turbulence (scales with throttle), turning foam, and 3D bow spray sprites.
import * as THREE from 'three';
import { clamp, clamp01, smoothstep } from '../core/math.js';
import { LAYER_NO_REFLECT } from '../render/reflection.js';

const MAX = 7000;
const CELL = 8;
const KELVIN = Math.tan(19.47 * Math.PI / 180);

export class WakeSystem {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.res = 1024;
    this.size = 260;          // 0.25 m texels: foam needs fine structure          // metres covered by the wake texture
    this.n = 0;
    const f = (k) => new Float32Array(MAX * k);
    this.px = f(1); this.pz = f(1); this.vx = f(1); this.vz = f(1);
    this.age = f(1); this.life = f(1); this.foam = f(1); this.amp = f(1);
    this.rad = f(1); this.grow = f(1); this.ang = f(1); this.asp = f(1);
    this.target = new THREE.WebGLRenderTarget(this.res, this.res, { type: THREE.HalfFloatType, depthBuffer: false });
    this.target.texture.minFilter = THREE.LinearFilter;
    this.target.texture.magFilter = THREE.LinearFilter;
    this.rect = new THREE.Vector3(0, 0, this.size);
    // instanced splat quads
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.iData = new Float32Array(MAX * 4); // x, z, radius, angle
    this.iVal = new Float32Array(MAX * 4);  // foam, height, aspect, age01
    this.iDataAttr = new THREE.InstancedBufferAttribute(this.iData, 4);
    this.iValAttr = new THREE.InstancedBufferAttribute(this.iVal, 4);
    this.iDataAttr.setUsage(THREE.DynamicDrawUsage);
    this.iValAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iData', this.iDataAttr);
    geo.setAttribute('iVal', this.iValAttr);
    geo.instanceCount = 0;
    // RGB: signed wave height (additive). Alpha: foam coverage (MAX blend, so
    // overlapping particles never pile up into a white carpet).
    this.splatMat = new THREE.ShaderMaterial({
      uniforms: { uRect: { value: this.rect } },
      vertexShader: /* glsl */ `
        attribute vec4 iData; attribute vec4 iVal;
        uniform vec3 uRect;
        varying vec2 vQ; varying vec4 vVal; varying vec2 vW;
        void main() {
          vQ = position.xy; vVal = iVal;
          float c = cos(iData.w), s = sin(iData.w);
          vec2 q = vec2(position.x * iVal.z, position.y);       // stretch along travel
          vec2 w = iData.xy + vec2(q.x * c - q.y * s, q.x * s + q.y * c) * iData.z;
          vW = w;
          vec2 uv = (w - uRect.xy) / uRect.z;
          gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vQ; varying vec4 vVal; varying vec2 vW;
        float h(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float n2(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y); }
        void main() {
          float r2 = dot(vQ, vQ);
          if (r2 > 1.0) discard;
          float g = exp(-r2 * 3.2);
          // foam erodes with age into lace; fresh foam is dense turbulence
          float lace = n2(vW * 1.6) * 0.65 + n2(vW * 4.1) * 0.35;
          float erode = mix(0.15, 0.78, vVal.w);
          float foam = vVal.x * smoothstep(erode, erode + 0.22, lace * g + g * 0.35) ;
          gl_FragColor = vec4(0.0, vVal.y * g, 0.0, foam);
        }`,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      depthTest: false, depthWrite: false, transparent: true,
    });
    this.splatMesh = new THREE.Mesh(geo, this.splatMat);
    this.splatMesh.frustumCulled = false;
    this.splatScene = new THREE.Scene();
    this.splatScene.add(this.splatMesh);
    this.splatCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // CPU spatial hash
    this.gridN = 128;
    this.gridHead = new Int32Array(this.gridN * this.gridN);
    this.next = new Int32Array(MAX);
    this.gridOrigin = { x: 0, z: 0 };

    // spray sprites (3D, main scene)
    this.sprayMax = 1500;
    this.sprayPos = new Float32Array(this.sprayMax * 3);
    this.sprayVel = new Float32Array(this.sprayMax * 3);
    this.sprayLife = new Float32Array(this.sprayMax);
    this.sprayAge = new Float32Array(this.sprayMax);
    this.sprayN = 0;
    const sg = new THREE.BufferGeometry();
    this.sprayAttr = new THREE.BufferAttribute(new Float32Array(this.sprayMax * 3), 3);
    this.sprayAlpha = new THREE.BufferAttribute(new Float32Array(this.sprayMax), 1);
    this.sprayAttr.setUsage(THREE.DynamicDrawUsage);
    this.sprayAlpha.setUsage(THREE.DynamicDrawUsage);
    sg.setAttribute('position', this.sprayAttr);
    sg.setAttribute('aAlpha', this.sprayAlpha);
    sg.setDrawRange(0, 0);
    this.sprayMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uScale: { value: 400 } },
      vertexShader: /* glsl */ `
        attribute float aAlpha; varying float vA; uniform float uScale;
        void main() { vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(uScale * (0.18 + (1.0 - aAlpha) * 0.25) / -mv.z, 1.0, 64.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        varying float vA; uniform vec3 uColor;
        void main() { vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard; gl_FragColor = vec4(uColor, vA * (1.0 - r) * 0.55); }`,
      transparent: true, depthWrite: false,
    });
    this.spray = new THREE.Points(sg, this.sprayMat);
    this.spray.frustumCulled = false;
    this.spray.layers.set(LAYER_NO_REFLECT);
    this.spray.renderOrder = 5;
  }

  get texture() { return this.target.texture; }

  add(x, z, vx, vz, life, foam, amp, rad, grow, ang = 0, asp = 1) {
    let i;
    if (this.n < MAX) i = this.n++;
    else {
      // recycle the oldest-looking slot cheaply
      i = (Math.random() * MAX) | 0;
    }
    this.px[i] = x; this.pz[i] = z; this.vx[i] = vx; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life; this.foam[i] = foam; this.amp[i] = amp;
    this.rad[i] = rad; this.grow[i] = grow; this.ang[i] = ang; this.asp[i] = asp;
  }

  addSpray(x, y, z, vx, vy, vz, life) {
    if (this.sprayN >= this.sprayMax) return;
    const i = this.sprayN++;
    this.sprayPos[i * 3] = x; this.sprayPos[i * 3 + 1] = y; this.sprayPos[i * 3 + 2] = z;
    this.sprayVel[i * 3] = vx; this.sprayVel[i * 3 + 1] = vy; this.sprayVel[i * 3 + 2] = vz;
    this.sprayLife[i] = life; this.sprayAge[i] = 0;
  }

  // Splash burst (landings, collisions, anchor drop, bullets).
  splash(x, y, z, strength) {
    const n = Math.min(80, (12 + strength * 20) | 0);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = (0.5 + Math.random()) * strength * 2.2;
      this.addSpray(x, y, z, Math.cos(a) * s, 1.5 + Math.random() * strength * 3, Math.sin(a) * s, 0.6 + Math.random() * 0.8);
    }
    for (let k = 0; k < 6; k++) this.add(x + (Math.random() - 0.5) * 2, z + (Math.random() - 0.5) * 2, 0, 0, 8, 0.7 * Math.min(1, strength), 0.08 * strength, 1.2 + strength, 0.35);
  }

  /**
   * Emit wake for a boat. st carries the boat state:
   * { x, z, fx, fz (forward unit), speed, beam, length, throttle, mass, bowX, bowZ, sternX, sternZ, yawRate, wet, distAccum }
   */
  emitBoat(st, dt) {
    const V = st.speed;
    if (st.wet < 0.05) return;
    const rx = -st.fz, rz = st.fx; // starboard
    const sizeK = Math.sqrt(st.mass / 1400);
    const vk = clamp01(V / 7);
    const powered = st.throttle > 0.05;
    const heading = Math.atan2(st.fz, st.fx); // travel angle in the wake texture plane
    st.distAccum = (st.distAccum || 0) + V * dt;
    const spacing = 0.55;
    while (st.distAccum > spacing) {
      st.distAccum -= spacing;
      if (V < 0.8) break;
      const spread = V * KELVIN;
      const ampK = 0.035 * Math.min(sizeK, 2.2) * smoothstep(0.8, 5, V) * (1.15 - 0.45 * smoothstep(8, 18, V)) * clamp(st.wet * 1.5, 0.3, 1);
      const hb = st.beam * 0.42;
      for (const s of [-1, 1]) {
        // Kelvin arms: thin streaks aligned with the arm direction
        const armAng = heading - s * 0.34; // arms trail outward at the Kelvin angle
        this.add(st.bowX + rx * hb * s, st.bowZ + rz * hb * s, rx * s * spread, rz * s * spread, 16 + Math.random() * 6,
          0.5 * vk * smoothstep(1.5, 6, V), ampK * (2.2 + V * 0.12), 0.3 + st.beam * 0.05, 0.03, armAng, 3.4);
        // hull wash breaking off the chines (short-lived)
        const t = 0.45 + Math.random() * 0.45;
        const hx = st.bowX + (st.sternX - st.bowX) * t, hz = st.bowZ + (st.sternZ - st.bowZ) * t;
        this.add(hx + rx * hb * s * 1.08, hz + rz * hb * s * 1.08, rx * s * spread * 0.5, rz * s * spread * 0.5, 4, 0.6 * vk, 0, 0.28 + st.beam * 0.05, 0.06, heading, 2.4);
      }
      // prop wash: a narrow turbulent band directly astern, only under power
      if (powered) {
        const thr = st.throttle;
        const j = (Math.random() - 0.5) * st.beam * 0.35;
        this.add(st.sternX + rx * j, st.sternZ + rz * j, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, 10 + Math.random() * 8,
          0.75 * (0.35 + 0.65 * thr) * smoothstep(0.5, 4, V), -0.04 * sizeK * vk, st.beam * 0.15, 0.035, heading, 2.6);
      }
      // turning: outside of the turn churns
      if (Math.abs(st.yawRate) > 0.15 && V > 4) {
        const s = st.yawRate > 0 ? 1 : -1;
        this.add(st.sternX + rx * s * st.beam * 0.55, st.sternZ + rz * s * st.beam * 0.55, rx * s, rz * s, 8, 0.5 * clamp01(Math.abs(st.yawRate)), 0.04 * sizeK, st.beam * 0.22, 0.08, heading, 1.6);
      }
    }
    // hull/water contact: a thin broken collar of foam along the waterline,
    // a curling bow wave that grows with speed, gentle lapping when idle
    {
      const n = Math.min(10, 2 + V * 0.8) * dt * 30;
      for (let k = 0; k < n; k++) {
        const t = Math.random();                    // 0 bow .. 1 stern
        const s = Math.random() < 0.5 ? -1 : 1;
        const w = t < 0.3 ? Math.sin((t / 0.3) * Math.PI / 2) : 1;
        const hb = st.beam * 0.5 * w + 0.15;
        const x = st.bowX + (st.sternX - st.bowX) * t + rx * s * hb;
        const z = st.bowZ + (st.sternZ - st.bowZ) * t + rz * s * hb;
        const bow = 1 - smoothstep(0, 0.35, t);
        const f = 0.18 + 0.55 * vk * (0.5 + bow);
        this.add(x, z, rx * s * (0.3 + V * 0.12 * bow), rz * s * (0.3 + V * 0.12 * bow), 0.8 + vk * 1.4, f, bow * 0.03 * vk, 0.22 + 0.25 * vk, 0.25, heading, 1.8);
      }
    }
    // idle / reverse prop churn at low speed (engine in gear only)
    if (V < 0.8 && powered && Math.random() < dt * 12) {
      this.add(st.sternX + (Math.random() - 0.5) * 0.6, st.sternZ + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, 4, 0.4 * st.throttle, 0, st.beam * 0.18, 0.15, Math.random() * 6.28, 1.3);
    }
    // bow spray sprites (planing speeds, more in chop)
    if (V > 6 && st.sprayK > 0) {
      const n = Math.min(4, V * dt * 1.6 * st.sprayK);
      for (let k = 0; k < n; k++) {
        const s = Math.random() < 0.5 ? -1 : 1;
        const t = 0.2 + Math.random() * 0.25;
        const x = st.bowX + (st.sternX - st.bowX) * t + rx * s * st.beam * 0.5;
        const z = st.bowZ + (st.sternZ - st.bowZ) * t + rz * s * st.beam * 0.5;
        const sp = V * 0.18;
        this.addSpray(x, st.y + 0.05, z, rx * s * sp + st.vx * 0.85, 0.6 + Math.random() * V * 0.12, rz * s * sp + st.vz * 0.85, 0.35 + Math.random() * 0.35);
      }
    }
  }

  update(dt, center, current) {
    // particles
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        const j = --this.n;
        this.px[i] = this.px[j]; this.pz[i] = this.pz[j]; this.vx[i] = this.vx[j]; this.vz[i] = this.vz[j];
        this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.foam[i] = this.foam[j]; this.amp[i] = this.amp[j];
        this.rad[i] = this.rad[j]; this.grow[i] = this.grow[j]; this.ang[i] = this.ang[j]; this.asp[i] = this.asp[j];
        continue;
      }
      const damp = Math.exp(-dt * 0.12);
      this.vx[i] *= damp; this.vz[i] *= damp;
      this.px[i] += (this.vx[i] + current.x) * dt;
      this.pz[i] += (this.vz[i] + current.z) * dt;
      this.rad[i] += this.grow[i] * dt;
      i++;
    }
    // spatial hash around the centre
    const N = this.gridN;
    this.gridOrigin.x = Math.floor(center.x / CELL) * CELL - (N * CELL) / 2;
    this.gridOrigin.z = Math.floor(center.z / CELL) * CELL - (N * CELL) / 2;
    this.gridHead.fill(-1);
    for (let k = 0; k < this.n; k++) {
      if (this.amp[k] === 0) continue;
      const gx = ((this.px[k] - this.gridOrigin.x) / CELL) | 0, gz = ((this.pz[k] - this.gridOrigin.z) / CELL) | 0;
      if (gx < 0 || gz < 0 || gx >= N || gz >= N) continue;
      const c = gz * N + gx;
      this.next[k] = this.gridHead[c];
      this.gridHead[c] = k;
    }
    // spray
    let s = 0;
    const pos = this.sprayAttr.array, al = this.sprayAlpha.array;
    while (s < this.sprayN) {
      this.sprayAge[s] += dt;
      if (this.sprayAge[s] >= this.sprayLife[s] || this.sprayPos[s * 3 + 1] < -0.5) {
        const j = --this.sprayN;
        for (let c = 0; c < 3; c++) { this.sprayPos[s * 3 + c] = this.sprayPos[j * 3 + c]; this.sprayVel[s * 3 + c] = this.sprayVel[j * 3 + c]; }
        this.sprayAge[s] = this.sprayAge[j]; this.sprayLife[s] = this.sprayLife[j];
        continue;
      }
      this.sprayVel[s * 3 + 1] -= 9.81 * dt;
      const dr = Math.exp(-dt * 1.2);
      this.sprayVel[s * 3] *= dr; this.sprayVel[s * 3 + 2] *= dr;
      for (let c = 0; c < 3; c++) { this.sprayPos[s * 3 + c] += this.sprayVel[s * 3 + c] * dt; pos[s * 3 + c] = this.sprayPos[s * 3 + c]; }
      al[s] = 1 - this.sprayAge[s] / this.sprayLife[s];
      s++;
    }
    this.sprayAttr.needsUpdate = true;
    this.sprayAlpha.needsUpdate = true;
    this.spray.geometry.setDrawRange(0, this.sprayN);
  }

  // Wake height at a world point (CPU, for buoyancy).
  heightAt(x, z) {
    const N = this.gridN;
    const gx = Math.floor((x - this.gridOrigin.x) / CELL), gz = Math.floor((z - this.gridOrigin.z) / CELL);
    if (gx < 1 || gz < 1 || gx >= N - 1 || gz >= N - 1) return 0;
    let h = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      let k = this.gridHead[(gz + dz) * N + gx + dx];
      while (k >= 0) {
        const r = this.rad[k];
        const ddx = this.px[k] - x, ddz = this.pz[k] - z;
        const d2 = (ddx * ddx + ddz * ddz) / (r * r);
        if (d2 < 3) {
          const fade = this.ageFade(k);
          h += this.amp[k] * fade * Math.exp(-d2 * 3);
        }
        k = this.next[k];
      }
    }
    return h;
  }

  ageFade(k) {
    const t = this.age[k] / this.life[k];
    return Math.exp(-this.age[k] / 5) * (1 - t) * smoothstep(0, 0.3, this.age[k]);
  }

  render(center) {
    const half = this.size / 2, texel = this.size / this.res;
    this.rect.set(Math.floor((center.x - half) / texel) * texel, Math.floor((center.z - half) / texel) * texel, this.size);
    let m = 0;
    for (let k = 0; k < this.n; k++) {
      const x = this.px[k], z = this.pz[k];
      if (x < this.rect.x - 10 || z < this.rect.y - 10 || x > this.rect.x + this.size + 10 || z > this.rect.y + this.size + 10) continue;
      const t = this.age[k] / this.life[k];
      const foamFade = (1 - t) * smoothstep(0, 0.12, this.age[k] + 0.04);
      this.iData[m * 4] = x; this.iData[m * 4 + 1] = z; this.iData[m * 4 + 2] = this.rad[k]; this.iData[m * 4 + 3] = this.ang[k];
      this.iVal[m * 4] = this.foam[k] * foamFade;
      this.iVal[m * 4 + 1] = this.amp[k] * this.ageFade(k);
      this.iVal[m * 4 + 2] = this.asp[k];
      this.iVal[m * 4 + 3] = t;
      m++;
    }
    const geo = this.splatMesh.geometry;
    geo.instanceCount = m;
    this.iDataAttr.clearUpdateRanges(); this.iDataAttr.addUpdateRange(0, m * 4); this.iDataAttr.needsUpdate = true;
    this.iValAttr.clearUpdateRanges(); this.iValAttr.addUpdateRange(0, m * 4); this.iValAttr.needsUpdate = true;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    if (m > 0) r.render(this.splatScene, this.splatCam);
    r.setRenderTarget(prev);
  }
}
