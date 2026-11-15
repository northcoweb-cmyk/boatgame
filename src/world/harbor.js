// Harbor life that makes the bay feel inhabited:
//  * PortMiami: three ~300 m cruise ships berthed along Dodge Island's north
//    quay (procedural hulls + stacked decks, lit cabins/balconies at night via
//    the city facade shader), with colliders.
//  * Stiltsville: stilt houses (the attached rusty-roof stilt house model) out
//    on the southern flats, each with a little landing.
//  * Paddleboarders on boards near the beaches, sandbars and islands.
// Also exports procedural sailboat + jet-ski geometry used by boat traffic.
import * as THREE from 'three';
import { heightAt } from './geography.js';
import { bakeModel, instanceParts, makeMatrix } from '../assets/assets.js';
import { facadeMaterial } from './city.js';

// --------------------------------------------------------------- geometry helpers
// Merge geometries carrying position/normal + a per-part colour and building
// data (aBld = top height for the window shader, glassiness).
function packPart(geo, color, topH, glass, hash) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 4), bld = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { col.set([color.r, color.g, color.b, hash], i * 4); bld.set([topH, glass], i * 2); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setAttribute('aBld', new THREE.BufferAttribute(bld, 2));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'aBld'].includes(k)) g.deleteAttribute(k);
  return g;
}
function mergePacked(parts) {
  let n = 0; for (const g of parts) n += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const [k, size] of [['position', 3], ['normal', 3], ['color', 4], ['aBld', 2]]) {
    const arr = new Float32Array(n * size); let o = 0;
    for (const g of parts) { arr.set(g.attributes[k].array, o); o += g.attributes[k].array.length; }
    out.setAttribute(k, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

// Ship outline (top view) in local coords: bow toward -Z
function shipOutline(L, B, bowLen) {
  const s = new THREE.Shape();
  s.moveTo(-B / 2, L / 2);
  s.lineTo(B / 2, L / 2);
  s.lineTo(B / 2, -L / 2 + bowLen);
  s.quadraticCurveTo(B / 2, -L / 2 + bowLen * 0.25, 0, -L / 2);
  s.quadraticCurveTo(-B / 2, -L / 2 + bowLen * 0.25, -B / 2, -L / 2 + bowLen);
  s.closePath();
  return s;
}
function extrudeY(shape, y0, h) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 10 });
  g.rotateX(-Math.PI / 2); // extrusion along +Y; shape y -> -z
  g.scale(1, 1, -1);       // keep bow toward -Z
  g.translate(0, y0, 0);
  return g;
}

export function cruiseShipGeometry(seed = 0) {
  const L = 290, B = 38;
  const white = new THREE.Color(0.96, 0.96, 0.95), navy = new THREE.Color(0.06, 0.12, 0.28), red = new THREE.Color(0.75, 0.12, 0.1), yellow = new THREE.Color(0.95, 0.72, 0.12), glass = new THREE.Color(0.2, 0.3, 0.38);
  const parts = [];
  parts.push(packPart(extrudeY(shipOutline(L, B, 70), -9, 9.5), navy, 0, 0, 0.11));            // hull below the boot top
  parts.push(packPart(extrudeY(shipOutline(L, B, 70), 0.5, 10), white, 0, 0, 0.12));           // white topsides
  // superstructure: 10 stacked decks, stepping back toward the bow
  for (let d = 0; d < 10; d++) {
    const y = 10.5 + d * 3.2;
    const len = L * (0.86 - d * 0.018), off = (L - len) / 2 + d * 1.6;
    const g = extrudeY(shipOutline(len, B * (0.97 - d * 0.012), 34 + d * 3), y, 3.2);
    g.translate(0, 0, off - (L - len) * 0.35);
    parts.push(packPart(g, white, 60, 0.25, 0.3 + seed * 0.05 + d * 0.01));
  }
  // bridge wings + funnel + lifeboats + pool deck glass
  const bridge = new THREE.BoxGeometry(B + 6, 3, 9); bridge.translate(0, 40.5, -L * 0.28);
  parts.push(packPart(bridge, white, 44, 0.6, 0.5));
  const funnel = new THREE.CylinderGeometry(6, 7.5, 14, 16); funnel.scale(1, 1, 1.8); funnel.translate(0, 50, L * 0.22);
  parts.push(packPart(funnel, seed % 2 ? red : navy, 0, 0, 0.6));
  for (let i = 0; i < 9; i++) for (const s of [-1, 1]) {
    const lb = new THREE.CapsuleGeometry(1.4, 7, 4, 8); lb.rotateX(Math.PI / 2); lb.translate(s * (B / 2 + 0.6), 14, -L * 0.25 + i * 16);
    parts.push(packPart(lb, yellow, 0, 0, 0.7));
  }
  const dome = new THREE.BoxGeometry(B * 0.6, 4, 40); dome.translate(0, 44.5, L * 0.02);
  parts.push(packPart(dome, glass, 0, 0, 0.8));
  return mergePacked(parts);
}

export function sailboatGeometry() {
  const white = new THREE.Color(0.95, 0.95, 0.94), teak = new THREE.Color(0.55, 0.38, 0.22), navy = new THREE.Color(0.08, 0.14, 0.3), sail = new THREE.Color(0.98, 0.97, 0.94), metal = new THREE.Color(0.7, 0.72, 0.75);
  const parts = [];
  const hull = extrudeY(shipOutline(10.5, 3.3, 3.6), 0, 1.3); parts.push(packPart(hull, white, 0, 0, 0.1));
  const keelBand = extrudeY(shipOutline(10.4, 3.25, 3.6), 0.25, 0.25); keelBand.scale(1.004, 1, 1.004); parts.push(packPart(keelBand, navy, 0, 0, 0.1));
  const deck = extrudeY(shipOutline(10.2, 3.1, 3.5), 1.3, 0.05); parts.push(packPart(deck, teak, 0, 0, 0.1));
  const cabin = new THREE.BoxGeometry(2.2, 0.7, 3.6); cabin.translate(0, 1.65, 0.2); parts.push(packPart(cabin, white, 0, 0, 0.1));
  const mast = new THREE.CylinderGeometry(0.07, 0.09, 14, 6); mast.translate(0, 8.3, -1.0); parts.push(packPart(mast, metal, 0, 0, 0.1));
  const boom = new THREE.CylinderGeometry(0.06, 0.06, 4.2, 6); boom.rotateX(Math.PI / 2); boom.translate(0, 2.7, 1.1); parts.push(packPart(boom, metal, 0, 0, 0.1));
  // mainsail + jib (double-sided triangles)
  const tri = (a, b, c) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...b], 3)); return g; };
  parts.push(packPart(tri([0, 2.8, -0.95], [0, 14.8, -0.95], [0.05, 2.8, 3.1]), sail, 0, 0, 0.1));
  parts.push(packPart(tri([0, 1.5, -5.0], [0, 13.5, -1.05], [0.05, 1.6, -1.4]), sail, 0, 0, 0.1));
  return mergePacked(parts);
}

export function jetskiGeometry() {
  const body = new THREE.Color(0.95, 0.95, 0.96), accent = new THREE.Color(0.12, 0.55, 0.85), seat = new THREE.Color(0.08, 0.08, 0.1), skin = new THREE.Color(0.78, 0.6, 0.48), vest = new THREE.Color(1, 0.45, 0.12);
  const parts = [];
  parts.push(packPart(extrudeY(shipOutline(3.2, 1.15, 1.3), 0, 0.55), body, 0, 0, 0.1));
  parts.push(packPart(extrudeY(shipOutline(3.1, 1.1, 1.3), 0.2, 0.12), accent, 0, 0, 0.1));
  const s = new THREE.BoxGeometry(0.45, 0.18, 1.3); s.translate(0, 0.66, 0.35); parts.push(packPart(s, seat, 0, 0, 0.1));
  const hood = new THREE.BoxGeometry(0.75, 0.3, 0.8); hood.translate(0, 0.6, -0.65); parts.push(packPart(hood, accent, 0, 0, 0.1));
  // rider
  const legs = new THREE.CapsuleGeometry(0.13, 0.6, 3, 6); legs.rotateX(1.1); legs.translate(0, 0.85, 0.1); parts.push(packPart(legs, seat, 0, 0, 0.1));
  const torso = new THREE.CapsuleGeometry(0.2, 0.45, 3, 8); torso.rotateX(-0.35); torso.translate(0, 1.3, 0.2); parts.push(packPart(torso, vest, 0, 0, 0.1));
  const head = new THREE.SphereGeometry(0.13, 8, 6); head.translate(0, 1.78, 0.05); parts.push(packPart(head, skin, 0, 0, 0.1));
  return mergePacked(parts);
}

// --------------------------------------------------------------- Harbor
export class Harbor {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'harbor';
    this.buildCruiseShips();
    this.buildStiltsville();
    this.buildPaddleboarders();
    game.scene.add(this.group);
  }

  buildCruiseShips() {
    const mat = facadeMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05 }));
    const geo = cruiseShipGeometry(0);
    const geo2 = cruiseShipGeometry(1);
    this.ships = [];
    const sites = [-650, -300, 60];
    sites.forEach((x, i) => {
      const edge = (xx) => { for (let z = 1050; z < 2000; z += 4) if (heightAt(xx, z) > 0) return z; return 1500; };
      const e0 = edge(x - 140), e1 = edge(x + 140), ez = edge(x);
      const ang = Math.atan2(e1 - e0, 280);            // quay direction
      const nx = Math.sin(ang), nz = -Math.cos(ang);   // normal toward the water (north)
      const cx = x + nx * 30, cz = ez + nz * 30;
      const m = new THREE.Mesh(i % 2 ? geo2 : geo, mat);
      m.position.set(cx, 0, cz);
      // ship bow (-Z local) along the quay toward +X
      m.rotation.y = -Math.PI / 2 - ang;
      m.castShadow = false; m.receiveShadow = true;
      this.group.add(m);
      this.game.collisions.addBox(cx, cz, 19, 145, Math.PI / 2 + ang, { kind: 'ship', damage: 1.5 });
      this.ships.push(m);
    });
  }

  buildStiltsville() {
    const sites = [];
    for (const [x, z] of [[-900, 3480], [-760, 3560], [-1040, 3380], [-560, 3470], [-860, 3330], [-680, 3700], [-1000, 3620]]) {
      const h = heightAt(x, z);
      if (h < -0.4 && h > -4.0) sites.push({ x, z, r: (x * 0.013 + z * 0.007) % 6.28 });
    }
    this.stilts = sites;
    if (!sites.length) return;
    const shack = this.game.assets.cloneModel('shack', { cloneMaterials: false });
    const parts = bakeModel(shack);
    const mats = sites.map((s) => makeMatrix(s.x, 0.4, s.z, s.r, 0.95 + Math.abs(s.x % 3) * 0.04));
    this.group.add(instanceParts(parts, mats, { name: 'stiltsville' }));
    // landings + pilings
    const deck = [];
    for (const s of sites) {
      const g = new THREE.BoxGeometry(3, 0.25, 9); g.rotateY(s.r); g.translate(s.x + Math.cos(s.r) * 7.5, 0.9, s.z - Math.sin(s.r) * 7.5); deck.push(g);
      this.game.collisions.addCircle(s.x, s.z, 7, { kind: 'stilts', damage: 1.2 });
    }
    const merged = new THREE.Mesh(mergeAllSimple(deck), new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.9 }));
    this.group.add(merged);
  }

  buildPaddleboarders() {
    const spots = [];
    const centres = [[-110, 2700, 120], [900, -1450, 220], [-700, 3350, 200], [1395, -1990, 90], [700, -200, 140]];
    let k = 0;
    for (const [cx, cz, r] of centres) for (let i = 0; i < 3; i++) {
      const a = (k++ * 2.399) % 6.283, d = r * (0.4 + ((k * 0.37) % 0.6));
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (heightAt(x, z) < -0.5) spots.push({ x, z, a: a + 1.3, phase: k, speed: 0.5 + (k % 3) * 0.15, cx, cz, r: d, ang: a });
    }
    this.paddlers = spots;
    const board = new THREE.CapsuleGeometry(0.38, 2.6, 4, 10); board.rotateX(Math.PI / 2); board.scale(1, 0.18, 1);
    this.boards = new THREE.InstancedMesh(board, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }), spots.length);
    this.boards.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3), 3);
    const cols = [0xff8f7a, 0x6fd2d0, 0xffd166, 0xffffff, 0x3fa9f5];
    spots.forEach((s, i) => this.boards.setColorAt(i, new THREE.Color(cols[i % cols.length])));
    this.group.add(this.boards);
    // paddlers use the posed men geometry from People (shared, instanced)
    const ppl = this.game.people;
    this.riders = new THREE.InstancedMesh(ppl.manStand, ppl.manMats, spots.length);
    this.riders.castShadow = true;
    this.group.add(this.riders);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1);
  }

  update(dt, time, waves, night, camPos) {
    if (!this.paddlers) return;
    const m = this._m, q = this._q, e = this._e, p = this._p;
    this.paddlers.forEach((s, i) => {
      s.ang += (s.speed / Math.max(30, s.r)) * dt;
      const x = s.cx + Math.cos(s.ang) * s.r, z = s.cz + Math.sin(s.ang) * s.r;
      const near = Math.abs(x - camPos.x) + Math.abs(z - camPos.z) < 1600;
      const h = near ? waves.heightFast(x, z, time, 0.5) : 0;
      const heading = -s.ang;
      e.set(Math.sin(time * 1.3 + s.phase) * 0.04, heading, Math.sin(time * 1.1 + s.phase) * 0.06, 'YXZ');
      q.setFromEuler(e);
      p.set(x, h + 0.03, z);
      this.boards.setMatrixAt(i, m.compose(p, q, this._s));
      p.y += 0.07;
      e.set(Math.sin(time * 1.7 + s.phase) * 0.05, heading + Math.PI / 2, 0, 'YXZ');
      q.setFromEuler(e);
      this.riders.setMatrixAt(i, m.compose(p, q, this._s));
    });
    this.boards.instanceMatrix.needsUpdate = true;
    this.riders.instanceMatrix.needsUpdate = true;
    void night;
  }
}

function mergeAllSimple(geos) {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), idx = [];
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    for (const i of g.index.array) idx.push(i + o);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}
