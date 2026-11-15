// Planar reflection for the water: mirrored virtual camera with an oblique
// near plane at sea level, rendered at reduced resolution into an HDR target.
// Skipped automatically when the camera cannot see the water.
import * as THREE from 'three';

export const LAYER_NO_REFLECT = 1;

export class PlanarReflection {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: 0 });
    this.target.texture.generateMipmaps = false;
    this.camera = new THREE.PerspectiveCamera();
    this.camera.layers.set(0);
    this.textureMatrix = new THREE.Matrix4();
    this.scale = 0.5;
    this.enabled = true;
    this.active = false;
    this._normal = new THREE.Vector3(0, 1, 0);
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._q = new THREE.Vector4();
    this._view = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._camPos = new THREE.Vector3();
    this._corner = new THREE.Vector3();
  }

  setSize(w, h) {
    this.target.setSize(Math.max(16, Math.floor(w * this.scale)), Math.max(16, Math.floor(h * this.scale)));
  }

  // Does any part of the view frustum reach the water plane?
  waterVisible(cam) {
    if (cam.position.y < 0) return false;
    for (let i = 0; i < 4; i++) {
      this._corner.set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, 1).unproject(cam);
      if (this._corner.y < cam.position.y - 0.01) return true;
    }
    return false;
  }

  render(scene, cam, hidden) {
    this.active = false;
    if (!this.enabled || !this.waterVisible(cam)) return false;
    const r = this.renderer;
    const n = this._normal;
    this._camPos.setFromMatrixPosition(cam.matrixWorld);
    this._rot.extractRotation(cam.matrixWorld);
    this._view.set(this._camPos.x, -this._camPos.y, this._camPos.z); // mirrored about y = 0
    this._lookAt.set(0, 0, -1).applyMatrix4(this._rot).add(this._camPos);
    this._target.set(this._lookAt.x, -this._lookAt.y, this._lookAt.z);
    const vc = this.camera;
    vc.position.copy(this._view);
    vc.up.set(0, 1, 0).applyMatrix4(this._rot);
    vc.up.y *= -1;
    vc.lookAt(this._target);
    vc.near = cam.near; vc.far = cam.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(cam.projectionMatrix);
    vc.projectionMatrixInverse.copy(cam.projectionMatrixInverse);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    // oblique clip plane at y = -0.15 (keeps wave troughs filled)
    this._plane.setFromNormalAndCoplanarPoint(n, this._corner.set(0, -0.15, 0));
    this._plane.applyMatrix4(vc.matrixWorldInverse);
    const c = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const p = vc.projectionMatrix.elements;
    const q = this._q;
    q.x = (Math.sign(c.x) + p[8]) / p[0];
    q.y = (Math.sign(c.y) + p[9]) / p[5];
    q.z = -1;
    q.w = (1 + p[10]) / p[14];
    c.multiplyScalar(2 / c.dot(q));
    p[2] = c.x; p[6] = c.y; p[10] = c.z + 1; p[14] = c.w;

    for (const o of hidden) o.visible = false;
    const prevTarget = r.getRenderTarget();
    const prevShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.target);
    r.clear();
    r.render(scene, vc);
    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevShadow;
    for (const o of hidden) o.visible = true;
    this.active = true;
    return true;
  }
}
