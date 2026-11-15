// Runtime boat: the attached model (cleaned + measured), its physics body fitted
// to the measured hull, nav lights, a helm wheel that turns with input, outboard
// legs that steer, paint/trim, damage visuals, seat transforms and wake emitters.
import * as THREE from 'three';
import { BOATS, PAINTS } from './boat-defs.js';
import { BoatPhysics } from '../physics/boat-physics.js';
import { hullCircles } from '../physics/collision.js';
import { DamageVisuals } from '../physics/damage.js';
import { measureHull, deckPoint } from './hull-fit.js';
import { clamp } from '../core/math.js';

const _fw = new THREE.Vector3();
const _p = new THREE.Vector3();

function makeWheel(radius) {
  const g = new THREE.Group();
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.45, metalness: 0.2 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.18, metalness: 1 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, radius * 0.085, 10, 36), rimMat);
  g.add(rim);
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.03, radius * 0.03, radius * 1.9, 6), chrome);
    s.rotation.z = (i / 3) * Math.PI;
    g.add(s);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.14, radius * 0.14, radius * 0.2, 12), chrome);
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  return g;
}

function navLight(color, size) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), new THREE.MeshBasicMaterial({ color }));
  m.userData.base = new THREE.Color(color);
  return m;
}

export class Boat {
  constructor(game, id, { player = false, paint = 'white', trim = 'none' } = {}) {
    this.game = game;
    this.id = id;
    const base = BOATS[id];
    this.def = JSON.parse(JSON.stringify(base));
    const d = this.def;
    this.isPlayer = player;
    this.model = game.assets.cloneModel(d.model);
    if (d.hideMeshes) this.model.traverse((o) => { if (o.isMesh && d.hideMeshes.some((n) => (o.name + o.material.name).includes(n))) o.visible = false; });

    // ---- measure the real hull and fit the physics sheet to it
    const h = measureHull(this.model);
    this.hull = h;
    d.length = h.length;
    d.beam = h.beam * 0.95;
    const H = Math.max(0.5, h.gunwale - h.keel);
    d.keelBelowCom = Math.max(d.draft * 1.4, H * 0.42);
    d.deckAboveCom = Math.max(0.3, H - d.keelBelowCom);
    this.com = new THREE.Vector3(0, h.keel + d.keelBelowCom, h.transom - d.comFromStern * d.length);

    // ---- helm + seats ray-cast onto the deck (model space), then to body space
    const halfB = h.beam / 2;
    const slotPoint = (u, v, high) => {
      const z = h.bow + u * h.length, x = v * halfB * 0.9;
      // standing helm: cast from below leaning posts / T-tops so we land on the deck floor
      const p = deckPoint(this.model, x, z, high ? h.keel + H * 0.75 : h.gunwale + 0.35, h.keel + H * 0.55);
      return p.sub(this.com);
    };
    this.helmPos = slotPoint(d.helm.u, d.helm.v, d.helm.pose === 'stand');
    this.seats = d.seats.map((s) => ({ pos: slotPoint(s.u, s.v, false), face: s.face, pose: s.pose, taken: null }));

    // ---- scene graph: root (physics transform) -> offset (com) -> model
    this.root = new THREE.Group();
    this.root.name = 'boat-' + id;
    this.offset = new THREE.Group();
    this.offset.position.copy(this.com).negate();
    this.offset.add(this.model);
    this.root.add(this.offset);

    // helm wheel in front of the driver
    this.wheel = makeWheel(d.model === 'yacht' ? 0.24 : 0.19);
    this.wheel.position.copy(this.helmPos).add(_p.set(0, d.helm.wheelHeight - (d.helm.pose === 'sit' ? 0.35 : 0), -d.helm.back));
    this.wheel.rotation.x = -0.55;
    this.root.add(this.wheel);

    // outboard legs that visibly steer
    this.legPivot = null;
    if (d.engine.type === 'outboard') {
      const legs = [];
      this.model.updateMatrixWorld(true);
      this.model.traverse((o) => {
        if (!o.isMesh || o.isSkinnedMesh) return;
        const bb = new THREE.Box3().setFromObject(o);
        const c = bb.getCenter(new THREE.Vector3());
        if (c.z > h.transom - 0.05 && Math.abs(c.x) < h.beam * 0.35 && bb.max.z - bb.min.z < h.length * 0.25) legs.push(o);
      });
      if (legs.length) {
        const pivot = new THREE.Group();
        pivot.position.set(0, h.gunwale, h.transom + 0.15);
        this.model.add(pivot);
        pivot.updateMatrixWorld(true);
        for (const o of legs) pivot.attach(o);
        this.legPivot = pivot;
      }
    }

    // nav lights: red port, green starboard, white stern/masthead
    const nlY = h.gunwale + 0.08 - this.com.y;
    const bowZ = h.bow - this.com.z;
    this.navPort = navLight(0xff1a10, 0.06); this.navPort.position.set(-halfB * 0.55, nlY, bowZ + h.length * 0.12);
    this.navStbd = navLight(0x10ff40, 0.06); this.navStbd.position.set(halfB * 0.55, nlY, bowZ + h.length * 0.12);
    this.navStern = navLight(0xffffff, 0.07); this.navStern.position.set(0, h.top - this.com.y + 0.12, h.transom - this.com.z - h.length * 0.12);
    for (const l of [this.navPort, this.navStbd, this.navStern]) { l.visible = false; this.root.add(l); }
    if (player) {
      this.flood = new THREE.SpotLight(0xfff2dd, 0, 120, 0.42, 0.6, 1.4);
      this.flood.position.set(0, h.gunwale - this.com.y + 0.6, bowZ + h.length * 0.3);
      this.flood.target.position.set(0, -2, bowZ - 40);
      this.root.add(this.flood, this.flood.target);
    }

    // ---- physics
    this.phys = new BoatPhysics(d);
    this.circles = hullCircles(d);
    // ---- water mask: open-deck models have no floor, so the ocean would show
    // inside the hull. An invisible depth-only cap at the waterline (drawn after
    // the boat, before the water) hides it.
    {
      const pts = [];
      const L = h.length, z0 = h.bow - this.com.z, hb = h.beam * 0.47;
      const N = 14;
      for (let i = 0; i <= N; i++) { const t = i / N; const w = t < 0.35 ? Math.sin((t / 0.35) * Math.PI / 2) : 1; pts.push(new THREE.Vector2(-hb * w, z0 + t * L)); }
      for (let i = N; i >= 0; i--) { const t = i / N; const w = t < 0.35 ? Math.sin((t / 0.35) * Math.PI / 2) : 1; pts.push(new THREE.Vector2(hb * w, z0 + t * L)); }
      const geo = new THREE.ShapeGeometry(new THREE.Shape(pts));
      geo.rotateX(Math.PI / 2);
      const mask = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
      const wl = this.phys.restWaterlineY;
      mask.position.y = Math.min(wl + 0.28, h.gunwale - this.com.y - 0.08);
      mask.renderOrder = 0.5;
      mask.name = 'water-mask';
      this.root.add(mask);
    }
    this.damage = new DamageVisuals(this.model);
    this.wake = { distAccum: 0 };
    this.paintId = paint; this.trimId = trim;
    this.hullMats = [];
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (d.paintMaterials.includes(m.name) && !this.hullMats.includes(m)) { this.hullMats.push(m); m.userData.orig = m.color.clone(); }
    });
    this.applyPaint(paint, trim);
    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = o.castShadow && o.material && !o.material.transparent; } });
  }

  applyPaint(paintId, trimId) {
    this.paintId = paintId; this.trimId = trimId;
    const p = PAINTS.find((x) => x.id === paintId) || PAINTS[0];
    const col = new THREE.Color(p.hull);
    for (const m of this.hullMats) {
      if (paintId === 'white') {
        m.color.copy(m.userData.orig);
        if (this.def.defaultTube) m.color.set(this.def.defaultTube);
        if (this.def.model === 'runabout') m.color.setRGB(0.92, 0.93, 0.94);
      } else if (m.map) m.color.copy(col).lerp(new THREE.Color(1, 1, 1), 0.35);
      else m.color.copy(col);
      m.roughness = Math.min(m.roughness ?? 0.4, 0.32);
      m.metalness = 0;
      m.needsUpdate = true;
    }
    // trims
    if (this.stripe) { this.root.remove(this.stripe); this.stripe = null; }
    const gold = trimId === 'gold';
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.metalness > 0.6 || /chrome|silver|metal|alum/i.test(m.name)) {
          if (!m.userData.origMetal) m.userData.origMetal = m.color.clone();
          m.color.copy(gold ? new THREE.Color(1.0, 0.76, 0.33) : m.userData.origMetal);
        }
      }
    });
    if (trimId === 'rainbow') {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 8;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 256, 0);
      ['#ff4d6d', '#ff9f43', '#ffd166', '#06d6a0', '#118ab2', '#7b2ff7'].forEach((s, i) => grad.addColorStop(i / 5, s));
      g.fillStyle = grad; g.fillRect(0, 0, 256, 8);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -2 });
      const h = this.hull, L = h.length * 0.62;
      const geo = new THREE.PlaneGeometry(L, 0.09);
      this.stripe = new THREE.Group();
      for (const s of [-1, 1]) {
        const m = new THREE.Mesh(geo, mat);
        m.rotation.y = s * Math.PI / 2;
        m.position.set(s * (h.beam / 2 + 0.012), h.gunwale - 0.22 - this.com.y, h.bow + h.length * 0.5 - this.com.z);
        this.stripe.add(m);
      }
      this.root.add(this.stripe);
    }
  }

  get pos() { return this.phys.body.pos; }

  place(x, z, heading) {
    this.phys.reset(x, z, heading);
    this.updateVisual(1);
  }

  updateVisual(alpha, night = 0) {
    const b = this.phys.body;
    this.root.position.lerpVectors(b.prevPos, b.pos, alpha);
    this.root.quaternion.slerpQuaternions(b.prevQuat, b.quat, alpha);
    const r = this.phys.rudder / Math.max(this.def.rudder.maxAngle, 0.01);
    this.wheel.rotation.z = -r * 2.6;
    if (this.legPivot) this.legPivot.rotation.y = -this.phys.rudder;
    const on = night > 0.35;
    this.navPort.visible = this.navStbd.visible = this.navStern.visible = on;
    if (on) for (const l of [this.navPort, this.navStbd, this.navStern]) l.material.color.copy(l.userData.base).multiplyScalar(4 + night * 6);
    if (this.flood) this.flood.intensity = night > 0.5 && this.phys.engineOn ? 60 : 0;
  }

  // world-space data for the wake emitter
  wakeState() {
    const b = this.phys.body, t = this.phys.t, w = this.wake;
    _fw.set(0, 0, -1).applyQuaternion(b.quat);
    _fw.y = 0; _fw.normalize();
    const L = this.def.length;
    w.x = b.pos.x; w.z = b.pos.z; w.y = b.pos.y;
    w.fx = _fw.x; w.fz = _fw.z;
    w.vx = b.vel.x; w.vz = b.vel.z;
    w.speed = Math.max(0, t.surge);
    w.beam = this.def.beam; w.length = L;
    w.throttle = Math.max(this.phys.input.throttle, this.phys.input.reverse) * (this.phys.engineOn ? 1 : 0);
    w.mass = b.mass;
    const bz = this.phys.bowZ * 0.85, sz = this.phys.sternZ;
    w.bowX = b.pos.x + _fw.x * -bz; w.bowZ = b.pos.z + _fw.z * -bz;
    w.sternX = b.pos.x - _fw.x * sz; w.sternZ = b.pos.z - _fw.z * sz;
    w.yawRate = -t.yawRate;
    w.wet = t.wet;
    w.sprayK = clamp(this.game.waves.current.chop * 0.8 + 0.4, 0.2, 1.6);
    return w;
  }
}
