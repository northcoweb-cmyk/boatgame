// Camera rig: helm (seated at the wheel, mouse look-around, spray on the lens),
// chase (springy, speed-FOV, wave shake, banks in turns), drone (free-fly +
// cinematic auto-orbit at anchor), docking top-down assist, hangout orbit,
// on-foot third/first person, and the title-screen drift. 0.3 s blends.
import * as THREE from 'three';
import { clamp, damp, smoothstep, lerp } from '../core/math.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

export const BOAT_CAMS = ['helm', 'chase', 'drone'];

export class CameraRig {
  constructor(camera, game) {
    this.cam = camera;
    this.game = game;
    this.mode = 'title';
    this.blendT = 1;
    this.fromPos = new THREE.Vector3();
    this.fromQuat = new THREE.Quaternion();
    this.fromFov = 60;
    this.chasePos = new THREE.Vector3();
    this.chaseVel = new THREE.Vector3();
    this.lookYaw = 0; this.lookPitch = 0;
    this.footYaw = 0; this.footPitch = -0.15; this.footDist = 4.2;
    this.drone = { pos: new THREE.Vector3(), yaw: 0, pitch: -0.3, orbit: 0 };
    this.shakeT = 0;
    this.shakeAmt = 0;
    this.orbitA = 0;
    this.firstPerson = false;
    this.target = new THREE.Vector3();
    this.droplets = 0;
    this.velocity = new THREE.Vector3();
    this._prev = new THREE.Vector3();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.fromPos.copy(this.cam.position);
    this.fromQuat.copy(this.cam.quaternion);
    this.fromFov = this.cam.fov;
    if (mode === 'drone') { this.drone.pos.copy(this.cam.position); this.drone.yaw = this.footYaw; _e.setFromQuaternion(this.cam.quaternion, 'YXZ'); this.drone.yaw = _e.y; this.drone.pitch = _e.x; }
    if (mode === 'chase' && this.game.boat) this.chasePos.copy(this.cam.position);
    this.mode = mode;
    this.blendT = 0;
    this.lookYaw = 0; this.lookPitch = 0;
  }

  shake(a) { this.shakeAmt = Math.max(this.shakeAmt, a); }

  update(dt, input, opts) {
    const cam = this.cam, game = this.game, boat = game.boat;
    const settings = game.save.data.settings;
    const sens = settings.mouseSensitivity || 1;
    const lookX = input.state.lookX * sens, lookY = input.state.lookY * sens * (settings.invertLook ? -1 : 1);
    let fov = settings.fov;
    const pos = _v.set(0, 0, 0);
    const quat = _q.identity();
    this.droplets = damp(this.droplets, 0, 1.2, dt);

    if (this.mode === 'helm' && boat) {
      const r = boat.root;
      r.updateMatrixWorld();
      // eye sits behind and above the helm wheel, so the wheel and dash are in view
      const eye = _v2.copy(boat.wheel.position).add(new THREE.Vector3(0, (boat.def.helm.eyeAbove ?? 0.4) + (boat.def.helm.pose === 'stand' ? 0.05 : 0), boat.def.helm.back + 0.42));
      pos.copy(eye).applyMatrix4(r.matrixWorld);
      this.lookYaw = clamp(this.lookYaw - lookX, -2.6, 2.6);
      this.lookPitch = clamp(this.lookPitch - lookY, -0.9, 0.7);
      if (Math.abs(lookX) + Math.abs(lookY) < 1e-5) { this.lookYaw = damp(this.lookYaw, 0, 0.4, dt); this.lookPitch = damp(this.lookPitch, -0.1, 0.4, dt); }
      _e.set(this.lookPitch, this.lookYaw, 0, 'YXZ');
      quat.copy(r.quaternion).multiply(new THREE.Quaternion().setFromEuler(_e));
      const sp = boat.phys.t.speed;
      fov += clamp(sp / 20, 0, 1) * 6;
      const chop = game.waves.current.chop;
      this.droplets = Math.max(this.droplets, clamp((sp - 8) / 12, 0, 1) * clamp(chop, 0.2, 1.2) * 0.8);
    } else if (this.mode === 'chase' && boat) {
      const b = boat.phys.body;
      const fwd = _v2.set(0, 0, -1).applyQuaternion(b.quat); fwd.y = 0; fwd.normalize();
      // tied up alongside a dock: lift the camera so pilings and decks don't block the view
      const docked = this.game.sea && this.game.sea.docked;
      const d = boat.def.chase.dist * (docked ? 1.25 : 1), h = boat.def.chase.height * (docked ? 2.1 : 1);
      const sp = boat.phys.t.speed;
      const want = new THREE.Vector3().copy(boat.root.position).addScaledVector(fwd, -d - sp * 0.06).add(new THREE.Vector3(0, h + sp * 0.02, 0));
      // springy follow (critically damped)
      const k = 6, c = 2 * Math.sqrt(k);
      const acc = want.clone().sub(this.chasePos).multiplyScalar(k).addScaledVector(this.chaseVel, -c);
      this.chaseVel.addScaledVector(acc, dt);
      this.chasePos.addScaledVector(this.chaseVel, dt);
      if (this.chasePos.distanceTo(want) > d * 3 || this.snap) { this.chasePos.copy(want); this.chaseVel.set(0, 0, 0); this.snap = false; }
      pos.copy(this.chasePos);
      // heave and pitch come through un-smoothed so every wave and slam is felt
      pos.y += (boat.root.position.y - this.chasePos.y + h) * 0.85;
      pos.y += Math.sin(boat.phys.t.trim) * d * 0.35;
      // stay above the water surface
      const wh = game.waves.heightFast(pos.x, pos.z, game.time) + 0.7;
      if (pos.y < wh) pos.y = wh;
      this.lookYaw = clamp(this.lookYaw - lookX, -Math.PI, Math.PI);
      if (Math.abs(lookX) < 1e-5) this.lookYaw = damp(this.lookYaw, 0, 0.8, dt);
      const tgt = this.target.copy(boat.root.position).addScaledVector(fwd, boat.def.length * 0.9).add(new THREE.Vector3(0, boat.def.chase.height * 0.45, 0));
      if (Math.abs(this.lookYaw) > 0.001) { pos.sub(tgt).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.lookYaw).add(tgt); }
      _m.lookAt(pos, tgt, new THREE.Vector3(-Math.sin(boat.phys.t.heel) * 0.45, 1, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(fwd.x, fwd.z)).normalize());
      quat.setFromRotationMatrix(_m);
      fov += clamp(sp / 18, 0, 1) * 6;
    } else if (this.mode === 'drone') {
      const D = this.drone;
      const anchored = boat && (boat.phys.anchor || opts.hangout);
      if (opts.droneFly) {
        D.yaw -= lookX; D.pitch = clamp(D.pitch - lookY, -1.5, 1.2);
        _e.set(D.pitch, D.yaw, 0, 'YXZ');
        const q = new THREE.Quaternion().setFromEuler(_e);
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q), rgt = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        const speed = input.state.run ? 40 : 12;
        D.pos.addScaledVector(f, input.state.moveY * speed * dt).addScaledVector(rgt, input.state.moveX * speed * dt);
        if (input.kb.has('KeyQ')) D.pos.y -= speed * dt;
        if (input.kb.has('KeyE')) D.pos.y += speed * dt;
        D.pos.y = Math.max(D.pos.y, game.waves.heightFast(D.pos.x, D.pos.z, game.time) + 0.5);
        pos.copy(D.pos); quat.copy(q);
      } else if (boat) {
        // cinematic auto-orbit
        D.orbit += dt * (anchored ? 0.06 : 0.12);
        const R = boat.def.length * 2.6 + 8;
        pos.set(boat.root.position.x + Math.cos(D.orbit) * R, boat.root.position.y + 5 + Math.sin(D.orbit * 0.7) * 2, boat.root.position.z + Math.sin(D.orbit) * R);
        _m.lookAt(pos, this.target.copy(boat.root.position).add(new THREE.Vector3(0, 1.5, 0)), new THREE.Vector3(0, 1, 0));
        quat.setFromRotationMatrix(_m);
        D.pos.copy(pos);
      }
    } else if (this.mode === 'dock' && boat) {
      const b = boat.root;
      const sp = boat.phys.t.speed;
      const h = boat.def.length * 3.2 + 16 + sp * 2;
      const fwd = _v2.set(0, 0, -1).applyQuaternion(boat.phys.body.quat); fwd.y = 0; fwd.normalize();
      pos.copy(b.position).add(new THREE.Vector3(0, h, 0)).addScaledVector(fwd, -h * 0.18);
      _m.lookAt(pos, this.target.copy(b.position).addScaledVector(fwd, boat.def.length * 0.3), fwd);
      quat.setFromRotationMatrix(_m);
    } else if (this.mode === 'hangout' && boat) {
      this.orbitA += dt * 0.07;
      const R = boat.def.length * 2.0 + 10;
      pos.set(boat.root.position.x + Math.cos(this.orbitA) * R, boat.root.position.y + 3.5, boat.root.position.z + Math.sin(this.orbitA) * R);
      _m.lookAt(pos, this.target.copy(boat.root.position).add(new THREE.Vector3(0, 1.2, 0)), new THREE.Vector3(0, 1, 0));
      quat.setFromRotationMatrix(_m);
      fov -= 6;
    } else if (this.mode === 'foot' && opts.player) {
      const p = opts.player;
      this.footYaw -= lookX; this.footPitch = clamp(this.footPitch - lookY, -1.2, 0.9);
      if (this.firstPerson) {
        pos.copy(p.headPos);
        _e.set(this.footPitch, this.footYaw, 0, 'YXZ');
        quat.setFromEuler(_e);
      } else {
        const aim = opts.aiming;
        const dist = aim ? 1.8 : this.footDist;
        _e.set(this.footPitch, this.footYaw, 0, 'YXZ');
        const q = new THREE.Quaternion().setFromEuler(_e);
        const back = new THREE.Vector3(aim ? 0.55 : 0.0, 0, dist).applyQuaternion(q);
        const head = this.target.copy(p.pos).add(new THREE.Vector3(0, 1.62, 0));
        pos.copy(head).add(back);
        const wh = game.waves.heightFast(pos.x, pos.z, game.time) + 0.35;
        if (pos.y < wh) pos.y = wh;
        const ground = game.groundHeightAt(pos.x, pos.z) + 0.3;
        if (pos.y < ground) pos.y = ground;
        quat.copy(q);
        if (aim) fov -= 18;
      }
    } else if (this.mode === 'title') {
      const t = game.time * 0.03;
      const c = opts.titleTarget || new THREE.Vector3();
      pos.set(c.x + Math.cos(t) * 34, c.y + 6 + Math.sin(t * 0.7) * 1.5, c.z + Math.sin(t) * 34);
      _m.lookAt(pos, this.target.copy(c).add(new THREE.Vector3(Math.sin(t * 0.5) * 20, 3, 0)), new THREE.Vector3(0, 1, 0));
      quat.setFromRotationMatrix(_m);
    } else {
      pos.copy(cam.position); quat.copy(cam.quaternion);
    }

    // shake (perceived force feedback)
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.5);
    const sh = this.shakeAmt + (opts.ffbShake || 0);
    if (sh > 0.001) {
      this.shakeT += dt * 40;
      const k = sh * 0.06;
      quat.multiply(new THREE.Quaternion().setFromEuler(_e.set(Math.sin(this.shakeT * 1.3) * k, Math.sin(this.shakeT * 1.7) * k, Math.sin(this.shakeT) * k * 0.5)));
      pos.y += Math.sin(this.shakeT * 2.1) * k * 0.6;
    }

    // blend from the previous camera over 0.3 s
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / 0.3);
      const t = smoothstep(0, 1, this.blendT);
      pos.lerpVectors(this.fromPos, pos, t);
      quat.slerpQuaternions(this.fromQuat, quat, t);
      fov = lerp(this.fromFov, fov, t);
    }
    cam.position.copy(pos);
    cam.quaternion.copy(quat);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = damp(cam.fov, fov, 6, dt); cam.updateProjectionMatrix(); }
    this.velocity.copy(cam.position).sub(this._prev).multiplyScalar(1 / Math.max(dt, 1e-3));
    this._prev.copy(cam.position);
  }
}
