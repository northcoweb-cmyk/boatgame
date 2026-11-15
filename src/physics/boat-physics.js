// Boat dynamics: multi-probe buoyancy on the shared wave field, directional
// quadratic drag in body space, displacement->planing transition with a hump,
// thrust/rudder/prop-walk/thruster, ventilation, windage, current, grounding,
// anchor + dock-line constraints. Runs at a fixed 240 Hz.
import { Vector3, Quaternion } from 'three';
import { RigidBody } from './rigidbody.js';
import { G, RHO_WATER, RHO_AIR, KNOT, clamp, clamp01, smoothstep, approach, lerp, gauss } from '../core/math.js';

const _f = new Vector3();
const _p = new Vector3();
const _v = new Vector3();
const _l = new Vector3();
const _w = new Vector3();
const _a = new Vector3();
const _n = new Vector3();
const _cur = new Vector3();
const _wind = new Vector3();
const _vb = new Vector3();
const _q = new Quaternion();
const _ws = { h: 0, nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0, depth: 0, atten: 1 };

export class BoatPhysics {
  constructor(def) {
    this.def = def;
    this.passengerMass = 0;
    const L = def.length, B = def.beam;
    this.body = new RigidBody(def.mass, this._inertia(def.mass));

    // ------------------------------------------------------------ probes
    // stations along the hull from bow (-Z) to transom (+Z)
    const bowZ = -L * (1 - def.comFromStern), sternZ = L * def.comFromStern;
    this.bowZ = bowZ; this.sternZ = sternZ;
    const fr = [0.06, 0.24, 0.45, 0.66, 0.86, 0.99];
    const widths = [0.28, 0.72, 0.95, 1.0, 1.0, 0.96];
    const keelY = -def.keelBelowCom;
    this.probes = [];
    for (let i = 0; i < fr.length; i++) {
      const z = lerp(bowZ, sternZ, fr[i]);
      const hb = (B * 0.5) * widths[i];
      // bow sheer rises; keel rises toward the stem
      const keelRise = i === 0 ? 0.32 * def.keelBelowCom : i === 1 ? 0.1 * def.keelBelowCom : 0;
      const kY = keelY + keelRise;
      const chineX = hb * 0.82;
      const chineY = kY + chineX * Math.tan(def.deadrise);
      const w = widths[i];
      this.probes.push({ local: new Vector3(0, kY, z), area: w * 1.1, wet: 0, wasWet: false, bow: i <= 1 });
      this.probes.push({ local: new Vector3(-chineX, chineY, z), area: w, wet: 0, wasWet: false, bow: i <= 1 });
      this.probes.push({ local: new Vector3(chineX, chineY, z), area: w, wet: 0, wasWet: false, bow: i <= 1 });
    }
    // contact points for grounding (keel line + transom corners + stem)
    this.contacts = [
      new Vector3(0, keelY + 0.45 * def.keelBelowCom, bowZ),
      new Vector3(0, keelY + 0.12 * def.keelBelowCom, lerp(bowZ, sternZ, 0.22)),
      new Vector3(0, keelY, lerp(bowZ, sternZ, 0.5)),
      new Vector3(0, keelY, lerp(bowZ, sternZ, 0.8)),
      new Vector3(-B * 0.42, keelY + B * 0.42 * Math.tan(def.deadrise), sternZ),
      new Vector3(B * 0.42, keelY + B * 0.42 * Math.tan(def.deadrise), sternZ),
      new Vector3(0, keelY - (def.engine.type === 'outboard' ? 0.25 : 0.1), sternZ + 0.2), // skeg / lower unit
    ];
    this.colH = def.keelBelowCom + def.deckAboveCom;
    this.restWaterlineY = keelY + def.draft;
    this._calibrateBuoyancy();

    this.propLocal = new Vector3(0, keelY + 0.05 - def.propDepth * 0.25, sternZ + (def.engine.type === 'outboard' ? 0.35 : -0.6));
    this.bowLocal = new Vector3(0, def.deckAboveCom * 0.6, bowZ);
    this.clrLocal = new Vector3(0, keelY * 0.6, (sternZ - bowZ) * 0.12);
    this.windLocal = new Vector3(0, def.windage.height, -(sternZ - bowZ) * def.windage.lead);

    // ------------------------------------------------------------ hull resistance
    const h = def.hull;
    const vCal = h.vTop * 1.08; // calibrate slightly high: chop, trim and spray cost a few knots
    const thrustTop = def.engine.maxThrust * (1 - 0.32 * Math.min(vCal / h.vTop, 1.2));
    const humpShape = (v) => gauss((v - h.vHump) / (0.55 * h.vHump));
    // R(V) = cd V^2 (1 + humpAmp * humpShape(V)) ; choose humpAmp from margin at hump
    const lin = def.mass * 0.025;
    const Tm = def.engine.maxThrust;
    const tFull = (v) => Tm * (1 - 0.32 * Math.min(v / h.vTop, 1.2));
    const res = (v, A, c) => c * v * v * (1 + A * humpShape(v)) + lin * v;
    const cdFor = (A) => (thrustTop - lin * vCal) / (vCal * vCal * (1 + A * humpShape(vCal)));
    // bisection: the smallest surplus thrust across the hump equals planeMargin
    let lo = 0, hi = 40, humpAmp = 0, cd = cdFor(0);
    for (let i = 0; i < 40; i++) {
      const A = (lo + hi) / 2, c = cdFor(A);
      let minSurplus = 1e9;
      for (let v = 0.3 * h.vHump; v < Math.min(2.5 * h.vHump, h.vTop); v += h.vHump * 0.02) minSurplus = Math.min(minSurplus, tFull(v) - res(v, A, c));
      if (minSurplus > h.planeMargin * Tm) lo = A; else hi = A;
      humpAmp = A; cd = c;
    }
    this.linDrag = lin;
    this.cd = cd; this.humpAmp = humpAmp; this.humpShape = humpShape;

    // ------------------------------------------------------------ state
    this.rpm = def.engine.idleRpm;
    this.spool = 0;
    this.engineOn = true;
    this.gear = 0;                // -1 R, 0 N, 1 F
    this.shiftTimer = 0;
    this.rudder = 0;              // radians
    this.integrity = 1;
    this.fuel = 1;
    this.vent = 0;
    this.ventCooldown = 0;
    this.anchor = null;           // { x, z, rode }
    this.lines = null;            // [{ local: Vector3, anchor: Vector3, rest }]
    this.thrusterInput = 0;
    this.buoyancyScale = 1;     // < 1 while the hull floods / sinks
    this.input = { throttle: 0, reverse: 0, steer: 0, thruster: 0 };

    // telemetry
    this.t = {
      speed: 0, speedKn: 0, surge: 0, sway: 0, rpm: 0, rpmFrac: 0, gear: 0, thrust: 0,
      wet: 1, airborne: false, airTime: 0, grounded: 0, grind: 0, depthUnderKeel: 10,
      heel: 0, trim: 0, latAccel: 0, vertAccel: 0, plane: 0, ventilating: false, yawRate: 0,
      waterDepth: 5, rudder: 0, propSubmerged: true,
    };
    this._prevVel = new Vector3();
    this._airT = 0;
    this._airStart = new Vector3();
    this._contactWasDown = new Array(this.contacts.length).fill(false);
    this.events = [];          // drained by the game each frame
  }

  _inertia(mass) {
    const d = this.def, L = d.length, B = d.beam, H = d.keelBelowCom + d.deckAboveCom;
    const k = 0.78;
    return new Vector3(
      (mass / 12) * (L * L + H * H) * k,   // pitch about X
      (mass / 12) * (L * L + B * B) * k,   // yaw about Y
      (mass / 12) * (B * B + H * H) * k * 1.25 // roll about Z
    );
  }

  setPassengerMass(m) {
    this.passengerMass = m;
    const total = this.def.mass + m;
    this.body.setMass(total, this._inertia(total));
    this._calibrateBuoyancy();
  }

  _calibrateBuoyancy() {
    // scale probe areas so the hull floats at its design waterline (slightly
    // deeper when loaded)
    const m = this.body ? this.body.mass : this.def.mass;
    const wl = this.restWaterlineY;
    let s = 0, sa = 0;
    for (const p of this.probes) { s += p.area * Math.max(0, wl - p.local.y); sa += p.area; }
    const scale = (this.def.mass / RHO_WATER) / s;
    for (const p of this.probes) p.A = p.area * scale;
    this.totalArea = sa * scale;
    this.heaveDamp = 0.62 * 2 * Math.sqrt(RHO_WATER * G * m / this.totalArea);
  }

  reset(x, z, heading) {
    const b = this.body;
    b.pos.set(x, -this.restWaterlineY, z);
    b.quat.setFromAxisAngle(_a.set(0, 1, 0), -heading);
    b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0);
    b.syncRotation();
    b.savePrev();
    this.rpm = this.def.engine.idleRpm;
    this.gear = 0;
    this.rudder = 0;
  }

  get heading() {
    // compass radians (0 = north, cw positive)
    _v.set(0, 0, -1).applyQuaternion(this.body.quat);
    return Math.atan2(_v.x, -_v.z);
  }

  emit(type, a = 0, b = 0, x = 0, y = 0, z = 0) {
    this.events.push({ type, a, b, x, y, z });
  }

  // ------------------------------------------------------------------ step
  step(dt, env) {
    const d = this.def, b = this.body, tel = this.t, inp = this.input;
    b.clearForces();
    const mass = b.mass;

    // gravity
    b.force.y -= mass * G;

    // body-relative water velocity (current)
    env.current(b.pos.x, b.pos.z, _cur);

    // ---------------------------------------------------------- buoyancy
    let wetSum = 0, wetArea = 0, avgDepth = 0, propSub = true;
    const time = env.time;
    for (let i = 0; i < this.probes.length; i++) {
      const pr = this.probes[i];
      b.localToWorld(pr.local, _p);
      const ground = env.terrainHeight(_p.x, _p.z);
      env.waves.sample(_p.x, _p.z, time, _ws, -ground);
      let surf = _ws.h + env.wakeHeight(_p.x, _p.z);
      if (i === 6) { tel.waterDepth = -ground; }
      const sub = clamp(surf - _p.y, 0, this.colH);
      pr.wet = sub;
      if (sub > 0) {
        wetSum += pr.A * Math.min(sub, this.def.draft * 1.5);
        wetArea += pr.A;
        b.pointVelocity(_p, _v);
        const relVy = _v.y - _ws.vy * 0.8;
        // buoyancy along a blend of world up and wave normal (waves push slightly)
        const fb = RHO_WATER * G * pr.A * sub * this.buoyancyScale;
        _f.set(_ws.nx * 0.18 * fb, fb, _ws.nz * 0.18 * fb);
        // heave damping proportional to submerged fraction
        _f.y -= this.heaveDamp * pr.A * relVy * Math.min(1, sub / 0.12);
        // horizontal wave orbital drag (small) so swells carry the hull a little
        _f.x += _ws.vx * pr.A * 140 * Math.min(1, sub / 0.2);
        _f.z += _ws.vz * pr.A * 140 * Math.min(1, sub / 0.2);
        b.addForceAtPoint(_f, _p);
        // wave slam: bow probe re-entering fast
        if (pr.bow && !pr.wasWet && relVy < -2.2) this.emit('slam', -relVy, 0, _p.x, _p.y, _p.z);
      }
      pr.wasWet = sub > 0.01;
      avgDepth += sub;
    }
    const restWet = (this.def.mass / RHO_WATER);
    const wet = clamp01(wetSum / restWet);
    tel.wet = wet;
    const contact = clamp01(wetArea / (this.totalArea * 0.1));

    // ---------------------------------------------------------- body-frame velocity
    _v.copy(b.vel).sub(_cur);
    b.worldDirToLocal(_v, _vb);
    const u = -_vb.z;            // forward speed through water
    const sway = _vb.x;
    const V = Math.abs(u);
    tel.surge = u; tel.sway = sway;
    const h = d.hull;
    const plane = smoothstep(0.8 * h.vHump, 1.55 * h.vHump, V) * contact;
    tel.plane = plane;

    // ---------------------------------------------------------- engine
    const e = d.engine;
    const powerCap = (this.fuel > 0 ? 1 : 0.25) * lerp(0.45, 1, Math.pow(this.integrity, 1.2));
    let lever = 0, wantGear = 0;
    if (this.engineOn) {
      if (inp.throttle > 0.02 && inp.throttle >= inp.reverse) { wantGear = 1; lever = inp.throttle; }
      else if (inp.reverse > 0.02) { wantGear = -1; lever = inp.reverse; }
    }
    if (wantGear !== this.gear) {
      // must come back through neutral near idle before engaging
      if (this.gear !== 0) {
        lever = 0;
        if (this.spool < 0.1) { this.gear = 0; this.shiftTimer = e.shiftDelay; this.emit('shift', 0); }
      } else {
        lever = 0;
        this.shiftTimer -= dt;
        if (this.shiftTimer <= 0 && wantGear !== 0) { this.gear = wantGear; this.emit('shift', wantGear); }
      }
    }
    const inGear = this.gear !== 0;
    const loadFrac = inGear ? lerp(0.82, 1.0, clamp01(V / h.vTop)) : 0.6;
    const spoolTarget = this.engineOn ? lever * powerCap : 0;
    this.spool = approach(this.spool, spoolTarget, (spoolTarget > this.spool ? 1 / e.spoolUp : 1 / e.spoolDown) * dt);
    const span = e.maxRpm - e.idleRpm;
    let rpmTarget = 0;
    if (this.engineOn) {
      const ventBoost = (this.vent > 0 || !tel.propSubmerged) && inGear ? 1.2 : 1;
      rpmTarget = Math.min(e.maxRpm * 1.07, (e.idleRpm + span * this.spool * loadFrac) * ventBoost);
    }
    this.rpm = approach(this.rpm, rpmTarget, span * (this.engineOn ? 3 : 1.4) * dt);
    const rpmFrac = this.spool;
    tel.rpm = this.rpm; tel.rpmFrac = clamp01((this.rpm - e.idleRpm) / span); tel.gear = this.gear;
    if (this.engineOn) this.fuel = Math.max(0, this.fuel - dt * (0.000006 + 0.00006 * rpmFrac * rpmFrac) * (e.hp / 150) ** 0.3);

    // prop immersion
    b.localToWorld(this.propLocal, _p);
    const propSurf = env.waves.heightFast(_p.x, _p.z, time) + env.wakeHeight(_p.x, _p.z);
    const propDepth = propSurf - _p.y;
    tel.propSubmerged = propDepth > 0.02;

    // ventilation in hard turns at speed
    this.ventCooldown -= dt;
    if (this.vent > 0) this.vent -= dt;
    else if (this.ventCooldown <= 0 && inGear && V > 0.65 * h.vTop && Math.abs(this.rudder) > 0.75 * d.rudder.minAngleAtSpeed && Math.abs(tel.latAccel) > 3.5 && Math.random() < dt * 1.2) {
      this.vent = 0.35 + Math.random() * 0.45; this.ventCooldown = 2.5;
      this.emit('ventilate', this.vent);
    }
    tel.ventilating = this.vent > 0;

    let thrust = 0;
    if (inGear && this.engineOn) {
      const eff = (0.05 + 0.95 * rpmFrac) * e.maxThrust;
      if (this.gear > 0) thrust = eff * (1 - 0.32 * clamp(u / h.vTop, 0, 1.2));
      else thrust = -eff * e.revFactor * (1 - 0.2 * clamp(-u / 4, 0, 1));
      const immersion = clamp01(propDepth / 0.12);
      thrust *= immersion * (this.vent > 0 ? 0.25 : 1);
    }
    tel.thrust = thrust;

    // ---------------------------------------------------------- helm
    const r = d.rudder;
    const speedT = smoothstep(0.25 * h.vTop, 0.95 * h.vTop, V);
    const maxA = lerp(r.maxAngle, r.minAngleAtSpeed, speedT);
    const rRate = lerp(r.rate, r.rateAtSpeed, speedT);
    this.rudder = approach(this.rudder, inp.steer * maxA, rRate * dt);
    tel.rudder = this.rudder;
    const sinD = Math.sin(this.rudder), cosD = Math.cos(this.rudder);

    // thrust (outboards vector the thrust; inboards push along the keel)
    if (thrust !== 0) {
      if (e.type === 'outboard') _l.set(-thrust * sinD, 0, -thrust * cosD);
      else _l.set(0, 0, -thrust);
      b.localDirToWorld(_l, _f);
      b.localToWorld(this.propLocal, _p);
      b.addForceAtPoint(_f, _p);
    }
    // rudder / lower unit lift: prop wash term + flow term with speed falloff
    {
      const wash = e.type === 'outboard' ? 0 : Math.max(0, thrust) * r.washGain;
      const flowFalloff = 1 / (1 + Math.pow(V / r.falloff, 2));
      const flow = 0.5 * RHO_WATER * r.speedGain * u * Math.abs(u) * flowFalloff * contact;
      const lat = -sinD * (wash + flow * (e.type === 'outboard' ? 0.6 : 1));
      if (lat !== 0) {
        _l.set(lat, 0, 0);
        b.localDirToWorld(_l, _f);
        b.localToWorld(this.propLocal, _p);
        b.addForceAtPoint(_f, _p);
      }
    }
    // prop walk: right-hand screw in reverse walks the stern to port
    if (this.gear < 0 && this.engineOn) {
      const pw = d.propWalk * e.maxThrust * (0.25 + 0.75 * rpmFrac) * (1 - smoothstep(0.4, 3.0, V)) * clamp01(propDepth / 0.12);
      _l.set(-pw, 0, 0);
      b.localDirToWorld(_l, _f);
      b.localToWorld(_a.set(0, this.propLocal.y, this.sternZ), _p);
      b.addForceAtPoint(_f, _p);
    }
    // bow thruster
    if (d.thruster > 0 && Math.abs(inp.thruster) > 0.01 && this.engineOn) {
      _l.set(inp.thruster * d.thruster * contact, 0, 0);
      b.localDirToWorld(_l, _f);
      b.localToWorld(_a.set(0, this.probes[0].local.y + 0.3, this.bowZ * 0.9), _p);
      b.addForceAtPoint(_f, _p);
    }

    // ---------------------------------------------------------- hydrodynamics
    if (contact > 0) {
      // surge resistance with hump
      const R = this.cd * V * V * (1 + this.humpAmp * this.humpShape(V)) + this.linDrag * V;
      const rev = u < 0 ? 1.8 : 1;
      _l.set(0, 0, Math.sign(u) * R * rev * contact);
      // sway: quadratic + linear, reduced when planing (hull slides)
      const latArea = d.length * d.draft;
      const swayK = 0.5 * RHO_WATER * h.swayCd * latArea * lerp(1, 0.16, plane) * Math.max(wet, 0.25);
      _l.x = -(swayK * sway * Math.abs(sway) + mass * 0.9 * sway) * contact;
      _l.y = 0;
      b.localDirToWorld(_l, _f);
      b.localToWorld(this.clrLocal, _p);
      // lateral force acts below the CoM -> boat heels outward in turns
      b.addForceAtPoint(_f, _p);

      // yaw damping
      const wy = b.angVel.y;
      const yawK = h.yawDamp * mass * d.length * d.length * 0.075;
      b.torque.y -= (yawK * wy * Math.abs(wy) * 2 + yawK * wy * 0.6) * contact * Math.max(wet, 0.3);

      // planing lift (fraction of weight, needs water contact)
      if (plane > 0) {
        const lift = mass * G * h.liftFrac * plane * contact;
        _l.set(0, lift, 0);
        b.localDirToWorld(_l, _f);
        // centre of pressure moves aft as speed rises -> trim settles
        const cpZ = lerp(-d.length * 0.05, -d.length * 0.012, smoothstep(h.vHump, h.vTop, V));
        b.localToWorld(_a.set(0, -d.keelBelowCom, cpZ), _p);
        b.addForceAtPoint(_f, _p);
      }
      // hump bow-rise & planing trim moment (about body X)
      const bell = gauss((V - h.vHump) / (0.6 * h.vHump));
      const trimM = mass * G * d.length * (h.humpTrim * bell + h.planeTrim * plane) * Math.sign(u || 1) * contact;
      // planing surfaces are self-righting: dynamic lift recentres heel
      const rollRight = -tel.heel * mass * G * d.beam * 0.9 * plane * contact;
      _l.set(trimM, 0, rollRight);
      b.localDirToWorld(_l, _f);
      b.torque.add(_f);
    }
    // angular damping (roll / pitch), plus generic linear damping in air
    {
      b.worldDirToLocal(b.angVel, _w);
      const k = mass * d.length * 0.6 * (0.3 + 0.7 * contact);
      _l.set(-_w.x * k * 1.2, 0, -_w.z * k * 0.9 * h.stability);
      b.localDirToWorld(_l, _f);
      b.torque.add(_f);
    }

    // ---------------------------------------------------------- wind
    env.wind(_wind);
    _v.copy(_wind).sub(b.vel); _v.y = 0;
    b.worldDirToLocal(_v, _l);
    const kw = 0.5 * RHO_AIR * 1.1;
    _l.set(kw * d.windage.side * _l.x * Math.abs(_l.x), 0, kw * d.windage.front * _l.z * Math.abs(_l.z));
    b.localDirToWorld(_l, _f);
    b.localToWorld(this.windLocal, _p);
    b.addForceAtPoint(_f, _p);

    // ---------------------------------------------------------- anchor / lines
    if (this.anchor) {
      b.localToWorld(this.bowLocal, _p);
      const dx = this.anchor.x - _p.x, dz = this.anchor.z - _p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > this.anchor.rode) {
        const nx = dx / dist, nz = dz / dist;
        b.pointVelocity(_p, _v);
        const vr = -(_v.x * nx + _v.z * nz);
        const F = mass * (2.2 * (dist - this.anchor.rode) + 1.6 * Math.max(0, vr));
        _f.set(nx * F, 0, nz * F);
        b.addForceAtPoint(_f, _p);
      }
    }
    if (this.lines) {
      for (const ln of this.lines) {
        b.localToWorld(ln.local, _p);
        _a.copy(ln.anchor).sub(_p); _a.y = 0;
        const dist = _a.length();
        b.pointVelocity(_p, _v); _v.y = 0;
        const ext = Math.max(0, dist - ln.rest);
        if (dist > 1e-4) _a.multiplyScalar(1 / dist);
        _f.copy(_a).multiplyScalar(mass * 3.2 * ext).addScaledVector(_v, -mass * 1.6);
        b.addForceAtPoint(_f, _p);
      }
    }

    // ---------------------------------------------------------- grounding
    let grounded = 0, grind = 0, minClear = 99;
    for (let i = 0; i < this.contacts.length; i++) {
      b.localToWorld(this.contacts[i], _p);
      const th = env.terrainHeight(_p.x, _p.z);
      const pen = th - _p.y;
      minClear = Math.min(minClear, -pen);
      if (pen > 0) {
        b.pointVelocity(_p, _v);
        if (!this._contactWasDown[i]) {
          const hs = Math.hypot(_v.x, _v.z);
          this.emit('ground', hs, -_v.y, _p.x, _p.y, _p.z);
        }
        this._contactWasDown[i] = true;
        const N = Math.max(0, mass * (60 * pen) - mass * 5 * _v.y) / this.contacts.length * 2.2;
        _f.set(0, N, 0);
        const hs = Math.hypot(_v.x, _v.z);
        if (hs > 1e-3) {
          const mu = 0.55;
          const fr = Math.min(mu * N, mass * hs / dt / this.contacts.length);
          _f.x -= (_v.x / hs) * fr;
          _f.z -= (_v.z / hs) * fr;
        }
        b.addForceAtPoint(_f, _p);
        grounded++;
        grind += N * hs;
      } else this._contactWasDown[i] = false;
    }
    tel.grounded = grounded;
    tel.grind = grind / (mass * G);
    tel.depthUnderKeel = minClear;

    // ---------------------------------------------------------- integrate
    b.integrate(dt);

    // telemetry
    _a.copy(b.vel).sub(this._prevVel).multiplyScalar(1 / dt);
    this._prevVel.copy(b.vel);
    b.worldDirToLocal(_a, _l);
    tel.latAccel = lerp(tel.latAccel, _l.x, 0.05);
    tel.vertAccel = lerp(tel.vertAccel, _a.y, 0.2);
    tel.speed = Math.hypot(b.vel.x, b.vel.z);
    tel.speedKn = tel.speed / KNOT;
    tel.yawRate = b.angVel.y;
    // heel / trim
    _l.set(1, 0, 0); b.localDirToWorld(_l, _a);
    tel.heel = Math.asin(clamp(_a.y, -1, 1));
    _l.set(0, 0, -1); b.localDirToWorld(_l, _a);
    tel.trim = Math.asin(clamp(_a.y, -1, 1));

    // airborne tracking
    if (wetArea === 0) {
      if (!tel.airborne) { tel.airborne = true; this._airT = 0; this._airStart.copy(b.pos); }
      this._airT += dt;
      tel.airTime = this._airT;
    } else if (tel.airborne) {
      tel.airborne = false;
      const dist = Math.hypot(b.pos.x - this._airStart.x, b.pos.z - this._airStart.z);
      if (this._airT > 0.12) this.emit('landing', this._airT, dist, b.pos.x, b.pos.y, b.pos.z);
    }
  }
}
