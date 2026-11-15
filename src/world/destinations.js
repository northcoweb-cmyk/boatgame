// The little places we go: Flamingo Beach Club, Pelican's Tiki Bar (the stilt
// shack model over the water), Watson Island Grill (stern-to quay, string
// lights), Cape Light lighthouse (rotating beam), and the Venetian Sandbar
// (anchored boats, floating toys, people wading). Each has a dock or beaching
// spot, an ambient music emitter, and NPC spots for posed people.
import * as THREE from 'three';
import { heightAt, ISLANDS, SANDBARS, DESTINATIONS } from './geography.js';
import { bakeModel, bakeToVertexColor, instanceParts, makeMatrix } from '../assets/assets.js';
import { mergeAll } from './city.js';
import { makeSign } from './marinas.js';
import { LAYER_NO_REFLECT } from '../render/reflection.js';

const UMBRELLA_COLS = [0xff8f7a, 0x6fd2d0, 0xffd166, 0xffffff, 0xff9a3c];

// Separate the beach pack into named props, each baked at its own origin.
function splitBeachPack(pack) {
  pack.updateMatrixWorld(true);
  const out = {};
  pack.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.name.split('_')[0].replace(/[0-9]+$/, (d) => d);
    const bb = new THREE.Box3().setFromObject(o);
    const c = bb.getCenter(new THREE.Vector3());
    const m = o.clone();
    m.applyMatrix4(o.parent.matrixWorld);
    const holder = new THREE.Group();
    holder.add(m);
    m.position.x -= c.x; m.position.z -= c.z; m.position.y -= bb.min.y;
    holder.updateMatrixWorld(true);
    out[key] = { parts: bakeModel(holder, { mergeUntextured: true }), size: bb.getSize(new THREE.Vector3()) };
  });
  return out;
}

function shorePoint(cx, cz, dx, dz, maxR = 600) {
  for (let r = 0; r < maxR; r += 2) if (heightAt(cx + dx * r, cz + dz * r) < -0.6) return { x: cx + dx * r, z: cz + dz * r, r };
  return { x: cx + dx * maxR, z: cz + dz * maxR, r: maxR };
}

export class Destinations {
  constructor(game, docks) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'destinations';
    this.music = [];      // { x, z, r, station }
    this.npc = { stand: [], seated: [], wade: [], walkers: [] };
    this.torches = [];
    this.anchoredBoats = [];
    this.floaters = [];
    const pack = splitBeachPack(game.assets.models.beachPack);
    this.pack = pack;
    const inst = {};
    const put = (name, x, y, z, rot = 0, s = 1) => { (inst[name] ||= []).push(makeMatrix(x, y, z, rot, s)); };

    // ------------------------------------------------ Flamingo Beach Club
    const fk = ISLANDS.find((i) => i.beachClub);
    const shore = shorePoint(fk.x, fk.z, 1, 0);
    const beachX = shore.x - 26;
    for (let row = 0; row < 3; row++) for (let k = 0; k < 7; k++) {
      const z = fk.z - 48 + k * 16, x = beachX - row * 9;
      const y = Math.max(heightAt(x, z), 0.2);
      put('Umbrella1', x, y, z, k, 1.25);
      put('SunLounger1', x + 1.8, y, z + 1.4, Math.PI / 2, 1.1);
      put('SunLounger2', x + 1.8, y, z - 1.4, Math.PI / 2, 1.1);
      if ((k + row) % 3 === 0) { put('Towel', x + 3.6, y + 0.02, z, 0.3); put('Table', x + 0.5, y, z + 2.8); put('Cocktail', x + 0.5, y + 0.75, z + 2.8); }
      if (k % 2 === 0) this.npc.seated.push({ x: x + 3.3, y: y + 0.05, z: z + (row - 1) * 0.6, face: Math.PI / 2 + (k % 3) * 0.4 });
    }
    // white daybeds with cushions
    const dayParts = [];
    for (let k = 0; k < 6; k++) {
      const z = fk.z - 40 + k * 16, x = beachX - 30, y = Math.max(heightAt(x, z), 0.4);
      const g = new THREE.BoxGeometry(2.2, 0.45, 2.6); g.translate(x, y + 0.22, z); dayParts.push(g);
      const c = new THREE.BoxGeometry(2.0, 0.18, 2.4); c.translate(x, y + 0.53, z); dayParts.push(c);
      for (const s of [-1, 1]) { const p = new THREE.BoxGeometry(0.08, 2.4, 0.08); p.translate(x + s * 1.05, y + 1.4, z - 1.25); dayParts.push(p); }
      const canopy = new THREE.BoxGeometry(2.3, 0.05, 2.7); canopy.translate(x, y + 2.6, z); dayParts.push(canopy);
      this.npc.stand.push({ x: x + 2.0, y, z: z + 1, face: Math.PI / 2 + k });
    }
    const day = new THREE.Mesh(mergeAll(dayParts), new THREE.MeshStandardMaterial({ color: 0xfbf8f2, roughness: 0.9 }));
    day.castShadow = true; day.receiveShadow = true;
    this.group.add(day);
    // club bar hut + sign
    const hut = this.makeHut(beachX - 52, Math.max(heightAt(beachX - 52, fk.z), 1), fk.z, 9, 7);
    this.group.add(hut);
    const cs = makeSign('FLAMINGO BEACH CLUB', '#ff8f7a', 9);
    cs.position.set(beachX - 47.4, Math.max(heightAt(beachX - 52, fk.z), 1) + 4.6, fk.z);
    cs.rotation.y = Math.PI / 2;
    this.group.add(cs);
    const clubBerth = docks.addJetty(shore.x - 4, fk.z + 30, 1, 0, 34, 2.6, 1.15, 1, 'side', 'beachclub');
    clubBerth.dest = 'beachclub';
    this.music.push({ x: beachX - 20, z: fk.z, r: 220, station: 'house', id: 'beachclub' });
    for (let k = 0; k < 5; k++) this.npc.wade.push({ x: shore.x + 6 + k * 3, z: fk.z - 20 + k * 9, face: -Math.PI / 2 });
    for (let k = 0; k < 4; k++) this.npc.walkers.push({ path: [[beachX - 14, fk.z - 60], [beachX - 14, fk.z + 60]], phase: k / 4 });

    // ------------------------------------------------ Pelican's Tiki Bar (stilt shack)
    const tk = DESTINATIONS.find((d) => d.id === 'tiki');
    const shack = game.assets.cloneModel('shack', { cloneMaterials: false });
    shack.position.set(tk.x, 0.4, tk.z);
    shack.rotation.y = -0.6;
    shack.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(shack);
    game.collisions.addBox(tk.x, tk.z, 6, 6, 0.6, { kind: 'stilts', damage: 1 });
    docks.addDeck({ x: tk.x, z: tk.z, along: [1, 0], out: [0, 1] }, -10, 10, 5, 9, 1.3);
    const tikiBerth = docks.addBerth({ marina: 'tiki', dest: 'tiki', x: tk.x, z: tk.z + 13, heading: Math.PI / 2, type: 'side', len: 18, width: 6, deckY: 1.3, cleatX: tk.x, cleatZ: tk.z + 9 });
    void tikiBerth;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      this.torches.push(new THREE.Vector3(tk.x + Math.cos(a) * 10.5, 3.1, tk.z + Math.sin(a) * 10.5 * 0.9 + 2));
    }
    const tsign = makeSign("PELICAN'S TIKI BAR", '#ffd166', 7);
    tsign.position.set(tk.x, 8.2, tk.z + 5.2);
    this.group.add(tsign);
    this.music.push({ x: tk.x, z: tk.z, r: 200, station: 'tiki', id: 'tiki' });
    for (let k = 0; k < 6; k++) this.npc.stand.push({ x: tk.x - 7 + k * 2.6, y: 1.3, z: tk.z + 6.6, face: k * 0.8 });

    // ------------------------------------------------ Watson Island Grill
    const rs = DESTINATIONS.find((d) => d.id === 'restaurant');
    const ry = 2.45;
    const rest = this.makeRestaurant(rs.x, ry, rs.z + 30);
    this.group.add(rest);
    // stern-to quay along the bulkhead
    docks.addDeck({ x: -1100, z: 46, along: [1, 0], out: [0, -1] }, -40, 40, 0, 4, 1.4);
    for (let k = 0; k < 3; k++) {
      docks.addBerth({ marina: 'restaurant', dest: 'restaurant', x: -1130 + k * 30, z: 46 - 4 - 7, heading: 0, type: 'stern', len: 14, width: 7, deckY: 1.4, cleatX: -1130 + k * 30, cleatZ: 42 });
    }
    const rsign = makeSign('WATSON ISLAND GRILL', '#ffffff', 9);
    rsign.position.set(rs.x, ry + 6.2, rs.z + 18.5);
    rsign.rotation.y = Math.PI;
    this.group.add(rsign);
    this.music.push({ x: rs.x, z: rs.z + 20, r: 180, station: 'lounge', id: 'restaurant' });
    for (let k = 0; k < 10; k++) this.npc.stand.push({ x: rs.x - 18 + k * 4, y: ry, z: rs.z + 12 + (k % 2) * 2.5, face: Math.PI + (k % 3) * 0.5 });

    // ------------------------------------------------ Cape Light lighthouse
    const lk = ISLANDS.find((i) => i.lighthouse);
    const lx = lk.x + 70, lz = lk.z - 30, lyB = heightAt(lx, lz);
    this.lighthouse = this.makeLighthouse(lx, lyB, lz);
    this.group.add(this.lighthouse.group);
    const ls = shorePoint(lk.x, lk.z, 0, 1);
    const lhBerth = docks.addJetty(ls.x - 20, ls.z - 4, 0, 1, 26, 2.4, 1.2, -1, 'side', 'lighthouse');
    lhBerth.dest = 'lighthouse';

    // ------------------------------------------------ Venetian Sandbar
    const sb = SANDBARS[0];
    const boatModels = [game.assets.models.runabout, game.assets.models.yacht, game.assets.models.towboat];
    const types = [bakeToVertexColor(boatModels[0]), bakeToVertexColor(boatModels[1])];
    const bmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35 });
    this.sandbarBoats = types.map((g) => { const m = new THREE.InstancedMesh(g, bmat, 6); m.count = 0; m.castShadow = true; this.group.add(m); return m; });
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const x = sb.x + Math.cos(a) * sb.a * 0.65 * 0.9, z = sb.z + Math.sin(a) * sb.b * 0.9;
      const t = k % 3 === 0 ? 1 : 0;
      const mesh = this.sandbarBoats[t];
      const idx = mesh.count++;
      const heading = a + Math.PI / 2 + (k % 2) * 0.4;
      this.anchoredBoats.push({ mesh, idx, x, z, heading, phase: k });
      game.collisions.addBox(x, z, 1.3, t ? 5.6 : 3.2, heading, { kind: 'boat', damage: 1.1 });
      this.npc.wade.push({ x: x + Math.cos(a) * 4, z: z + Math.sin(a) * 4, face: a + Math.PI });
      if (k % 2 === 0) this.npc.wade.push({ x: x + Math.cos(a + 0.5) * 6, z: z + Math.sin(a + 0.5) * 6, face: a });
    }
    for (let k = 0; k < 10; k++) {
      const x = sb.x + (Math.random() - 0.5) * sb.a, z = sb.z + (Math.random() - 0.5) * sb.b * 0.8;
      this.floaters.push({ kind: k % 2 ? 'SwimmingRing' : 'Ball', x, z, vx: 0, vz: 0, phase: k });
    }
    for (let k = 0; k < 6; k++) {
      const x = sb.x - sb.a * 0.2 + k * 25, z = sb.z + 10 - k * 6;
      put('Umbrella2', x, Math.max(heightAt(x, z), -0.3), z, k, 1.2);
    }
    this.music.push({ x: sb.x, z: sb.z, r: 300, station: 'sandbar', id: 'sandbar' });

    // ------------------------------------------------ instanced beach-pack props
    this.floaterMeshes = {};
    for (const name of Object.keys(inst)) {
      const p = pack[name];
      if (!p) continue;
      const g = instanceParts(p.parts, inst[name], { name: 'prop-' + name });
      this.group.add(g);
    }
    for (const name of ['SwimmingRing', 'Ball']) {
      const p = pack[name];
      if (!p) continue;
      const list = this.floaters.filter((f) => f.kind === name);
      const g = instanceParts(p.parts, list.map(() => new THREE.Matrix4()), { name: 'float-' + name });
      g.children.forEach((c) => { c.instanceMatrix.setUsage(THREE.DynamicDrawUsage); });
      this.floaterMeshes[name] = { group: g, list };
      this.group.add(g);
    }

    // tiki torches (flames) — emissive flickering sprites
    const flameGeo = new THREE.ConeGeometry(0.16, 0.5, 6);
    this.flameMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.9, depthWrite: false });
    this.flames = new THREE.InstancedMesh(flameGeo, this.flameMat, this.torches.length);
    this.flames.layers.enable(LAYER_NO_REFLECT);
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 2.4, 6);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x5a3d22 }), this.torches.length);
    this.torches.forEach((p, i) => { poles.setMatrixAt(i, makeMatrix(p.x, p.y - 1.4, p.z)); this.flames.setMatrixAt(i, makeMatrix(p.x, p.y, p.z)); });
    this.group.add(poles, this.flames);

    game.scene.add(this.group);
  }

  makeHut(x, y, z, w, d) {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x9a6b42, roughness: 0.9 });
    const thatch = new THREE.MeshStandardMaterial({ color: 0xc9a86a, roughness: 1 });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, 1.1, 1.0), wood);
    bar.position.set(x + d * 0.3, y + 0.55, z);
    bar.rotation.y = Math.PI / 2;
    g.add(bar);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 3.2, 6), wood);
      p.position.set(x + sx * d / 2, y + 1.6, z + sz * w / 2);
      g.add(p);
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, 2.2, 4), thatch);
    roof.position.set(x, y + 4.2, z);
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
  }

  makeRestaurant(x, y, z) {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xf6f4ef, roughness: 0.7 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1f3442, roughness: 0.05, metalness: 0.7, emissive: 0xffc48a, emissiveIntensity: 0 });
    this.restGlass = glass;
    const base = new THREE.Mesh(new THREE.BoxGeometry(46, 0.5, 30), white); base.position.set(x, y + 0.25, z); g.add(base);
    const hall = new THREE.Mesh(new THREE.BoxGeometry(30, 5, 14), white); hall.position.set(x, y + 3, z + 6); g.add(hall);
    const front = new THREE.Mesh(new THREE.BoxGeometry(28, 4, 0.2), glass); front.position.set(x, y + 2.8, z - 1.1); g.add(front);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(40, 0.35, 26), white); roof.position.set(x, y + 5.7, z + 2); g.add(roof);
    // terrace tables
    const tableGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.75, 10); tableGeo.translate(0, 0.38, 0);
    const tables = new THREE.InstancedMesh(tableGeo, new THREE.MeshStandardMaterial({ color: 0xe9e2d6 }), 18);
    for (let i = 0; i < 18; i++) tables.setMatrixAt(i, makeMatrix(x - 18 + (i % 9) * 4.5, y + 0.5, z - 8 - Math.floor(i / 9) * 4));
    g.add(tables);
    // string lights between poles over the terrace
    const bulbs = [];
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const bx = x - 22 + t * 44, bz = z - 6 - row * 4;
        const by = y + 3.6 - Math.sin(t * Math.PI * 4) * 0.25 - 0.6 * Math.sin(t * Math.PI);
        bulbs.push(makeMatrix(bx, by, bz));
      }
    }
    this.bulbMat = new THREE.MeshBasicMaterial({ color: 0x332211 });
    const bulbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 6, 4), this.bulbMat, bulbs.length);
    bulbs.forEach((m, i) => bulbMesh.setMatrixAt(i, m));
    bulbMesh.layers.enable(LAYER_NO_REFLECT);
    g.add(bulbMesh);
    g.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
  }

  makeLighthouse(x, y, z) {
    // the attached low-poly lighthouse model, with a working lamp + beam
    const group = new THREE.Group();
    const tower = this.game.assets.cloneModel('lighthouse', { cloneMaterials: true });
    tower.position.set(x, y - 0.4, z);
    tower.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(tower);
    const H = 36 * (49.5 - 1.2) / 55.9 - 1.7; // lantern room centre in the model
    const lanternMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff1c4, emissiveIntensity: 0.2, transparent: true, opacity: 0.8 });
    const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 2.8, 16), lanternMat);
    lantern.position.set(x, y + H + 1.7, z);
    group.add(lantern);
    // rotating beam: two additive cones
    const beamGeo = new THREE.ConeGeometry(14, 260, 24, 1, true);
    beamGeo.translate(0, -130, 0);
    beamGeo.rotateZ(Math.PI / 2);
    const beamMat = new THREE.ShaderMaterial({
      uniforms: { uI: { value: 0 } },
      vertexShader: 'varying float vX; void main(){ vX = position.x; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader: 'uniform float uI; varying float vX; void main(){ float f = exp(-vX*0.012); gl_FragColor = vec4(vec3(1.0,0.95,0.8)*f*uI, f*uI); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const beam = new THREE.Group();
    beam.position.set(x, y + H + 1.7, z);
    const b1 = new THREE.Mesh(beamGeo, beamMat), b2 = new THREE.Mesh(beamGeo, beamMat);
    b2.rotation.y = Math.PI;
    beam.add(b1, b2);
    beam.layers.set(LAYER_NO_REFLECT);
    b1.layers.set(LAYER_NO_REFLECT); b2.layers.set(LAYER_NO_REFLECT);
    group.add(beam);
    this.game.collisions.addCircle(x, z, 3.5, { kind: 'rock' });
    return { group, beam, beamMat, lanternMat };
  }

  update(dt, time, waves, night) {
    // lighthouse
    const L = this.lighthouse;
    L.beam.rotation.y = time * 0.9;
    L.beamMat.uniforms.uI.value = night * 0.55;
    L.lanternMat.emissiveIntensity = 0.2 + night * 9;
    if (this.restGlass) this.restGlass.emissiveIntensity = night * 1.2;
    if (this.bulbMat) this.bulbMat.color.setRGB(1, 0.8, 0.45).multiplyScalar(0.25 + night * 7);
    // torches flicker (visible from dusk)
    const fl = 1 + Math.sin(time * 13) * 0.15 + Math.sin(time * 7.3) * 0.1;
    this.flameMat.color.setRGB(1, 0.55, 0.15).multiplyScalar((0.6 + night * 5) * fl);
    // anchored sandbar boats + floating toys bob on the real waves
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    for (const b of this.anchoredBoats) {
      const h = waves.heightFast(b.x, b.z, time, 0.5);
      e.set(Math.sin(time * 0.8 + b.phase) * 0.025, -b.heading + Math.sin(time * 0.05 + b.phase) * 0.2, Math.sin(time * 1.0 + b.phase) * 0.035, 'YXZ');
      q.setFromEuler(e); p.set(b.x, h - 0.3, b.z);
      b.mesh.setMatrixAt(b.idx, m.compose(p, q, s));
    }
    for (const mm of this.sandbarBoats) mm.instanceMatrix.needsUpdate = true;
    for (const name of Object.keys(this.floaterMeshes)) {
      const { group, list } = this.floaterMeshes[name];
      list.forEach((f, i) => {
        f.x += Math.sin(time * 0.1 + f.phase) * dt * 0.2; f.z += Math.cos(time * 0.13 + f.phase) * dt * 0.2;
        const h = waves.heightFast(f.x, f.z, time, 0.3);
        e.set(Math.sin(time + f.phase) * 0.2, time * 0.1 + f.phase, 0); q.setFromEuler(e);
        p.set(f.x, h - 0.05, f.z);
        m.compose(p, q, s);
        for (const c of group.children) c.setMatrixAt(i, m);
      });
      for (const c of group.children) c.instanceMatrix.needsUpdate = true;
    }
  }
}
