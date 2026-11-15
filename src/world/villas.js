// Waterfront villas on real island lots (assets/map/lots.json, derived from the
// Miami model's coastline). The attached villa models are instanced (baked per
// material), mixed with parametric Miami-modern villas (white stucco, glass,
// pastel accent walls, infinity pools that glow at night). Every villa gets a
// dock from the attached Rustic Wooden Dock model and yard palms. Lot 0 is the
// player's HOME BASE: the Modern Luxury Villa with a private dock out back.
import * as THREE from 'three';
import { bakeModel, instanceParts, makeMatrix } from '../assets/assets.js';
import { heightAt } from './geography.js';
import { mergeAll } from './city.js';

const PASTELS = [0xf6c9b8, 0xb9e3df, 0xf7e2a8, 0xd9c8f0, 0xf3b7c6, 0xbfe0f5];

export class Villas {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'villas';
    this.docks = [];        // {x,z,ox,oz,len,deckY, slip}
    this.walkRects = [];    // walkable deck rectangles
    this.blockers = [];     // on-foot collision boxes (house footprints)
    this.palmSpots = [];
    this.pools = [];
    const lots = game.data.lots;
    const A = game.assets;

    // ---------- prepare villa model parts (model space, baked per material)
    const prep = (name, hideFn) => {
      const m = A.cloneModel(name, { cloneMaterials: true });
      m.traverse((o) => { if (o.isMesh && hideFn && hideFn(o)) o.visible = false; });
      m.updateMatrixWorld(true);
      const box = new THREE.Box3();
      m.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
      return { model: m, box, parts: bakeModel(m, { filter: (o) => o.visible }) };
    };
    const modern = prep('villaModern');
    const sea = prep('villaSea', (o) => {
      const c = o.material.color; return c && c.r + c.g + c.b < 0.05 && new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).y < 0.4;
    });
    const small = prep('villaSmall', (o) => {
      const bb = new THREE.Box3().setFromObject(o); return bb.min.y < -3.5 && (bb.max.x - bb.min.x) > 25;
    });
    this.types = { modern, sea, small };

    // dock model parts
    const dockM = A.cloneModel('dock', { cloneMaterials: false });
    dockM.updateMatrixWorld(true);
    const dockBox = new THREE.Box3().setFromObject(dockM);
    this.dockLen = dockBox.max.z - dockBox.min.z;
    this.dockWidth = dockBox.max.x - dockBox.min.x;
    this.dockDeckY = 0.57;
    const dockParts = bakeModel(dockM);
    this.dockParts = dockParts;

    const mats = { modern: [], sea: [], small: [], proc: [] };
    const dockMats = [];
    lots.forEach((lot, i) => {
      const angle = Math.atan2(lot.ox, lot.oz);
      const shoreX = lot.x + lot.ox * 22, shoreZ = lot.z + lot.oz * 22;
      const hx = lot.x - lot.ox * 6, hz = lot.z - lot.oz * 6;
      const g = Math.max(heightAt(hx, hz), 2.2);
      let type;
      if (lot.home) type = 'modern';
      else type = ['sea', 'proc', 'modern', 'small', 'proc', 'sea'][i % 6];
      const t = this.types[type];
      if (t) {
        const yOff = type === 'modern' ? -t.box.min.y - 1.05 : type === 'small' ? -t.box.min.y - (t.box.min.y < -3 ? 5.1 : 0) : -t.box.min.y;
        const c = t.box.getCenter(new THREE.Vector3());
        const m = new THREE.Matrix4().makeRotationY(angle);
        m.multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z));
        m.premultiply(new THREE.Matrix4().makeTranslation(hx, g + yOff + (type === 'small' ? 0 : 0), hz));
        mats[type].push(m);
        const size = t.box.getSize(new THREE.Vector3());
        this.blockers.push({ x: hx, z: hz, hx: size.x * 0.32, hz: size.z * 0.32, angle: -angle });
      } else {
        mats.proc.push({ x: hx, z: hz, y: g, angle, seed: i });
        this.blockers.push({ x: hx, z: hz, hx: 9, hz: 7, angle: -angle });
      }
      // private dock straight out from the seawall
      const dockLen = lot.home ? 26 : 18 + (i % 3) * 4;
      const sl = dockLen / this.dockLen;
      const dx = shoreX + lot.ox * dockLen / 2, dz = shoreZ + lot.oz * dockLen / 2;
      const dm = new THREE.Matrix4().compose(new THREE.Vector3(dx, 0.75, dz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle), new THREE.Vector3(0.55, 1, sl));
      dockMats.push(dm);
      const deckY = 0.75 + this.dockDeckY;
      const dock = { x: dx, z: dz, ox: lot.ox, oz: lot.oz, len: dockLen, width: this.dockWidth * 0.55, deckY, home: !!lot.home, lot };
      this.docks.push(dock);
      this.walkRects.push({ x: dx, z: dz, hx: dock.width / 2, hz: dockLen / 2 + 2, angle: -angle, y: deckY });
      // dock pilings as collision
      game.collisions.addBox(dx, dz, dock.width / 2, dockLen / 2, -angle, { kind: 'dock', yMax: deckY, damage: 0.8 });
      // berth alongside (starboard side of the dock looking out)
      const side = 1;
      const px = -lot.oz * side, pz = lot.ox * side;
      dock.berth = { x: dx + px * (dock.width / 2 + 2.6), z: dz + pz * (dock.width / 2 + 2.6), heading: Math.atan2(lot.ox, -lot.oz), type: 'side', len: dockLen, width: 5.4, deckY, cleatX: dx + px * dock.width / 2, cleatZ: dz + pz * dock.width / 2 };
      // palms in the yard
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + i;
        this.palmSpots.push({ x: lot.x + Math.cos(a) * 14 + lot.ox * 6, z: lot.z + Math.sin(a) * 14 + lot.oz * 6 });
      }
      if (lot.home) {
        this.home = { lot, house: { x: hx, z: hz, y: g }, dock, angle, yard: { x: lot.x + lot.ox * 10, z: lot.z + lot.oz * 10, y: Math.max(heightAt(lot.x + lot.ox * 10, lot.z + lot.oz * 10), 2.4) } };
      }
    });

    for (const k of ['modern', 'sea', 'small']) {
      if (!mats[k].length) continue;
      const inst = instanceParts(this.types[k].parts, mats[k], { name: 'villa-' + k });
      this.group.add(inst);
    }
    this.group.add(instanceParts(dockParts, dockMats, { name: 'villa-docks' }));
    this.buildProcedural(mats.proc);
    game.scene.add(this.group);
  }

  // Parametric Miami-modern villas: stacked white boxes, glass walls, pastel
  // accent wall, roof overhang, pool with glowing water at night.
  buildProcedural(list) {
    if (!list.length) return;
    const white = [], glass = [], accent = [], pool = [];
    const box = (arr, w, h, d, x, y, z, m) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); g.applyMatrix4(m); arr.push(g); };
    const accentCols = [];
    for (const v of list) {
      const r = (k) => { const x = Math.sin(v.seed * 37.1 + k * 11.7) * 43758.5; return x - Math.floor(x); };
      const m = new THREE.Matrix4().makeRotationY(v.angle).premultiply(new THREE.Matrix4().makeTranslation(v.x, v.y, v.z));
      const W = 14 + r(1) * 8, D = 10 + r(2) * 5, H1 = 3.6, H2 = 3.4;
      box(white, W, 0.5, D + 3, 0, 0.25, 0, m);                        // plinth
      box(white, W, H1, D, 0, 0.5 + H1 / 2, -1, m);                    // ground floor
      box(glass, W * 0.85, H1 - 0.6, 0.15, 0, 0.5 + H1 / 2, -1 + D / 2 + 0.05, m);
      box(white, W * 0.7, H2, D * 0.85, -W * 0.12, 0.5 + H1 + H2 / 2, -1.5, m); // upper floor
      box(glass, W * 0.6, H2 - 0.5, 0.15, -W * 0.12, 0.5 + H1 + H2 / 2, -1.5 + D * 0.425 + 0.05, m);
      box(white, W * 0.8, 0.3, D * 0.95 + 1.5, -W * 0.08, 0.5 + H1 + H2 + 0.15, -1, m); // roof slab overhang
      box(accent, 0.6, H1 + H2, D * 0.6, W / 2 - 0.3, 0.5 + (H1 + H2) / 2, -1.5, m);
      accentCols.push(PASTELS[(r(3) * PASTELS.length) | 0]);
      box(pool, W * 0.6, 0.12, 4, 0, 0.45, D / 2 + 3.2, m);
      this.pools.push(new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().makeTranslation(0, 0.5, D / 2 + 3.2).premultiply(m)));
    }
    const mk = (arr, mat) => { const mesh = new THREE.Mesh(mergeAll(arr), mat); mesh.castShadow = true; mesh.receiveShadow = true; this.group.add(mesh); return mesh; };
    mk(white, new THREE.MeshStandardMaterial({ color: 0xf5f3ee, roughness: 0.75 }));
    mk(glass, new THREE.MeshStandardMaterial({ color: 0x223844, roughness: 0.05, metalness: 0.8, emissive: 0xffc88a, emissiveIntensity: 0 })).name = 'villaGlass';
    // accent walls: per-villa pastel via vertex colours
    const acc = mergeAll(accent);
    const cols = new Float32Array(acc.attributes.position.count * 3);
    const per = acc.attributes.position.count / accentCols.length;
    const c = new THREE.Color();
    for (let i = 0; i < acc.attributes.position.count; i++) { c.set(accentCols[Math.floor(i / per)]); cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; }
    acc.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const accMesh = new THREE.Mesh(acc, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    accMesh.castShadow = true;
    this.group.add(accMesh);
    this.poolMat = new THREE.MeshStandardMaterial({ color: 0x3fd0e0, roughness: 0.05, metalness: 0.1, emissive: 0x2fe6ff, emissiveIntensity: 0 });
    mk(pool, this.poolMat);
    this.glassMat = this.group.getObjectByName('villaGlass').material;
  }

  update(night) {
    if (this.poolMat) this.poolMat.emissiveIntensity = night * 2.2;
    if (this.glassMat) this.glassMat.emissiveIntensity = night * 0.9;
  }
}
