// localStorage persistence: settings, wheel calibration, chosen boat, boat
// position + damage + fuel, time of day, logbook, unlocks, visited places.
const KEY = 'biscayneDrift.save.v2';

export const DEFAULT_SETTINGS = {
  preset: null, renderScale: 1, waterQuality: 'high', reflections: true, foliage: 1, drawDistance: 3500, aa: 'msaa', shadows: true, bloom: true,
  ffbStrength: 70, invertFfb: false, deadzone: 0.02, wheelLock: 900, wheelRange: 900, invertSteer: false, invertThrottle: false, invertBrake: false, invertClutch: false,
  wheelButtons: {},
  seaState: 'auto', dayMinutes: 20, timeOverride: null, units: 'knots', depthUnits: 'm',
  master: 0.9, engineVol: 0.85, ambienceVol: 0.8, musicVol: 0.35, sfxVol: 0.9, radioStation: 0,
  fov: 56, hud: true, mouseSensitivity: 1, invertLook: false,
};

export const DEFAULT_LOGBOOK = { nm: 0, topSpeedKn: 0, longestJumpM: 0, bestDock: 0, docks: 0, visited: [], dolphins: 0, sunsets: 0, hours: 0, collisions: 0, rescues: 0, guests: 0 };

export class Save {
  constructor() {
    this.data = this.load();
    this._t = 0;
  }
  defaults() {
    return {
      version: 2,
      settings: { ...DEFAULT_SETTINGS },
      wheelCalib: {},
      boat: 'isabel',
      boats: {},             // per boat: { paint, trim, integrity, fuel }
      player: null,          // { mode, x, z, heading, boat }
      timeOfDay: 16.9,
      logbook: { ...DEFAULT_LOGBOOK },
      unlocks: [],
      started: false,
    };
  }
  load() {
    const d = this.defaults();
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return d;
      const s = JSON.parse(raw);
      return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) }, logbook: { ...d.logbook, ...(s.logbook || {}) } };
    } catch (e) {
      return d;
    }
  }
  persist() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { /* storage blocked: game still runs */ }
  }
  tick(dt) { this._t += dt; if (this._t > 5) { this._t = 0; this.persist(); } }
  reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    this.data = this.defaults();
  }
  boatState(id) {
    if (!this.data.boats[id]) this.data.boats[id] = { paint: 'white', trim: 'none', integrity: 1, fuel: 1 };
    return this.data.boats[id];
  }
}
