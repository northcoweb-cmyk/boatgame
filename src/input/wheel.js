// Steering wheels (Logitech G920 & friends) through the Gamepad API.
// Wheels have no standard mapping in browsers, so this module:
//  * detects wheels by id ("Logitech", "G920", "G29", "Wheel", "Racing", 046d)
//  * auto-maps: steering = widest smoothly-varying axis (axes[0] default),
//    pedals = axes that REST at an extreme; normalised (rest - value)/travel,
//    ignored until their rest value has been observed (no self-pressing pedals)
//  * decodes hat switches reported on an axis with out-of-range values
//    (G920 D-pad resting at ~1.2857, steps of 2/7)
//  * applies calibration (wizard or manual), deadzone, wheel-lock degrees and
//    1-frame smoothing, and maps buttons by remappable index.
export const DEFAULT_WHEEL_BUTTONS = {
  engine: 0, anchor: 1, horn: 2, dock: 3, camNext: 4, camPrev: 5, map: 6, pause: 7, leaveHelm: 10,
};
export const WHEEL_ACTION_LABELS = {
  engine: 'Engine start / stop (A)', anchor: 'Anchor (B)', horn: 'Horn (X)', dock: 'Docking mode (Y)',
  camNext: 'Camera next (RB paddle)', camPrev: 'Camera prev (LB paddle)', map: 'Chart (Menu)', pause: 'Settings / pause (View)', leaveHelm: 'Leave helm (Xbox)',
};

export function isWheel(gp) {
  if (!gp) return false;
  const id = gp.id.toLowerCase();
  return /wheel|racing|g920|g923|g29|g27|driving force|046d.*c26|fanatec|thrustmaster|t300|t150|moza/.test(id) || (gp.mapping !== 'standard' && gp.axes.length >= 5 && /logitech/.test(id));
}

export class WheelInput {
  constructor(save) {
    this.save = save;
    this.calib = null;           // per-device calibration (persisted)
    this.rest = [];              // observed rest values per axis
    this.seen = [];              // axis has moved / been observed
    this.prevButtons = [];
    this.pressed = [];
    this.steer = 0; this.throttle = 0; this.brake = 0; this.clutch = 0;
    this.hat = { up: false, down: false, left: false, right: false };
    this.prevHat = { up: false, down: false, left: false, right: false };
    this.rawSteer = 0;
    this.active = false;
    this.id = null;
    this.index = -1;
  }

  attach(gp) {
    this.id = gp.id;
    this.index = gp.index;
    const all = this.save.data.wheelCalib || {};
    this.calib = all[gp.id] || null;
    this.rest = gp.axes.map((v) => v);
    this.seen = gp.axes.map(() => false);
    this.prevButtons = gp.buttons.map((b) => b.pressed);
  }

  get needsCalibration() { return !this.calib; }

  storeCalibration(c) {
    this.calib = c;
    const all = this.save.data.wheelCalib || {};
    all[this.id] = c;
    this.save.data.wheelCalib = all;
    this.save.persist();
  }

  // Auto mapping used until (and unless) the wizard has run.
  autoCalib(gp) {
    return {
      steer: { axis: 0, left: -1, right: 1, center: 0 },
      throttle: { axis: gp.axes.length > 2 ? 2 : 1, rest: 1, pressed: -1 },
      brake: { axis: gp.axes.length > 5 ? 5 : 1, rest: 1, pressed: -1 },
      clutch: { axis: gp.axes.length > 6 ? 1 : -1, rest: 1, pressed: -1 },
      hatAxis: gp.axes.length > 9 ? 9 : -1,
      buttons: { ...DEFAULT_WHEEL_BUTTONS },
      auto: true,
    };
  }

  // ------------------------------------------------------------ per frame
  poll(gp, settings, dt) {
    this.pressed.length = 0;
    if (!gp) return;
    const c = this.calib || this.autoCalib(gp);
    const ax = gp.axes;
    // observe rests: an axis counts once it has reported a stable value at an extreme
    for (let i = 0; i < ax.length; i++) {
      if (!this.seen[i] && (Math.abs(ax[i]) > 0.98 || Math.abs(ax[i] - this.rest[i]) > 0.05)) this.seen[i] = true;
    }
    // steering
    const s = c.steer;
    let v = ax[s.axis] ?? 0;
    const span = (s.right - s.left) / 2 || 1;
    let n = (v - (s.center ?? (s.left + s.right) / 2)) / span;
    const lockDeg = settings.wheelLock || 900, rangeDeg = settings.wheelRange || 900;
    n = n * (rangeDeg / Math.max(90, Math.min(lockDeg, rangeDeg)));
    n = Math.max(-1, Math.min(1, n));
    const dz = settings.deadzone ?? 0.02;
    n = Math.abs(n) < dz ? 0 : Math.sign(n) * (Math.abs(n) - dz) / (1 - dz);
    if (settings.invertSteer) n = -n;
    this.rawSteer = n;
    // one-frame smoothing only — the wheel must feel direct
    this.steer = this.steer * 0.35 + n * 0.65;
    // pedals
    const pedal = (p, inv) => {
      if (!p || p.axis < 0 || p.axis >= ax.length) return 0;
      if (!this.seen[p.axis] && c.auto) return 0;
      const travel = p.rest - p.pressed;
      let val = travel !== 0 ? (p.rest - ax[p.axis]) / travel : 0;
      if (inv) val = 1 - val;
      val = Math.max(0, Math.min(1, val));
      return val < 0.03 ? 0 : (val - 0.03) / 0.97;
    };
    this.throttle = pedal(c.throttle, settings.invertThrottle);
    this.brake = pedal(c.brake, settings.invertBrake);
    this.clutch = pedal(c.clutch, settings.invertClutch);
    // hat on an axis (values outside [-1, 1] mean neutral)
    this.prevHat = { ...this.hat };
    this.hat = { up: false, down: false, left: false, right: false };
    let hatAxis = c.hatAxis;
    if (hatAxis === -1 || hatAxis === undefined) for (let i = 0; i < ax.length; i++) if (Math.abs(ax[i]) > 1.05) hatAxis = i;
    if (hatAxis >= 0 && hatAxis < ax.length) {
      const hv = ax[hatAxis];
      if (Math.abs(hv) <= 1.01) {
        const idx = Math.round((hv + 1) * 3.5); // 0 up, 1 up-right, 2 right, ... 7 up-left
        this.hat.up = idx === 0 || idx === 1 || idx === 7;
        this.hat.right = idx >= 1 && idx <= 3;
        this.hat.down = idx >= 3 && idx <= 5;
        this.hat.left = idx >= 5 && idx <= 7;
      }
    }
    // d-pad as buttons 12..15 on some drivers
    if (gp.buttons.length > 15) {
      this.hat.up ||= gp.buttons[12].pressed; this.hat.down ||= gp.buttons[13].pressed;
      this.hat.left ||= gp.buttons[14].pressed; this.hat.right ||= gp.buttons[15].pressed;
    }
    for (const k of ['up', 'down', 'left', 'right']) if (this.hat[k] && !this.prevHat[k]) this.pressed.push('hat_' + k);
    // buttons
    const map = { ...DEFAULT_WHEEL_BUTTONS, ...(settings.wheelButtons || {}), ...(c.buttons || {}) };
    for (let i = 0; i < gp.buttons.length; i++) {
      const p = gp.buttons[i].pressed;
      if (p && !this.prevButtons[i]) {
        this.active = true;
        for (const [action, idx] of Object.entries(map)) if (idx === i) this.pressed.push(action);
        this.pressed.push('btn' + i);
      }
      this.prevButtons[i] = p;
    }
    this.buttonMap = map;
    this.buttonsHeld = gp.buttons.map((b) => b.pressed);
    if (Math.abs(this.rawSteer) > 0.05 || this.throttle > 0.05 || this.brake > 0.05) this.active = true;
    void dt;
  }
}

// ------------------------------------------------------------ calibration wizard logic
export class CalibrationSession {
  constructor(gp) {
    this.step = 0; // 0 center, 1 steer, 2 throttle, 3 brake, 4 clutch, 5 done
    this.rest = gp.axes.slice();
    this.min = gp.axes.slice();
    this.max = gp.axes.slice();
    this.t = 0;
    this.result = { steer: null, throttle: null, brake: null, clutch: { axis: -1, rest: 1, pressed: -1 }, hatAxis: -1, buttons: { ...DEFAULT_WHEEL_BUTTONS } };
    this.used = new Set();
  }
  hatCandidates(ax) { const out = []; ax.forEach((v, i) => { if (Math.abs(v) > 1.05) out.push(i); }); return out; }
  sample(gp, dt) {
    const ax = gp.axes;
    this.t += dt;
    for (let i = 0; i < ax.length; i++) { this.min[i] = Math.min(this.min[i], ax[i]); this.max[i] = Math.max(this.max[i], ax[i]); }
    const hats = this.hatCandidates(ax);
    if (hats.length) this.result.hatAxis = hats[0];
    if (this.step === 0) {
      this.rest = ax.slice();
      if (this.t > 1.2) this.next(ax);
    }
  }
  // progress 0..1 for the current step (used by the UI meters)
  progress(gp) {
    const ax = gp.axes;
    if (this.step === 1) {
      let best = 0;
      for (let i = 0; i < ax.length; i++) if (!this.isHat(i)) best = Math.max(best, (this.max[i] - this.min[i]) / 2);
      return Math.min(1, best / 0.9);
    }
    if (this.step >= 2 && this.step <= 4) {
      let best = 0;
      for (let i = 0; i < ax.length; i++) if (!this.used.has(i) && !this.isHat(i)) best = Math.max(best, Math.abs(ax[i] - this.rest[i]));
      return Math.min(1, best / 1.6);
    }
    return 0;
  }
  isHat(i) { return i === this.result.hatAxis || Math.abs(this.rest[i]) > 1.05; }
  next(ax) {
    if (this.step === 1) {
      let bi = 0, br = -1;
      for (let i = 0; i < ax.length; i++) { if (this.isHat(i)) continue; const r = this.max[i] - this.min[i]; if (r > br) { br = r; bi = i; } }
      this.result.steer = { axis: bi, left: this.min[bi], right: this.max[bi], center: this.rest[bi] };
      this.used.add(bi);
    } else if (this.step >= 2 && this.step <= 4) {
      let bi = -1, bd = 0.3;
      for (let i = 0; i < ax.length; i++) { if (this.used.has(i) || this.isHat(i)) continue; const d = Math.abs(ax[i] - this.rest[i]); if (d > bd) { bd = d; bi = i; } }
      const key = ['throttle', 'brake', 'clutch'][this.step - 2];
      if (bi >= 0) { this.result[key] = { axis: bi, rest: this.rest[bi], pressed: ax[bi] }; this.used.add(bi); }
      else if (key !== 'clutch') this.result[key] = { axis: -1, rest: 1, pressed: -1 };
    }
    this.step++;
    this.t = 0;
  }
  get done() { return this.step >= 5; }
}
