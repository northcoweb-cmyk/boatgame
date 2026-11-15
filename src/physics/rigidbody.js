// Minimal 6-DOF rigid body with diagonal body-space inertia, semi-implicit Euler.
// All temporaries are preallocated so stepping never allocates.
import { Vector3, Quaternion, Matrix3, Matrix4 } from 'three';

const _r = new Vector3();
const _t = new Vector3();
const _w = new Vector3();
const _Iw = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();
const _m4 = new Matrix4();

export class RigidBody {
  constructor(mass, inertia) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this.inertia = new Vector3().copy(inertia);       // body-frame diagonal
    this.invInertia = new Vector3(1 / inertia.x, 1 / inertia.y, 1 / inertia.z);
    this.pos = new Vector3();
    this.quat = new Quaternion();
    this.vel = new Vector3();
    this.angVel = new Vector3();       // world frame
    this.force = new Vector3();
    this.torque = new Vector3();
    this.prevPos = new Vector3();
    this.prevQuat = new Quaternion();
    this.rot = new Matrix3();
    this.rotT = new Matrix3();
    this.syncRotation();
  }

  setMass(mass, inertia) {
    this.mass = mass; this.invMass = 1 / mass;
    this.inertia.copy(inertia);
    this.invInertia.set(1 / inertia.x, 1 / inertia.y, 1 / inertia.z);
  }

  syncRotation() {
    this.rot.setFromMatrix4(_m4.makeRotationFromQuaternion(this.quat));
    this.rotT.copy(this.rot).transpose();
  }

  clearForces() { this.force.set(0, 0, 0); this.torque.set(0, 0, 0); }
  addForce(f) { this.force.add(f); }
  addTorque(t) { this.torque.add(t); }
  addForceAtPoint(f, p) {
    this.force.add(f);
    _r.subVectors(p, this.pos);
    _t.crossVectors(_r, f);
    this.torque.add(_t);
  }

  localToWorld(local, out) { return out.copy(local).applyMatrix3(this.rot).add(this.pos); }
  localDirToWorld(local, out) { return out.copy(local).applyMatrix3(this.rot); }
  worldDirToLocal(dir, out) { return out.copy(dir).applyMatrix3(this.rotT); }
  pointVelocity(p, out) {
    _r.subVectors(p, this.pos);
    return out.crossVectors(this.angVel, _r).add(this.vel);
  }

  // Apply inverse world inertia: out = R * Iinv * R^T * v
  applyInvInertia(v, out) {
    out.copy(v).applyMatrix3(this.rotT);
    out.x *= this.invInertia.x; out.y *= this.invInertia.y; out.z *= this.invInertia.z;
    return out.applyMatrix3(this.rot);
  }

  applyImpulseAtPoint(j, p) {
    this.vel.addScaledVector(j, this.invMass);
    _r.subVectors(p, this.pos);
    _t.crossVectors(_r, j);
    this.applyInvInertia(_t, _w);
    this.angVel.add(_w);
  }

  // Effective inverse mass along direction n at point p.
  invMassAt(p, n) {
    _r.subVectors(p, this.pos);
    _t.crossVectors(_r, n);
    this.applyInvInertia(_t, _w);
    _t.crossVectors(_w, _r);
    return this.invMass + _t.dot(n);
  }

  integrate(dt) {
    this.vel.addScaledVector(this.force, this.invMass * dt);
    // gyroscopic term omitted; torque in world space
    _Iw.copy(this.angVel).applyMatrix3(this.rotT);
    _Iw.x *= this.inertia.x; _Iw.y *= this.inertia.y; _Iw.z *= this.inertia.z;
    this.applyInvInertia(this.torque, _w);
    this.angVel.addScaledVector(_w, dt);
    this.pos.addScaledVector(this.vel, dt);
    // quaternion integration
    const wx = this.angVel.x, wy = this.angVel.y, wz = this.angVel.z;
    _q.set(wx * dt * 0.5, wy * dt * 0.5, wz * dt * 0.5, 0);
    _qi.copy(_q).multiply(this.quat);
    this.quat.x += _qi.x; this.quat.y += _qi.y; this.quat.z += _qi.z; this.quat.w += _qi.w;
    this.quat.normalize();
    this.syncRotation();
  }

  savePrev() { this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat); }
}

