// Hull damage: integrity loss from impact energy, visible scuffs (darkened
// decals) and a small geometry nudge at the contact point. Repaired at fuel docks.
import * as THREE from 'three';
import { clamp } from '../core/math.js';

const scuffTex = (() => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(30,26,22,0.9)');
  grad.addColorStop(0.5, 'rgba(40,36,30,0.5)');
  grad.addColorStop(1, 'rgba(40,36,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(20,18,16,0.7)';
  for (let i = 0; i < 18; i++) {
    g.lineWidth = 0.6 + Math.random() * 1.6;
    g.beginPath();
    const y = 30 + Math.random() * 68;
    g.moveTo(10 + Math.random() * 20, y);
    g.lineTo(100 + Math.random() * 20, y + (Math.random() - 0.5) * 18);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

// Integrity lost for an impact (closing speed m/s against an obstacle).
export function impactDamage(speed, mass, colliderFactor = 1) {
  if (speed < 1.0) return 0;
  const e = 0.5 * Math.min(mass, 20000) * (speed - 1.0) * (speed - 1.0);
  return clamp(e / 260000, 0, 0.45) * colliderFactor;
}

export function groundingDamage(speed) {
  const s = speed - 2.6; // ~5 knots
  return s > 0 ? clamp(s * s * 0.025, 0, 0.3) : 0;
}

export class DamageVisuals {
  constructor(boatRoot) {
    this.root = boatRoot;
    this.decals = [];
    this.mat = new THREE.MeshBasicMaterial({ map: scuffTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this._inv = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this.originals = new Map();
  }

  // worldPoint/worldNormal: contact on the hull (normal pointing out of the obstacle into the boat)
  add(worldPoint, worldNormal, severity) {
    this.root.updateMatrixWorld(true);
    this._inv.copy(this.root.matrixWorld).invert();
    const lp = this._p.copy(worldPoint).applyMatrix4(this._inv);
    const ln = this._n.copy(worldNormal).transformDirection(this._inv).multiplyScalar(-1);
    // decal plane facing outward from the hull
    const size = 0.5 + severity * 2.2;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 0.6), this.mat);
    m.position.copy(lp).addScaledVector(ln, 0.02);
    m.lookAt(m.position.clone().add(ln));
    m.rotateZ(Math.random() * 0.6 - 0.3);
    m.renderOrder = 3;
    this.root.add(m);
    this.decals.push(m);
    if (this.decals.length > 24) { const old = this.decals.shift(); this.root.remove(old); old.geometry.dispose(); }
    this.dent(worldPoint, worldNormal, 0.03 + severity * 0.12, 0.4 + severity);
  }

  // push nearby hull vertices inward
  dent(worldPoint, worldNormal, depth, radius) {
    this.root.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || o.material === this.mat) return;
      const geo = o.geometry;
      if (!geo.attributes.position || geo.attributes.position.count > 120000) return;
      o.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(o.matrixWorld).invert();
      const lp = worldPoint.clone().applyMatrix4(inv);
      const scale = new THREE.Vector3().setFromMatrixScale(o.matrixWorld);
      const rLocal = radius / Math.max(scale.x, 1e-6);
      const box = geo.boundingBox || (geo.computeBoundingBox(), geo.boundingBox);
      if (box.distanceToPoint(lp) > rLocal) return;
      if (!this.originals.has(o)) { this.originals.set(o, geo); o.geometry = geo.clone(); }
      const pos = o.geometry.attributes.position;
      const dir = worldNormal.clone().transformDirection(inv).multiplyScalar(depth / Math.max(scale.x, 1e-6));
      const v = new THREE.Vector3();
      let changed = false;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const d = v.distanceTo(lp);
        if (d < rLocal) {
          const k = 1 - d / rLocal;
          pos.setXYZ(i, v.x + dir.x * k * k, v.y + dir.y * k * k, v.z + dir.z * k * k);
          changed = true;
        }
      }
      if (changed) { pos.needsUpdate = true; o.geometry.computeVertexNormals(); }
    });
  }

  clear() {
    for (const d of this.decals) { this.root.remove(d); d.geometry.dispose(); }
    this.decals.length = 0;
    for (const [o, g] of this.originals) { o.geometry.dispose(); o.geometry = g; }
    this.originals.clear();
  }
}
