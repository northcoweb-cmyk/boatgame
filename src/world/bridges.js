// Causeways and bridges built from the attached Bridge model (tiled arch spans)
// with the attached Road texture on the deck, a procedural high-rise span on the
// Julia Tuttle (navigation clearance markers), street lights, pier colliders,
// and car traffic using the attached car pack.
import * as THREE from 'three';
import { BRIDGES, heightAt } from './geography.js';
import { bakeToVertexColor, makeMatrix } from '../assets/assets.js';
import { mergeAll } from './city.js';
import { LAYER_NO_REFLECT } from '../render/reflection.js';

const MODEL_DECK = 3.1; // road surface height in the bridge model's units

// Road path: list of segments with deck height function
function tuttleDeckY(x) {
  const b = BRIDGES[0];
  const t = Math.max(0, 1 - Math.abs(x) / 420);
  return b.deck + (b.highDeck - b.deck) * (0.5 - 0.5 * Math.cos(Math.PI * t));
}

export class Roads {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'roads';
    this.paths = [];
    this.lampPositions = [];
    const A = game.assets;

    // --- materials
    const roadSrc = A.models.road;
    let roadTex = null;
    roadSrc.traverse((o) => { if (o.isMesh && o.material.map && !roadTex) roadTex = o.material.map; });
    if (roadTex) { roadTex = roadTex.clone(); roadTex.wrapS = roadTex.wrapT = THREE.RepeatWrapping; roadTex.needsUpdate = true; }
    this.roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.concrete = new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.85 });

    // --- bridge model: measure piers in model space
    const bm = A.models.bridge;
    bm.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(bm);
    this.bridgeLen = box.max.x - box.min.x;
    this.bridgeWidth = box.max.z - box.min.z;
    this.bridgeCenter = box.getCenter(new THREE.Vector3());
    const geo = bakeToVertexColor(bm);
    geo.translate(-this.bridgeCenter.x, -box.min.y, -this.bridgeCenter.z);
    // pier x positions: low vertices clustered
    const pos = geo.attributes.position;
    const lows = [];
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0.35) lows.push(pos.getX(i));
    lows.sort((a, b) => a - b);
    const piers = [];
    for (const x of lows) { if (!piers.length || x - piers[piers.length - 1].max > 1.5) piers.push({ min: x, max: x }); else piers[piers.length - 1].max = x; }
    this.modelPiers = piers.map((p) => (p.min + p.max) / 2);
    const tiles = [];
    const colliders = game.collisions;

    const addTile = (x0, x1, z, deckY, width) => {
      const len = x1 - x0;
      const sx = len / this.bridgeLen, sy = deckY / MODEL_DECK, sz = width / (this.bridgeWidth * 0.82);
      const m = new THREE.Matrix4().compose(new THREE.Vector3((x0 + x1) / 2, 0, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
      tiles.push(m);
      for (const px of this.modelPiers) colliders.addBox((x0 + x1) / 2 + px * sx, z, 2.2, width * 0.42, 0, { yMax: deckY - 1.5, kind: 'pier', damage: 1.2 });
    };

    // --- Venetian Causeway (arch tiles over each water gap, road across islands)
    const ven = BRIDGES[1];
    const venPts = [];
    for (const [a, b] of ven.spans) {
      const n = Math.max(1, Math.round((b - a) / 290));
      for (let i = 0; i < n; i++) addTile(a + (i * (b - a)) / n, a + ((i + 1) * (b - a)) / n, ven.z, ven.deck, ven.width);
    }
    const onSpan = (x, spans) => spans.some(([a, b]) => x > a - 2 && x < b + 2);
    for (let x = ven.spans[0][0] - 60; x <= ven.spans[ven.spans.length - 1][1] + 60; x += 8) {
      const y = onSpan(x, ven.spans) ? ven.deck : Math.max(heightAt(x, ven.z) + 0.12, 2.5);
      venPts.push(new THREE.Vector3(x, y, ven.z));
    }
    this.paths.push({ id: 'venetian', pts: venPts, width: ven.width, lanes: [-1.8, 1.8], cars: 14 });

    // --- Julia Tuttle: arch tiles on the low sections, a high-rise centre span
    const tut = BRIDGES[0];
    const lowA = [tut.x0, -440], lowB = [440, tut.x1];
    for (const [a, b] of [lowA, lowB]) {
      const n = Math.max(1, Math.round((b - a) / 300));
      for (let i = 0; i < n; i++) addTile(a + (i * (b - a)) / n, a + ((i + 1) * (b - a)) / n, tut.z, tut.deck, tut.width);
    }
    const tutPts = [];
    for (let x = tut.x0 - 50; x <= tut.x1 + 50; x += 8) {
      const inBridge = x > tut.x0 && x < tut.x1;
      tutPts.push(new THREE.Vector3(x, inBridge ? tuttleDeckY(x) : Math.max(heightAt(x, tut.z) + 0.12, 2.5), tut.z));
    }
    this.paths.push({ id: 'tuttle', pts: tutPts, width: tut.width, lanes: [-7, -3.5, 3.5, 7], cars: 34 });

    // instanced arch tiles (one draw call)
    const tileMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    const tileMesh = new THREE.InstancedMesh(geo, tileMat, tiles.length);
    tiles.forEach((m, i) => tileMesh.setMatrixAt(i, m));
    tileMesh.castShadow = true; tileMesh.receiveShadow = true;
    tileMesh.computeBoundingSphere();
    this.group.add(tileMesh);

    // high-rise span: procedural box girder + piers + clearance marker boards
    const parts = [];
    const deckBox = (x0, x1) => {
      const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
      const ya = tuttleDeckY(xa), yb = tuttleDeckY(xb);
      const len = Math.hypot(xb - xa, yb - ya);
      const g = new THREE.BoxGeometry(len, 1.8, tut.width);
      g.rotateZ(Math.atan2(yb - ya, xb - xa));
      g.translate((xa + xb) / 2, (ya + yb) / 2 - 1.0, tut.z);
      parts.push(g);
      // parapets
      for (const s of [-1, 1]) {
        const p = new THREE.BoxGeometry(len, 0.9, 0.35);
        p.rotateZ(Math.atan2(yb - ya, xb - xa));
        p.translate((xa + xb) / 2, (ya + yb) / 2 + 0.45, tut.z + s * (tut.width / 2 - 0.2));
        parts.push(p);
      }
    };
    for (let x = -440; x < 440; x += 20) deckBox(x, x + 20);
    for (let x = -420; x <= 420; x += 60) {
      if (Math.abs(x) < 70) continue; // navigation channel
      for (const s of [-1, 1]) {
        const h = tuttleDeckY(x) - 1.9;
        const c = new THREE.CylinderGeometry(1.4, 1.7, h + 6, 12);
        c.translate(x, h / 2 - 3, tut.z + s * tut.width * 0.3);
        parts.push(c);
        colliders.addCircle(x, tut.z + s * tut.width * 0.3, 1.8, { kind: 'pier', damage: 1.2 });
      }
    }
    const span = new THREE.Mesh(mergeAll(parts.map((g) => g.index ? g : g)), this.concrete);
    span.castShadow = true; span.receiveShadow = true;
    this.group.add(span);
    // fender pilings + clearance boards each side of the channel
    const markerMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const boardTex = makeClearanceTexture(Math.round(tut.highDeck - 3.5));
    const boardMat = new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.6, emissive: 0xffffff, emissiveMap: boardTex, emissiveIntensity: 0 });
    this.boardMat = boardMat;
    for (const s of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), boardMat);
      board.position.set(s * 55, tuttleDeckY(55) - 3.2, tut.z + s * (tut.width / 2 + 0.3));
      board.rotation.y = s > 0 ? 0 : Math.PI;
      this.group.add(board);
      for (const zz of [-1, 1]) {
        const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 9, 8), markerMat);
        pile.position.set(s * 62, 1.5, tut.z + zz * 18);
        this.group.add(pile);
        colliders.addCircle(s * 62, tut.z + zz * 18, 0.6, { kind: 'piling' });
      }
    }

    // --- road surface strips along every path
    const rparts = [];
    for (const p of this.paths) rparts.push(roadStrip(p.pts, p.width));
    const road = new THREE.Mesh(mergeStrips(rparts), this.roadMat);
    road.receiveShadow = true;
    this.group.add(road);

    // --- street lights on the bridges
    const lampPts = [];
    for (const p of this.paths) {
      for (let i = 0; i < p.pts.length; i += 5) {
        const pt = p.pts[i];
        for (const s of [-1, 1]) lampPts.push(new THREE.Vector3(pt.x, pt.y, pt.z + s * (p.width / 2 - 0.3)));
      }
    }
    const pole = new THREE.CylinderGeometry(0.09, 0.12, 9, 6); pole.translate(0, 4.5, 0);
    const poleMesh = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.6, roughness: 0.4 }), lampPts.length);
    const headGeo = new THREE.SphereGeometry(0.35, 8, 6); headGeo.translate(0, 9, 0);
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const heads = new THREE.InstancedMesh(headGeo, this.lampMat, lampPts.length);
    lampPts.forEach((p, i) => { const m = makeMatrix(p.x, p.y, p.z); poleMesh.setMatrixAt(i, m); heads.setMatrixAt(i, m); });
    poleMesh.layers.enable(0);
    this.group.add(poleMesh, heads);
    heads.layers.enable(LAYER_NO_REFLECT);

    // --- car traffic
    this.traffic = new CarTraffic(game, this.paths);
    this.group.add(this.traffic.group);
    game.scene.add(this.group);
  }

  update(dt, night, camPos) {
    this.lampMat.color.setRGB(1.0, 0.78, 0.5).multiplyScalar(0.15 + night * 8);
    this.boardMat.emissiveIntensity = night * 0.8;
    this.traffic.update(dt, night, camPos);
  }
}

function roadStrip(pts, width) {
  const n = pts.length;
  const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), nor = new Float32Array(n * 2 * 3);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (i > 0) s += p.distanceTo(pts[i - 1]);
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl;
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -0.5 : 0.5;
      const j = i * 2 + k;
      pos[j * 3] = p.x + nx * width * side; pos[j * 3 + 1] = p.y + 0.06; pos[j * 3 + 2] = p.z + nz * width * side;
      uv[j * 2] = k; uv[j * 2 + 1] = s / 15;
      nor[j * 3 + 1] = 1;
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
function mergeStrips(list) {
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = [];
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); uv.set(g.attributes.uv.array, o * 2);
    for (const i of g.index.array) idx.push(i + o);
    o += g.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function makeClearanceTexture(meters) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#f5f2e8'; g.fillRect(0, 0, 256, 160);
  g.fillStyle = '#0d2a4a'; g.fillRect(8, 8, 240, 144);
  g.fillStyle = '#ffffff';
  g.font = 'bold 30px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText('CLEARANCE', 128, 56);
  g.font = 'bold 54px system-ui, sans-serif';
  g.fillText(`${meters} m`, 128, 120);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// --------------------------------------------------------------------- cars
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();

export function extractCars(carsModel) {
  carsModel.updateMatrixWorld(true);
  const clusters = [];
  carsModel.traverse((o) => {
    if (!o.isMesh) return;
    const bb = new THREE.Box3().setFromObject(o);
    const size = bb.getSize(new THREE.Vector3());
    if (size.x > 9 || size.z > 9) { o.visible = false; return; } // turntable
    const c = bb.getCenter(new THREE.Vector3());
    const ang = Math.atan2(c.z, c.x);
    let cl = clusters.find((k) => Math.abs(Math.atan2(Math.sin(k.ang - ang), Math.cos(k.ang - ang))) < 0.28);
    if (!cl) { cl = { ang, meshes: [] }; clusters.push(cl); }
    cl.meshes.push(o);
  });
  const types = [];
  for (const cl of clusters) {
    const set = new Set(cl.meshes);
    const geo = bakeToVertexColor(carsModel, { filter: (o) => set.has(o) });
    geo.computeBoundingBox();
    const c = geo.boundingBox.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -geo.boundingBox.min.y, -c.z);
    // align the car's long axis with Z
    const r = Math.atan2(c.z, c.x);
    geo.rotateY(r - Math.PI / 2 + Math.PI / 2);
    geo.computeBoundingBox();
    const sz = geo.boundingBox.getSize(new THREE.Vector3());
    if (sz.x > sz.z) geo.rotateY(Math.PI / 2);
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    types.push(geo);
  }
  return types;
}

export class CarTraffic {
  constructor(game, paths) {
    this.group = new THREE.Group();
    this.types = game.carTypes;            // regular passenger cars
    this.sports = game.sportsCarTypes;     // Ferrari / BMW — about 1 in 20
    this.cars = [];
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.45 });
    const all = [...this.types, ...this.sports];
    this.meshes = all.map((g) => {
      const m = new THREE.InstancedMesh(g, mat, 70);
      m.count = 0; m.castShadow = true; m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
    this.lightGeo = new THREE.SphereGeometry(0.16, 6, 4);
    this.headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.tailMat = new THREE.MeshBasicMaterial({ color: 0xff2020 });
    this.heads = new THREE.InstancedMesh(this.lightGeo, this.headMat, 240);
    this.tails = new THREE.InstancedMesh(this.lightGeo, this.tailMat, 240);
    this.heads.frustumCulled = this.tails.frustumCulled = false;
    this.group.add(this.heads, this.tails);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    this.signals = [];
    for (const p of paths) {
      const s = [0];
      for (let i = 1; i < p.pts.length; i++) s.push(s[i - 1] + p.pts[i].distanceTo(p.pts[i - 1]));
      p.len = s[s.length - 1]; p.s = s;
      p.signals = [];
      // traffic signals at the island intersections of the Venetian Causeway
      if (p.id === 'venetian') {
        for (const [k, x] of [-1100, 260, 1120].entries()) {
          const d = this.arcAtX(p, x);
          const sig = { path: p, d, x, z: p.pts[0].z, phase: k * 9, state: 'green' };
          p.signals.push(sig); this.signals.push(sig);
        }
      }
      const limit = p.id === 'tuttle' ? 24.6 : 13.4; // 55 mph causeway, 30 mph Venetian
      for (let i = 0; i < p.cars; i++) {
        const lane = p.lanes[i % p.lanes.length];
        const sporty = rnd() < 0.05 && this.sports.length > 0;
        const type = sporty ? this.types.length + ((rnd() * this.sports.length) | 0) : (rnd() * this.types.length) | 0;
        const v = limit * (0.88 + rnd() * 0.18) * (sporty ? 1.12 : 1) * (Math.abs(lane) > 5 ? 1.06 : 1);
        this.cars.push({ path: p, lane, dir: lane > 0 ? 1 : -1, d: (i / p.cars) * p.len + rnd() * 20, v, vTarget: v, type });
      }
    }
    // signal heads (3 lamps each side)
    const poles = [], lamps = [];
    for (const sg of this.signals) for (const side of [-1, 1]) {
      const z = sg.z + side * 7.5;
      poles.push(makeMatrix(sg.x - side * 3, 2.6, z));
      for (let l = 0; l < 3; l++) lamps.push({ sg, l, m: makeMatrix(sg.x - side * 3, 7.6 - l * 0.55, z + side * 0.25) });
    }
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.14, 6.2, 6); poleGeo.translate(0, 3.1, 0);
    const poleMesh = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.6 }), Math.max(1, poles.length));
    poles.forEach((m, i) => poleMesh.setMatrixAt(i, m));
    this.group.add(poleMesh);
    this.lamps = lamps;
    this.lampMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, lamps.length));
    lamps.forEach((L, i) => this.lampMesh.setMatrixAt(i, L.m));
    this.lampMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, lamps.length) * 3), 3);
    this.group.add(this.lampMesh);
    this.time = 0;
    this._tan = new THREE.Vector3();
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._dir = new THREE.Vector3();
    this._qp = new THREE.Quaternion();
    this._x = new THREE.Vector3(1, 0, 0);
    this._col = new THREE.Color();
    this.byLane = new Map();
    for (const c of this.cars) {
      const k = c.path.id + c.lane;
      if (!this.byLane.has(k)) this.byLane.set(k, []);
      this.byLane.get(k).push(c);
    }
  }

  arcAtX(p, x) {
    let best = 0, bd = 1e9;
    for (let i = 0; i < p.pts.length; i++) { const d = Math.abs(p.pts[i].x - x); if (d < bd) { bd = d; best = i; } }
    return p.s[best];
  }

  samplePath(p, d, lane, out, tan) {
    d = ((d % p.len) + p.len) % p.len;
    let lo = 0, hi = p.s.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.s[mid] < d) lo = mid; else hi = mid; }
    const t = (d - p.s[lo]) / Math.max(1e-6, p.s[hi] - p.s[lo]);
    const a = p.pts[lo], b = p.pts[hi];
    tan.subVectors(b, a).normalize();
    out.lerpVectors(a, b, t);
    out.x += -tan.z * lane; out.z += tan.x * lane;
  }

  update(dt, night, camPos) {
    this.time += dt;
    // signal cycle: 20 s green, 3 s amber, 12 s red
    for (const sg of this.signals) {
      const t = (this.time + sg.phase) % 35;
      sg.state = t < 20 ? 'green' : t < 23 ? 'amber' : 'red';
    }
    for (const [, list] of this.byLane) {
      list.sort((a, b) => a.d - b.d);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const ahead = c.dir > 0 ? list[(i + 1) % list.length] : list[(i - 1 + list.length) % list.length];
        let gap = c.dir > 0 ? ahead.d - c.d : c.d - ahead.d;
        if (gap <= 0) gap += c.path.len;
        if (list.length === 1) gap = 1e9;
        // stop line of the next red/amber signal
        for (const sg of c.path.signals) {
          if (sg.state === 'green') continue;
          const stop = sg.d - c.dir * 9;
          const dist = c.dir > 0 ? stop - c.d : c.d - stop;
          if (dist > -1 && dist < 60) {
            if (sg.state === 'amber' && dist < c.v * 0.9) continue; // too close to stop: go through
            gap = Math.min(gap, dist + 7);
          }
        }
        const headway = 7 + c.v * 1.6; // ~1.6 s following distance
        let want = c.vTarget;
        if (gap < headway) want = Math.min(want, Math.max(0, (gap - 7) / 1.6));
        // comfortable acceleration (2.2 m/s²), firm braking (5.5 m/s²)
        c.v = Math.max(0, c.v + Math.max(-5.5 * dt, Math.min(2.2 * dt, (want - c.v) * 2)));
      }
    }
    const counts = this.meshes.map(() => 0);
    let lights = 0;
    const tan = this._tan;
    for (const c of this.cars) {
      c.d += c.v * c.dir * dt;
      if (c.d > c.path.len) c.d -= c.path.len;
      if (c.d < 0) c.d += c.path.len;
      this.samplePath(c.path, c.d, c.lane, _p, tan);
      if (_p.distanceToSquared(camPos) > 2600 * 2600) continue;
      if (c.dir < 0) tan.negate();
      this._dir.set(tan.x, 0, tan.z).normalize();
      _q.setFromUnitVectors(this._fwd, this._dir);
      this._qp.setFromAxisAngle(this._x, Math.asin(Math.max(-1, Math.min(1, tan.y))));
      _q.multiply(this._qp);
      _m.compose(_p, _q, _s);
      const mi = c.type;
      if (counts[mi] < 70) this.meshes[mi].setMatrixAt(counts[mi]++, _m);
      if (night > 0.3 && lights < 236) {
        for (const s of [-0.7, 0.7]) {
          this.heads.setMatrixAt(lights, _m.makeTranslation(_p.x + tan.x * 2.15 - tan.z * s, _p.y + 0.7, _p.z + tan.z * 2.15 + tan.x * s));
          this.tails.setMatrixAt(lights, _m.makeTranslation(_p.x - tan.x * 2.15 - tan.z * s, _p.y + 0.8, _p.z - tan.z * 2.15 + tan.x * s));
          lights++;
        }
      }
    }
    this.meshes.forEach((m, i) => { m.count = counts[i]; m.instanceMatrix.needsUpdate = true; });
    this.heads.count = this.tails.count = lights;
    this.heads.instanceMatrix.needsUpdate = this.tails.instanceMatrix.needsUpdate = true;
    this.headMat.color.setRGB(1, 0.95, 0.85).multiplyScalar(2 + night * 6);
    this.tailMat.color.setRGB(1, 0.1, 0.08).multiplyScalar(1 + night * 4);
    // signal lamp colours
    const on = { 0: 'red', 1: 'amber', 2: 'green' };
    this.lamps.forEach((L, i) => {
      const lit = L.sg.state === on[L.l];
      const base = L.l === 0 ? [1, 0.08, 0.05] : L.l === 1 ? [1, 0.6, 0.05] : [0.1, 1, 0.35];
      const k = lit ? 3 + night * 5 : 0.06;
      this._col.setRGB(base[0] * k, base[1] * k, base[2] * k);
      this.lampMesh.setColorAt(i, this._col);
    });
    if (this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;
  }
}
