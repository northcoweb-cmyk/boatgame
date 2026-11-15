// Force feedback manager — three layers that degrade gracefully:
//  1. WebHID direct torque (wheel motor) — speed-dependent hydraulic centring,
//     collision jolts, grounding grind, engine rumble, wave slams
//  2. Gamepad dual-rumble (when a vibrationActuator exists)
//  3. Perceived feedback (always on) — exposed as `shake`/`buzz` for the camera,
//     helm animation and audio
import { WebHidFFB } from './webhid-ffb.js';
import { clamp } from '../core/math.js';

export class FFB {
  constructor(settings) {
    this.settings = settings;
    this.hid = new WebHidFFB();
    this.impulse = 0;      // signed jolt
    this.impulseT = 0;
    this.grind = 0;
    this.slam = 0;
    this.shake = 0;        // camera shake amount (Layer 3)
    this.rumbleT = 0;
    this.status = 'off';
    this.hid.tryReconnect().then((ok) => { if (ok) this.status = 'webhid:' + this.hid.mode; });
  }

  get strength() { return clamp((this.settings.ffbStrength ?? 70) / 100, 0, 1); }

  async enable() {
    try {
      const name = await this.hid.request();
      this.status = this.hid.ready ? `webhid:${this.hid.mode}` : 'no-ffb-interface';
      return { ok: this.hid.ready, name, mode: this.hid.mode, error: this.hid.error ? String(this.hid.error.message || this.hid.error) : null };
    } catch (e) {
      this.status = 'off';
      return { ok: false, error: String(e.message || e) };
    }
  }

  collision(speed, sideSign) {
    const k = clamp(speed / 5, 0.15, 1);
    this.impulse = sideSign * k;
    this.impulseT = 0.25;
    this.shake = Math.max(this.shake, k * 1.2);
    this.rumble(0.35, k, k * 0.7);
  }
  slamHit(v) { this.slam = clamp(v / 4, 0, 1); this.shake = Math.max(this.shake, this.slam * 0.6); this.rumble(0.12, this.slam * 0.6, this.slam); }
  landing(v) { this.slamHit(v * 1.4); }

  rumble(dur, strong, weak) {
    const s = this.strength;
    if (s <= 0) return;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp || !gp.vibrationActuator) continue;
        const act = gp.vibrationActuator;
        if (typeof act.playEffect === 'function') act.playEffect('dual-rumble', { duration: dur * 1000, strongMagnitude: clamp(strong * s, 0, 1), weakMagnitude: clamp(weak * s, 0, 1) }).catch(() => {});
      }
    } catch (e) { /* rumble unsupported */ }
  }

  // per frame: compute the composite torque and push it to the active layers
  update(dt, ctx) {
    const s = this.strength;
    this.impulseT = Math.max(0, this.impulseT - dt);
    this.slam = Math.max(0, this.slam - dt * 6);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.grind = ctx.grind;
    let force = 0;
    if (ctx.atHelm) {
      // hydraulic steering: centring spring + damping grow with boat speed and rudder load
      const sp = clamp(ctx.speed / 14, 0, 1);
      const k = 0.08 + 0.55 * sp + 0.25 * Math.abs(ctx.rudderLoad);
      force -= ctx.wheelPos * k;
      force -= ctx.wheelVel * 0.04 * (0.3 + sp);
      // collision jolt opposite the impact
      if (this.impulseT > 0) force += this.impulse * (this.impulseT / 0.25) * 0.9;
      // grinding on sand: rough oscillation
      if (this.grind > 0.01) force += Math.sin(ctx.time * 61) * Math.sin(ctx.time * 23) * clamp(this.grind * 2, 0, 0.5);
      // engine rumble: small high-frequency texture
      force += Math.sin(ctx.time * 140) * 0.02 * ctx.rpmFrac + Math.sin(ctx.time * 90) * 0.015 * (ctx.engineOn ? 1 : 0);
      // wave slam knock
      force += Math.sin(ctx.time * 50) * this.slam * 0.4;
    }
    force = clamp(force * s, -1, 1);
    this.force = force;
    if (this.settings.invertFfb) force = -force;
    if (this.hid.ready) this.hid.setForce(force);
    // layer 2 continuous engine idle buzz
    this.rumbleT -= dt;
    if (ctx.atHelm && ctx.engineOn && this.rumbleT <= 0) {
      this.rumbleT = 0.12;
      const g = clamp(this.grind * 2, 0, 1);
      if (g > 0.02) this.rumble(0.14, g, g);
      else this.rumble(0.14, 0, 0.04 + ctx.rpmFrac * 0.08);
    }
  }
}
