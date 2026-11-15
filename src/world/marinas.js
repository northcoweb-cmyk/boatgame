// Marinas and destination docks: finger piers with slips, T-heads, fuel docks,
// pilings with white caps, cleats, dock lights, colliders, walkable decks and a
// berth registry used by the docking system. Moored boats bob on the real waves.
import * as THREE from 'three';
import { MARINAS, heightAt } from './geography.js';
import { bakeToVertexColor, makeMatrix, addHullMask } from '../assets/assets.js';
import { mergeAll } from './city.js';

function plankTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  for (let i = 0; i < 16; i++) {
    const l = 52 + Math.random() * 14;
    g.fillStyle = `hsl(${28 + Math.random() * 8}, ${32 + Math.random() * 10}%, ${l}%)`;
    g.fillRect(0, i * 16, 256, 15);
    g.fillStyle = 'rgba(40,25,10,0.5)';
    g.fillRect(0, i * 16 + 15, 256, 1);
    for (let k = 0; k < 30; k++) { g.fillStyle = `rgba(60,40,20,${Math.random() * 0.12})`; g.fillRect(Math.random() * 256, i * 16 + Math.random() * 14, 20 + Math.random() * 60, 1); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export class Docks {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'docks';
    this.berths = [];
    this.walkRects = [];
    this.fuelDocks = [];
    this.moored = [];
    this.npcSpots = [];
    this.deck = [];
    this.pileMats = [];
    this.lampPts = [];
    this.plankMat = new THREE.MeshStandardMaterial({ map: plankTexture(), roughness: 0.85 });
    this.pileMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.9 });
    this.capMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    for (const m of MARINAS) this.buildMarina(m);
  }

  // A deck box in a local frame (u along shore, v outward) of origin o.
  addDeck(o, u0, u1, v0, v1, deckY, opts = {}) {
    const cx = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const x = o.x + o.along[0] * cx + o.out[0] * cv, z = o.z + o.along[1] * cx + o.out[1] * cv;
    const lu = Math.abs(u1 - u0), lv = Math.abs(v1 - v0);
    const angle = Math.atan2(o.out[0], o.out[1]);
    const g = new THREE.BoxGeometry(lu, 0.35, lv);
    // plank UVs scale with size
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * lu / 3, uv.getY(i) * lv / 3);
    g.rotateY(angle);
    g.translate(x, deckY - 0.17, z);
    this.deck.push(g);
    this.walkRects.push({ x, z, hx: lu / 2, hz: lv / 2, angle: -angle, y: deckY });
    if (!opts.noCollide) this.game.collisions.addBox(x, z, lu / 2, lv / 2, -angle, { kind: 'dock', yMax: deckY + 0.3, damage: 0.9 });
    // pilings along the long edges
    const along = lu > lv;
    const L = along ? lu : lv, n = Math.max(2, Math.round(L / 6) + 1);
    for (let i = 0; i < n; i++) {
      const t = -0.5 + i / (n - 1);
      for (const s of [-0.5, 0.5]) {
        const pu = along ? cx + t * lu : u0 + (s + 0.5) * lu;
        const pv = along ? v0 + (s + 0.5) * lv : cv + t * lv;
        const px = o.x + o.along[0] * pu + o.out[0] * pv, pz = o.z + o.along[1] * pu + o.out[1] * pv;
        this.pileMats.push(makeMatrix(px, -2, pz));
        if (Math.random() < 0.25) this.lampPts.push(new THREE.Vector3(px, deckY + 1.6, pz));
      }
    }
    return { x, z, angle };
  }

  addBerth(b) { b.occupied = null; this.berths.push(b); return b; }

  buildMarina(m) {
    const deckY = 1.05;
    const o = { x: m.x, z: m.z, along: m.along, out: m.out };
    const hw = m.width / 2;
    // main walkway parallel to the bulkhead + gangway
    this.addDeck(o, -hw, hw, 3, 6.5, deckY);
    this.addDeck(o, -2, 2, -1, 3.2, deckY + 0.6, { noCollide: true });
    // finger piers with slips between them
    const fingerLen = 15, spacing = 7.5;
    const fingers = [];
    for (let u = -hw + 6; u <= hw - 26; u += spacing) fingers.push(u);
    for (const u of fingers) this.addDeck(o, u - 0.75, u + 0.75, 6.5, 6.5 + fingerLen, deckY);
    for (let i = 0; i < fingers.length - 1; i++) {
      const u = (fingers[i] + fingers[i + 1]) / 2, v = 6.5 + fingerLen / 2 + 0.5;
      this.addBerth({ marina: m.id, x: m.x + m.along[0] * u + m.out[0] * v, z: m.z + m.along[1] * u + m.out[1] * v,
        heading: Math.atan2(-m.out[0], m.out[1]), type: 'bow', len: fingerLen + 1, width: spacing - 1.6, deckY,
        cleatX: m.x + m.along[0] * fingers[i] + m.out[0] * (v + 4), cleatZ: m.z + m.along[1] * fingers[i] + m.out[1] * (v + 4) });
    }
    // T-head for the big boats (stern-to / side-tie on the outside)
    const tV = 6.5 + fingerLen + 18;
    this.addDeck(o, hw - 24, hw - 21, 6.5, tV, deckY);
    this.addDeck(o, hw - 52, hw - 2, tV, tV + 3, deckY);
    this.addBerth({ marina: m.id, x: m.x + m.along[0] * (hw - 27) + m.out[0] * (tV + 7.5), z: m.z + m.along[1] * (hw - 27) + m.out[1] * (tV + 7.5),
      heading: Math.atan2(m.along[0], -m.along[1]), type: 'side', len: 22, width: 6, deckY, cleatX: m.x + m.along[0] * (hw - 27) + m.out[0] * (tV + 3), cleatZ: m.z + m.along[1] * (hw - 27) + m.out[1] * (tV + 3) });
    // fuel dock at the far end: side-tie, repairs + fuel
    const fu = -hw - 4;
    this.addDeck(o, fu - 22, fu, 9, 12, deckY);
    this.addDeck(o, fu - 2, fu + 6, 3, 9, deckY);
    const fuel = this.addBerth({ marina: m.id, fuel: true, x: m.x + m.along[0] * (fu - 11) + m.out[0] * 15.5, z: m.z + m.along[1] * (fu - 11) + m.out[1] * 15.5,
      heading: Math.atan2(m.along[0], -m.along[1]), type: 'side', len: 22, width: 6, deckY, cleatX: m.x + m.along[0] * (fu - 11) + m.out[0] * 12, cleatZ: m.z + m.along[1] * (fu - 11) + m.out[1] * 12 });
    this.fuelDocks.push(fuel);
    // fuel pump + sign
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.4, 0.6), new THREE.MeshStandardMaterial({ color: 0x1d6fb8, roughness: 0.5 }));
    pump.position.set(m.x + m.along[0] * (fu - 11) + m.out[0] * 11, deckY + 0.7, m.z + m.along[1] * (fu - 11) + m.out[1] * 11);
    this.group.add(pump);
    const sign = makeSign('FUEL · REPAIR', '#ffd166');
    sign.position.set(pump.position.x, deckY + 2.6, pump.position.z);
    sign.rotation.y = Math.atan2(m.out[0], m.out[1]);
    this.group.add(sign);
    // marina name board on the bulkhead
    const board = makeSign(m.name.toUpperCase(), '#ffffff', 8);
    board.position.set(m.x - m.out[0] * 1, 5.2, m.z - m.out[1] * 1);
    board.rotation.y = Math.atan2(m.out[0], m.out[1]);
    this.group.add(board);
    for (let k = 0; k < 6; k++) this.npcSpots.push({ x: m.x + m.along[0] * (-hw + k * m.width / 6) + m.out[0] * 4.7, z: m.z + m.along[1] * (-hw + k * m.width / 6) + m.out[1] * 4.7, y: deckY, face: Math.atan2(m.out[0], m.out[1]) });
  }

  // generic jetty for destinations: from shore point along direction (dx,dz)
  addJetty(x, z, dx, dz, len, width, deckY, berthSide = 1, type = 'side', name = 'jetty') {
    const out = [dx, dz], along = [-dz, dx];
    const o = { x, z, along, out };
    this.addDeck(o, -width / 2, width / 2, 0, len, deckY);
    const v = len * 0.6;
    const bx = x + out[0] * v + along[0] * berthSide * (width / 2 + 3), bz = z + out[1] * v + along[1] * berthSide * (width / 2 + 3);
    return this.addBerth({ marina: name, x: bx, z: bz, heading: Math.atan2(out[0], -out[1]), type, len: len * 0.8, width: 6, deckY,
      cleatX: x + out[0] * v + along[0] * berthSide * width / 2, cleatZ: z + out[1] * v + along[1] * berthSide * width / 2 });
  }

  finalize() {
    const deckMesh = new THREE.Mesh(mergeAll(this.deck.map((g) => { g.deleteAttribute('uv'); return g; })), this.plankMat);
    // regenerate uv-less merge loses plank uvs; use world-space triplanar-ish UVs instead
    const pos = deckMesh.geometry.attributes.position, nor = deckMesh.geometry.attributes.normal;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i));
      if (ay > 0.5) { uv[i * 2] = pos.getX(i) / 3; uv[i * 2 + 1] = pos.getZ(i) / 3; }
      else if (ax > 0.5) { uv[i * 2] = pos.getZ(i) / 3; uv[i * 2 + 1] = pos.getY(i) / 3; }
      else { uv[i * 2] = pos.getX(i) / 3; uv[i * 2 + 1] = pos.getY(i) / 3; }
    }
    deckMesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    deckMesh.castShadow = true; deckMesh.receiveShadow = true;
    this.group.add(deckMesh);
    const pile = new THREE.CylinderGeometry(0.16, 0.18, 4.6, 8); pile.translate(0, 2.3, 0);
    const piles = new THREE.InstancedMesh(pile, this.pileMat, this.pileMats.length);
    const cap = new THREE.CylinderGeometry(0.2, 0.2, 0.18, 8); cap.translate(0, 4.65, 0);
    const caps = new THREE.InstancedMesh(cap, this.capMat, this.pileMats.length);
    this.pileMats.forEach((m, i) => { piles.setMatrixAt(i, m); caps.setMatrixAt(i, m); });
    piles.castShadow = true;
    this.group.add(piles, caps);
    // dock lights (low bollards) — emissive at night
    const lampGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.5, 8);
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
    const lamps = new THREE.InstancedMesh(lampGeo, this.lampMat, Math.max(1, this.lampPts.length));
    this.lampPts.forEach((p, i) => lamps.setMatrixAt(i, makeMatrix(p.x, p.y - 1.2, p.z)));
    this.group.add(lamps);
    this.game.scene.add(this.group);
  }

  // Moored boats (baked, instanced) in free berths; they bob on the waves.
  populateMoored(models, avoid, extra = []) {
    const types = models.map((m) => bakeToVertexColor(m));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35 });
    const counts = types.map(() => 0);
    const picks = [];
    let k = 0;
    for (const b of [...this.berths, ...extra]) {
      if (b.fuel || avoid.has(b)) continue;
      if (!b.villa && (k++ % 3) === 2) continue; // leave room for the player
      if (b.villa && (k++ % 4) === 3) continue;
      const t = b.len > 18 ? 2 : (k % 2);
      picks.push({ b, t });
      b.occupied = 'moored';
    }
    this.mooredMeshes = types.map((g, i) => {
      const n = picks.filter((p) => p.t === i).length;
      const im = new THREE.InstancedMesh(g, mat, Math.max(1, n));
      im.count = n;
      im.castShadow = true;
      this.group.add(im);
      addHullMask(im);
      return im;
    });
    for (const p of picks) {
      const g = types[p.t];
      const len = g.boundingBox.max.z - g.boundingBox.min.z;
      const idx = counts[p.t]++;
      this.moored.push({ mesh: this.mooredMeshes[p.t], idx, x: p.b.x, z: p.b.z, heading: p.b.heading, len, phase: Math.random() * 10 });
      this.game.collisions.addBox(p.b.x, p.b.z, 1.3, len / 2, p.b.heading, { kind: 'boat', damage: 1.1, bouncy: 0.15 });
    }
  }

  update(dt, time, waves, night) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    for (const b of this.moored) {
      const h = waves.heightFast(b.x, b.z, time, 0.6);
      e.set(Math.sin(time * 0.9 + b.phase) * 0.02, -b.heading, Math.sin(time * 1.1 + b.phase) * 0.03, 'YXZ');
      q.setFromEuler(e);
      p.set(b.x, h - 0.35, b.z);
      m.compose(p, q, s);
      b.mesh.setMatrixAt(b.idx, m);
    }
    if (this.mooredMeshes) for (const mm of this.mooredMeshes) mm.instanceMatrix.needsUpdate = true;
    if (this.lampMat) this.lampMat.color.setRGB(1, 0.85, 0.6).multiplyScalar(0.2 + night * 5);
    void dt;
  }
}

export function makeSign(text, color = '#ffffff', width = 4) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(12,28,44,0.92)';
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = color; g.lineWidth = 6; g.strokeRect(6, 6, 500, 116);
  g.fillStyle = color;
  g.font = '600 52px "Avenir Next", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.15, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), mat);
  mesh.userData.signMat = mat;
  return mesh;
}

export { heightAt };
